import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicYaml, exists, now, readYaml, taskId } from "./core";

export type InventoryKind = "fixture-directory" | "git-worktree" | "git-branch" | "process" | "port" | "herdr-workspace" | "github-preview";
export type InventoryEntry = { kind: InventoryKind; locator: string };
export type Parent = { project: string; task: string; pr?: string };
export type Declaration = {
  id: string;
  owner: string;
  purpose: string;
  parent: Parent;
  trigger: { merge?: boolean; close?: boolean; expiresAt?: string };
  inventory: InventoryEntry[];
  cleanupAssignee: string;
  authorizedScope: "local" | "git" | "herdr" | "github";
};
type Status = "pending" | "ready" | "cancelled" | "received" | "failed" | "timeout" | "retained";
type Record = {
  schema: "atdd-workflow/ephemeral-resource/v1";
  id: string;
  declaration: Declaration;
  cleanupTask: string;
  status: Status;
  updated_at: string;
};
type CleanupRecord = {
  schema: "atdd-workflow/cleanup-record/v1";
  id: string;
  parent: Parent;
  assignee: string;
  status: Status;
  updated_at: string;
};
type Audit = { schema: "atdd-workflow/ephemeral-resource-audit/v1"; event: string; immutable: true; at: string; detail?: string };

const resourceRoot = (root: string) => join(root, ".atdd-flow", "ephemeral-resources");
const resourceFile = (root: string, id: string) => join(resourceRoot(root), `${taskId(id)}.yaml`);
const cleanupFile = (root: string, id: string) => join(resourceRoot(root), "cleanup", `${taskId(id)}.yaml`);
const auditRoot = (root: string, id: string) => join(resourceRoot(root), "audit", taskId(id));
const tombstoneFile = (root: string, id: string) => join(resourceRoot(root), "tombstones", `${taskId(id)}.yaml`);

function required(value: unknown, name: string): asserts value {
  if (value === undefined || value === null || value === "" || Array.isArray(value) && !value.length) throw new Error(`Declaration requires ${name}.`);
}

function validate(value: Declaration) {
  required(value?.id, "id");
  taskId(value.id);
  required(value.owner, "owner");
  required(value.purpose, "purpose");
  required(value.parent, "authoritative parent");
  required(value.parent.project, "parent project");
  required(value.parent.task, "parent task");
  taskId(value.parent.task);
  required(value.trigger, "expiry or trigger");
  if (!value.trigger.merge && !value.trigger.close && !value.trigger.expiresAt) throw new Error("Declaration requires an expiry or trigger.");
  required(value.inventory, "exact inventory");
  required(value.cleanupAssignee, "cleanup assignee");
  required(value.authorizedScope, "authorized scope");
  if (!(["local", "git", "herdr", "github"] as string[]).includes(value.authorizedScope)) throw new Error("Declaration has an unsupported authorized scope.");
  for (const entry of value.inventory) {
    required(entry?.kind, "inventory kind");
    required(entry.locator, "inventory locator");
    if (!(["fixture-directory", "git-worktree", "git-branch", "process", "port", "herdr-workspace", "github-preview"] as string[]).includes(entry.kind)) {
      throw new Error(`Declaration has unsupported inventory kind: ${entry.kind}.`);
    }
  }
}

async function read(root: string, id: string) {
  return readYaml<Record>(resourceFile(root, id));
}

async function write(root: string, value: Record) {
  value.updated_at = now();
  await atomicYaml(resourceFile(root, value.id), value);
  await atomicYaml(cleanupFile(root, value.id), {
    schema: "atdd-workflow/cleanup-record/v1", id: value.cleanupTask, parent: value.declaration.parent,
    assignee: value.declaration.cleanupAssignee, status: value.status, updated_at: value.updated_at,
  } satisfies CleanupRecord);
}

/** Audit entries are write-once files; state records only point at that history. */
async function appendAudit(root: string, id: string, event: string, detail?: string) {
  const folder = auditRoot(root, id);
  await mkdir(folder, { recursive: true });
  const ordinal = (await readdir(folder)).filter((file) => file.endsWith(".yaml")).length + 1;
  await atomicYaml(join(folder, `${String(ordinal).padStart(4, "0")}-${event}.yaml`), {
    schema: "atdd-workflow/ephemeral-resource-audit/v1", event, immutable: true, at: now(), ...(detail ? { detail } : {}),
  } satisfies Audit);
}

export async function declare(root: string, declaration: Declaration) {
  validate(declaration);
  if (await exists(resourceFile(root, declaration.id))) throw new Error(`Ephemeral resource ${declaration.id} is already declared.`);
  const value: Record = {
    schema: "atdd-workflow/ephemeral-resource/v1", id: declaration.id, declaration,
    cleanupTask: `cleanup-${taskId(declaration.id)}`, status: "pending", updated_at: now(),
  };
  // Persist the resource and cleanup record before publishing the declaration audit.
  await write(root, value);
  await appendAudit(root, declaration.id, "declared");
  return { id: value.id, cleanupTask: value.cleanupTask, status: value.status as "pending" };
}

export async function signal(root: string, id: string, event: "merged" | "closed" | "expired" | "cancelled") {
  const value = await read(root, id);
  if (value.status === "received" || value.status === "retained") return { status: value.status };
  value.status = event === "cancelled" ? "cancelled" : "ready";
  await write(root, value);
  await appendAudit(root, id, event);
  return { status: value.status as "ready" | "cancelled" };
}

function refuse(entry: InventoryEntry) {
  const locator = entry.locator.toLowerCase();
  if (/cloud:|\biam\b|\bdeploy/.test(locator)) return "Cloud/IAM/deploy cleanup requires separate exact authorization";
  if (/\bdirty\b/.test(locator)) return "Refusing dirty resource cleanup";
  if (/\bunpushed\b/.test(locator)) return "Refusing unpushed resource cleanup";
  if (/\bunmerged\b/.test(locator)) return "Refusing unmerged resource cleanup";
  if (/\blive[-:]/.test(locator)) return "Refusing live resource cleanup";
  if (/other-session|out-of-scope/.test(locator)) return "Refusing out-of-scope resource cleanup";
}

/**
 * This seam never invokes OS, git, Herdr, or GitHub itself. The caller supplies
 * the already-authorized, declared local lifecycle action; this function only
 * records outcomes and refuses known unsafe targets. There is no daemon or GC.
 */
export async function execute(root: string, id: string, executor: (entry: InventoryEntry) => Promise<"removed" | "failed" | "timeout" | "cancelled">) {
  const value = await read(root, id);
  if (value.status === "received") return { status: "received" as const };
  if (value.status === "retained") throw new Error(`Cleanup ${id} is retained and cannot be executed.`);
  if (!(["ready", "cancelled"] as Status[]).includes(value.status)) throw new Error(`Cleanup ${id} is not ready for execution.`);
  for (const entry of value.declaration.inventory) {
    const reason = refuse(entry);
    if (reason) throw new Error(reason);
  }
  for (const entry of value.declaration.inventory) {
    const outcome = await executor(entry);
    if (outcome !== "removed") {
      value.status = outcome;
      await write(root, value);
      await appendAudit(root, id, `cleanup-${outcome}`, entry.locator);
      return { status: outcome };
    }
  }
  value.status = "received";
  await write(root, value);
  await appendAudit(root, id, "cleanup-received");
  return { status: "received" as const };
}

export async function receipt(root: string, id: string) {
  const value = await read(root, id);
  if (value.status !== "received") throw new Error(`Cleanup ${id} has no receipt; it is ${value.status}.`);
  return { status: "received" as const };
}

export async function retain(root: string, id: string, decision: { by: string; reason: string }) {
  required(decision?.by, "retained decision author");
  required(decision?.reason, "retained decision reason");
  const value = await read(root, id);
  if (value.status === "received") throw new Error(`Cleanup ${id} already has a receipt.`);
  value.status = "retained";
  await write(root, value);
  const tombstone = tombstoneFile(root, id);
  if (!await exists(tombstone)) await atomicYaml(tombstone, {
    schema: "atdd-workflow/ephemeral-resource-tombstone/v1", resource: id, immutable: true, retained_by: decision.by, reason: decision.reason, at: now(),
  });
  await appendAudit(root, id, "retained", `${decision.by}: ${decision.reason}`);
  return { status: "retained" as const, tombstone };
}

export async function audit(root: string, id: string) {
  const folder = auditRoot(root, id);
  try {
    return await Promise.all((await readdir(folder)).filter((file) => file.endsWith(".yaml")).sort().map((file) => readYaml<Audit>(join(folder, file))));
  } catch { return []; }
}

async function matching(root: string, parent: Parent) {
  try {
    const files = (await readdir(resourceRoot(root))).filter((file) => file.endsWith(".yaml"));
    const records = await Promise.all(files.map((file) => readYaml<Record>(join(resourceRoot(root), file))));
    return records.filter((value) => value.declaration.parent.project === parent.project && value.declaration.parent.task === parent.task);
  } catch { return []; }
}

async function assertSettled(root: string, parent: Parent) {
  const pending = (await matching(root, parent)).filter((value) => !(["received", "retained"] as Status[]).includes(value.status));
  if (pending.length) throw new Error(`Parent ${parent.project}/${parent.task} is held by cleanup receipt or retained decision: ${pending.map((value) => value.id).join(", ")}.`);
}

export const assertParentMayComplete = assertSettled;
export const assertDependentsMayUnblock = assertSettled;

export async function coordinatorStatus(root: string, project: string) {
  // Coordinator status is project-wide, while completion gates match one parent task.
  let all: Record[] = [];
  try {
    all = await Promise.all((await readdir(resourceRoot(root))).filter((file) => file.endsWith(".yaml")).map((file) => readYaml<Record>(join(resourceRoot(root), file))));
  } catch { /* no declarations is a clean status */ }
  return { pending: all.filter((value) => value.declaration.parent.project === project && !(["received", "retained"] as Status[]).includes(value.status)).map((value) => value.id).sort() };
}

export async function checklist(root: string, parent: Parent) {
  const records = await matching(root, parent);
  const pending = records.filter((value) => !(["received", "retained"] as Status[]).includes(value.status));
  return pending.length
    ? `Cleanup pending for ${parent.project}/${parent.task}: obtain cleanup receipt or retained-resource decision for ${pending.map((value) => value.id).join(", ")}.`
    : `Cleanup checklist for ${parent.project}/${parent.task}: every declared resource has a cleanup receipt or retained-resource decision.`;
}
