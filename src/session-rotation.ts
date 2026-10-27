// URN: component:flow:e013:session-rotation:backend:application
// Tested-By:
// - test:flow:session-rotation:E013-UNIT-001
// Runtime: bun
// Purpose: Replace released Pi sessions without changing Desk work authority.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Seat, desk, modelPortfolio, paths, readYaml, seat } from "./core";
import { type Handover, handoverProblems } from "./handover";
import { readRuntimeState, withOwnedRuntimeState, isRuntimeStateStale } from "./runtime-state";
import { launchPiRuntime } from "./seats";

type Reason = "context" | "rate_limit";
type Intent = {
  schema: "atdd-flow/session-rotation/v1";
  seat: string; reason: Reason; source_session: string;
  source_receipt: string; source_handover?: { id: string; sha256: string };
  candidate: string; created_at: string;
};
export type RotationReport = { seat: string; outcome: "launched" | "ready" | "running" | "stale" | "refused"; detail?: string };
export type RotationDependencies = {
  dryRun?: boolean;
  launch?: typeof launchPiRuntime;
};
const directory = (root: string) => join(root, ".atdd-flow", "session-rotations");
const fileFor = (root: string, address: string, session: string) =>
  join(directory(root), `${encodeURIComponent(address)}--${encodeURIComponent(session)}.yaml`);

async function originalCandidate(runtime: NonNullable<Seat["runtime"]>, address: string) {
  if (!runtime.launch_receipt) return;
  const receipt = await readYaml<{ seat: string; pi_session: string; candidate: string }>(runtime.launch_receipt);
  if (receipt.seat !== address || receipt.pi_session !== runtime.pi_session || !receipt.candidate) return;
  return receipt.candidate;
}

async function freshHandover(root: string, address: string, session: string, after: Date) {
  const record = await readYaml<Handover>(paths(root).handoverFile(address)).catch(() => undefined);
  if (!record || record.seat !== address || record.schema !== "atdd-workflow/handover/v1") return;
  if (Date.parse(record.recorded_at) < after.getTime() || !record.text.split(/\r?\n/)[1]?.includes(`pi session ${session}`)) return;
  if (handoverProblems(record.text, address, record.supersedes === "none" ? undefined : record.supersedes).length) return;
  return { id: record.handover_id, sha256: createHash("sha256").update(record.text).digest("hex") };
}

/** Called from the bound Pi process after a settled run. A main seat uses Path-A instead. */
export async function requestSessionRotation(root: string, address: string, token: string, reason: Reason,
  observedAt: Date = new Date()): Promise<boolean> {
  const record = await seat(root, address), runtime = record.runtime, locator = runtime?.addresses.herdr;
  if (!["driver", "coordinator"].includes(record.role) || runtime?.application !== "herdr"
    || !locator || typeof locator === "string" || !runtime.pi_session || !runtime.launch_receipt) return false;
  const original = await originalCandidate(runtime, address);
  if (!original) return false;
  const handover = reason === "context" ? await freshHandover(root, address, runtime.pi_session, observedAt) : undefined;
  if (reason === "context" && !handover) return false;
  const config = await desk(root);
  const candidate = reason === "rate_limit" ? config.fallback_model?.[record.role] : original;
  if (!candidate || (reason === "rate_limit" && candidate === original)) return false;
  const portfolio = await modelPortfolio(root);
  if (!portfolio?.models.some((model) => model.id === candidate && model.enabled !== false)) return false;
  const intent: Intent = {
    schema: "atdd-flow/session-rotation/v1", seat: address, reason, source_session: runtime.pi_session,
    source_receipt: runtime.launch_receipt, ...(handover ? { source_handover: handover } : {}),
    candidate, created_at: new Date().toISOString(),
  };
  const owned = await withOwnedRuntimeState(root, address, token, async () => {
    const path = fileFor(root, address, runtime.pi_session!);
    await mkdir(directory(root), { recursive: true });
    try { await writeFile(path, Bun.YAML.stringify(intent), { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return true;
  });
  return owned.owned;
}

async function validSource(root: string, intent: Intent) {
  const record = await seat(root, intent.seat);
  const runtime = record.runtime;
  if (!runtime || runtime.pi_session !== intent.source_session || runtime.launch_receipt !== intent.source_receipt) return;
  if (!["driver", "coordinator"].includes(record.role)) return;
  if (await originalCandidate(runtime, intent.seat) === undefined) return;
  if (intent.reason === "context") {
    const original = await readYaml<Handover>(paths(root).handoverFile(intent.seat)).catch(() => undefined);
    if (!original || intent.source_handover?.id !== original.handover_id
      || intent.source_handover.sha256 !== createHash("sha256").update(original.text).digest("hex")) return;
  }
  return record;
}

/** Reuse the existing launch guard and receipt path; never use Jev for a preselected candidate. */
async function reconcileIntent(root: string, path: string, intent: Intent, options: RotationDependencies): Promise<RotationReport> {
  const status = (outcome: RotationReport["outcome"], detail?: string): RotationReport =>
    ({ seat: intent.seat, outcome, ...(detail ? { detail } : {}) });
  if (intent.schema !== "atdd-flow/session-rotation/v1") return status("refused", "Invalid rotation record");
  const record = await validSource(root, intent);
  if (!record) return status("stale");
  const live = await readRuntimeState(root, intent.seat);
  if (live && live.pi_session === intent.source_session && !isRuntimeStateStale(live, 60_000)) return status("running");
  if (options.dryRun) return status("ready");
  const locator = record.runtime?.addresses.herdr;
  if (!locator || typeof locator === "string") return status("refused", "Missing exact Herdr locator");
  try {
    await (options.launch ?? launchPiRuntime)(root, intent.seat, ["--herdr-session", locator.session, "--pane", locator.pane], {
      select: async ({ candidates }) => candidates.some((entry) => entry.id === intent.candidate)
        ? { available: true, selected_model: intent.candidate, confidence: 1 }
        : { available: false, reason: "Rotation candidate is not available." },
    });
    await rm(path);
    return status("launched");
  } catch (error) {
    // The immutable source and vacant-pane launch guards remain authoritative.
    return status("refused", error instanceof Error ? error.message : String(error));
  }
}

/** One-shot pass for an existing scheduler: no daemon, second inbox, or new owner. */
export async function reconcileRotations(root: string, options: RotationDependencies = {}): Promise<RotationReport[]> {
  const files = await readdir(directory(root)).catch(() => [] as string[]);
  const results: RotationReport[] = [];
  for (const file of files.filter((entry) => entry.endsWith(".yaml")).sort()) {
    const path = join(directory(root), file);
    const intent = Bun.YAML.parse(await readFile(path, "utf8")) as Intent;
    results.push(await reconcileIntent(root, path, intent, options));
  }
  return results;
}
