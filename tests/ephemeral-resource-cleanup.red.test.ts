import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * RED contract for the fail-closed ephemeral-resource lifecycle. Every fixture
 * is rooted below mkdtemp; `liveDesk` is a separate sentinel that must remain
 * byte-for-byte unchanged. These tests intentionally name the public seam
 * before its implementation exists.
 */
type Declaration = {
  id: string;
  owner: string;
  purpose: string;
  parent: { project: string; task: string; pr?: string };
  trigger: { merge?: boolean; close?: boolean; expiresAt?: string };
  inventory: Array<{ kind: "fixture-directory" | "git-worktree" | "git-branch" | "process" | "port" | "herdr-workspace" | "github-preview"; locator: string }>;
  cleanupAssignee: string;
  authorizedScope: "local" | "git" | "herdr" | "github";
};

type Lifecycle = {
  declare(root: string, declaration: Declaration): Promise<{ id: string; cleanupTask: string; status: "pending" }>;
  signal(root: string, id: string, event: "merged" | "closed" | "expired" | "cancelled"): Promise<{ status: "ready" | "cancelled" }>;
  execute(root: string, id: string, executor: (entry: Declaration["inventory"][number]) => Promise<"removed" | "failed" | "timeout" | "cancelled">): Promise<{ status: "received" | "failed" | "timeout" | "cancelled" }>;
  receipt(root: string, id: string): Promise<{ status: "received" }>;
  retain(root: string, id: string, decision: { by: string; reason: string }): Promise<{ status: "retained"; tombstone: string }>;
  assertParentMayComplete(root: string, parent: Declaration["parent"]): Promise<void>;
  assertDependentsMayUnblock(root: string, parent: Declaration["parent"]): Promise<void>;
  audit(root: string, id: string): Promise<Array<{ event: string; immutable: true }>>;
  coordinatorStatus(root: string, project: string): Promise<{ pending: string[] }>;
  checklist(root: string, parent: Declaration["parent"]): Promise<string>;
};

type Fixture = {
  root: string;
  desk: string;
  liveDesk: string;
  declaration: Declaration;
  liveBefore: string;
  dispose(): Promise<void>;
};

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-ephemeral-red-"));
  roots.push(root);
  const desk = join(root, "isolated-desk");
  const liveDesk = join(root, "live-desk-sentinel");
  await Promise.all([mkdir(desk, { recursive: true }), mkdir(liveDesk, { recursive: true })]);
  await writeFile(join(desk, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: isolated\napplication: herdr\n");
  await writeFile(join(liveDesk, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: live-sentinel\napplication: herdr\n");
  await writeFile(join(liveDesk, "must-not-change.txt"), "live Desk sentinel\n");
  const liveBefore = await readFile(join(liveDesk, "must-not-change.txt"), "utf8");
  return {
    root, desk, liveDesk, liveBefore,
    declaration: {
      id: "fixture-cleanup",
      owner: "driver.fixture@demo",
      purpose: "bounded RED-only local fixture",
      parent: { project: "demo", task: "parent", pr: "https://example.test/demo/pull/1" },
      trigger: { merge: true, close: true, expiresAt: "2030-01-01T00:00:00.000Z" },
      inventory: [
        { kind: "fixture-directory", locator: join(root, "fixture") },
        { kind: "git-worktree", locator: join(root, "worktree") },
        { kind: "git-branch", locator: "delivery/fixture-cleanup" },
        { kind: "process", locator: "pid:synthetic" },
        { kind: "port", locator: "127.0.0.1:0" },
        { kind: "herdr-workspace", locator: "fake-session/fake-workspace" },
        { kind: "github-preview", locator: "https://example.test/preview/fixture-cleanup" },
      ],
      cleanupAssignee: "driver.fixture@demo",
      authorizedScope: "local",
    },
    dispose: async () => { await rm(root, { recursive: true, force: true }); },
  };
}

async function lifecycle(): Promise<Lifecycle> {
  // This intentionally fails RED until the production seam is implemented.
  return await import("../src/ephemeral-resources") as Lifecycle;
}

async function expectLiveDeskUntouched(value: Fixture) {
  expect(await readFile(join(value.liveDesk, "must-not-change.txt"), "utf8")).toBe(value.liveBefore);
}

async function invoke(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { output: `${stdout}${stderr}`, exitCode };
}

test("RED: a complete declaration is isolated from the live Desk and atomically links pending cleanup", async () => {
  const value = await fixture();
  try {
    const record = await (await lifecycle()).declare(value.desk, value.declaration);
    expect(record).toEqual({ id: value.declaration.id, cleanupTask: expect.any(String), status: "pending" });
    await expectLiveDeskUntouched(value);
  } finally { await value.dispose(); }
});

test("RED: declaration refuses missing inventory/owner/parent/trigger/assignee/scope rather than registering a synthetic active resource", async () => {
  const value = await fixture();
  try {
    const api = await lifecycle();
    for (const field of ["owner", "purpose", "parent", "trigger", "inventory", "cleanupAssignee", "authorizedScope"] as const) {
      const incomplete = { ...value.declaration, [field]: field === "inventory" ? [] : undefined } as Declaration;
      await expect(api.declare(value.desk, incomplete)).rejects.toThrow(/required|declaration|authorization/i);
    }
    expect(await api.coordinatorStatus(value.desk, "demo")).toEqual({ pending: [] });
    await expectLiveDeskUntouched(value);
  } finally { await value.dispose(); }
});

test("RED: merge, close, and expiry make declared cleanup ready without a daemon or GC", async () => {
  const value = await fixture();
  try {
    const api = await lifecycle();
    for (const event of ["merged", "closed", "expired"] as const) {
      await api.declare(value.desk, { ...value.declaration, id: `fixture-${event}` });
      await expect(api.signal(value.desk, `fixture-${event}`, event)).resolves.toMatchObject({ status: "ready" });
    }
    await expectLiveDeskUntouched(value);
  } finally { await value.dispose(); }
});

test("RED: a successful cleanup produces a receipt and removes every declared synthetic item", async () => {
  const value = await fixture();
  try {
    const api = await lifecycle();
    await api.declare(value.desk, value.declaration);
    await api.signal(value.desk, value.declaration.id, "merged");
    await expect(api.execute(value.desk, value.declaration.id, async () => "removed")).resolves.toEqual({ status: "received" });
    await expect(api.receipt(value.desk, value.declaration.id)).resolves.toEqual({ status: "received" });
    await expectLiveDeskUntouched(value);
  } finally { await value.dispose(); }
});

test("RED: failure, timeout, and cancellation retain the declaration and block receipt", async () => {
  const value = await fixture();
  try {
    const api = await lifecycle();
    for (const result of ["failed", "timeout", "cancelled"] as const) {
      const id = `fixture-${result}`;
      await api.declare(value.desk, { ...value.declaration, id });
      await api.signal(value.desk, id, "cancelled");
      await expect(api.execute(value.desk, id, async () => result)).resolves.toEqual({ status: result });
      await expect(api.receipt(value.desk, id)).rejects.toThrow(/receipt|cleanup|pending/i);
    }
    await expectLiveDeskUntouched(value);
  } finally { await value.dispose(); }
});

test("RED: parent completion and dependent unblock are held until receipt or explicit retained-resource decision", async () => {
  const value = await fixture();
  try {
    const api = await lifecycle();
    await api.declare(value.desk, value.declaration);
    await expect(api.assertParentMayComplete(value.desk, value.declaration.parent)).rejects.toThrow(/cleanup|receipt|retain/i);
    await expect(api.assertDependentsMayUnblock(value.desk, value.declaration.parent)).rejects.toThrow(/cleanup|receipt|retain/i);
    await api.retain(value.desk, value.declaration.id, { by: "coordinator@demo", reason: "authorized retained fixture" });
    await expect(api.assertParentMayComplete(value.desk, value.declaration.parent)).resolves.toBeUndefined();
    await expect(api.assertDependentsMayUnblock(value.desk, value.declaration.parent)).resolves.toBeUndefined();
    await expectLiveDeskUntouched(value);
  } finally { await value.dispose(); }
});

test("RED: dirty, unpushed, unmerged, live, out-of-scope, and Cloud inventory are refused without force deletion", async () => {
  const value = await fixture();
  try {
    const api = await lifecycle();
    for (const [id, inventory, scope] of [
      ["dirty", [{ kind: "git-worktree", locator: "dirty" }], "git"],
      ["unpushed", [{ kind: "git-branch", locator: "unpushed" }], "git"],
      ["unmerged", [{ kind: "git-branch", locator: "unmerged" }], "git"],
      ["live", [{ kind: "process", locator: "live-pid" }], "local"],
      ["out-of-scope", [{ kind: "herdr-workspace", locator: "other-session/workspace" }], "local"],
      ["cloud", [{ kind: "github-preview", locator: "cloud://unapproved" }], "github"],
    ] as const) {
      await api.declare(value.desk, { ...value.declaration, id, inventory: inventory as Declaration["inventory"], authorizedScope: scope });
      await api.signal(value.desk, id, "merged");
      await expect(api.execute(value.desk, id, async () => "removed")).rejects.toThrow(/dirty|unpushed|unmerged|live|scope|authorization|cloud/i);
    }
    await expectLiveDeskUntouched(value);
  } finally { await value.dispose(); }
});

test("RED: a retained decision creates immutable audit/tombstone evidence", async () => {
  const value = await fixture();
  try {
    const api = await lifecycle();
    await api.declare(value.desk, value.declaration);
    const retained = await api.retain(value.desk, value.declaration.id, { by: "coordinator@demo", reason: "owner accepted retention" });
    expect(retained).toEqual({ status: "retained", tombstone: expect.any(String) });
    expect(await api.audit(value.desk, value.declaration.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "declared", immutable: true }),
      expect.objectContaining({ event: "retained", immutable: true }),
    ]));
    await expectLiveDeskUntouched(value);
  } finally { await value.dispose(); }
});

test("RED: retry is idempotent and leaves no stale synthetic active registration after receipt", async () => {
  const value = await fixture();
  try {
    const api = await lifecycle();
    await api.declare(value.desk, value.declaration);
    await api.signal(value.desk, value.declaration.id, "expired");
    const remove = async () => "removed" as const;
    await api.execute(value.desk, value.declaration.id, remove);
    await expect(api.execute(value.desk, value.declaration.id, remove)).resolves.toEqual({ status: "received" });
    expect((await api.coordinatorStatus(value.desk, "demo")).pending).not.toContain(value.declaration.id);
    await expectLiveDeskUntouched(value);
  } finally { await value.dispose(); }
});

test("RED: coordinator status and checklist commands exist while legacy reads remain available", async () => {
  const value = await fixture();
  try {
    const api = await lifecycle();
    await api.declare(value.desk, value.declaration);
    expect(await api.coordinatorStatus(value.desk, "demo")).toEqual({ pending: [value.declaration.id] });
    await expect(api.checklist(value.desk, value.declaration.parent)).resolves.toMatch(/cleanup.*receipt|retained/i);
    const command = await invoke(value.desk, "cleanup", "checklist", "demo", "parent");
    expect(command.exitCode, command.output).toBe(0);
    await expectLiveDeskUntouched(value);
  } finally { await value.dispose(); }
});
