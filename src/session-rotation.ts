// URN: component:flow:e014:session-rotation:backend:application
// Tested-By:
// - test:flow:session-rotation:E014-UNIT-001
// Runtime: bun
// Purpose: Replace released Pi sessions without changing Desk work authority.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Seat, desk, modelPortfolio, paths, readYaml, seat } from "./core";
import { type Handover, handoverProblems } from "./handover";
import { readRuntimeState, withOwnedRuntimeState, isRuntimeStateStale } from "./runtime-state";
import { launchPiRuntime } from "./seats";
import { availableModelCandidates } from "./pi-runtime-launch";

type Reason = "context" | "rate_limit";
type Intent = {
  schema: "atdd-flow/session-rotation/v1";
  seat: string; reason: Reason; source_session: string;
  source_receipt: string; source_handover?: { id: string; sha256: string };
  candidate: string; created_at: string;
};
type Source = { record: Seat; runtime: NonNullable<Seat["runtime"]>; session: string; receipt: string };
export type RotationReport = { seat: string; outcome: "launched" | "ready" | "running" | "stale" | "refused"; detail?: string };
export type RotationDependencies = { dryRun?: boolean; launch?: typeof launchPiRuntime };
const directory = (root: string) => join(root, ".atdd-flow", "session-rotations");
const fileFor = (root: string, address: string, session: string) =>
  join(directory(root), `${encodeURIComponent(address)}--${encodeURIComponent(session)}.yaml`);
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

/** A source is an already-authoritative Flow seat, never a host-discovered pane.
 * Main has its own Path-A owner authorization, which this path must not bypass.
 */
function sourceOf(record: Seat): Source | undefined {
  const runtime = record.runtime, locator = runtime?.addresses.herdr;
  if (record.role !== "driver" && record.role !== "coordinator") return;
  if (runtime?.application !== "herdr" || !locator || typeof locator === "string") return;
  if (!runtime.pi_session || !runtime.launch_receipt) return;
  return { record, runtime, session: runtime.pi_session, receipt: runtime.launch_receipt };
}

/** The previous launch receipt pins the already-judged candidate.
 * Corrupt or missing receipts are not a reason to ask Jev for a new decision.
 */
async function originalCandidate(source: Source) {
  const receipt = await readYaml<{ seat: string; pi_session: string; candidate: string }>(source.receipt).catch(() => undefined);
  if (!receipt || receipt.seat !== source.record.address || receipt.pi_session !== source.session) return;
  return receipt.candidate || undefined;
}

/** Validation at handoff time, not just at the later restart.
 * The source Pi session must appear literally in the handover's Runtime line.
 */
async function freshHandover(root: string, address: string, session: string, after: Date) {
  const record = await readYaml<Handover>(paths(root).handoverFile(address)).catch(() => undefined);
  if (!record || record.seat !== address || record.schema !== "atdd-workflow/handover/v1") return;
  if (Date.parse(record.recorded_at) < after.getTime()) return;
  if (!record.text.split(/\r?\n/)[1]?.includes(`pi session ${session}`)) return;
  if (handoverProblems(record.text, address, record.supersedes === "none" ? undefined : record.supersedes).length) return;
  return { id: record.handover_id, sha256: digest(record.text) };
}

/** Context rotation keeps the previous model. Quota recovery first uses
 * the configured fallback ONLY to write the handover, then picks a different
 * execution candidate from the existing ordered models.yaml portfolio.
 */
async function pinnedCandidate(root: string, source: Source, reason: Reason) {
  const original = await originalCandidate(source);
  if (!original) return;
  const config = await desk(root);
  const portfolio = await modelPortfolio(root);
  if (!portfolio) return;
  const candidates = availableModelCandidates(config, portfolio);
  if (reason === "context") return candidates.some((entry) => entry.id === original) ? original : undefined;
  const fallback = config.fallback_model?.[source.record.role];
  if (!fallback || fallback === original) return;
  if (!candidates.some((entry) => entry.id === fallback)) return;
  return candidates.find((entry) => entry.id !== original && entry.id !== fallback)?.id;
}

/** The request is create-only, fenced by the original process owner token.
 * A second request for the same session can reuse only the identical intent.
 */
async function persistRequest(root: string, source: Source, token: string, intent: Intent) {
  const path = fileFor(root, source.record.address, source.session);
  const owned = await withOwnedRuntimeState(root, source.record.address, token, async () => {
    await mkdir(directory(root), { recursive: true });
    try { await writeFile(path, Bun.YAML.stringify(intent), { flag: "wx" }); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = Bun.YAML.parse(await readFile(path, "utf8")) as Intent;
      return prior.source_session === intent.source_session && prior.reason === intent.reason
        && prior.candidate === intent.candidate && prior.source_handover?.sha256 === intent.source_handover?.sha256;
    }
  });
  return owned.owned && owned.value === true;
}

/** Called from a settled Pi run. A main seat uses Path-A instead. */
export async function requestSessionRotation(root: string, address: string, token: string, reason: Reason,
  observedAt: Date = new Date()): Promise<boolean> {
  const source = sourceOf(await seat(root, address));
  if (!source) return false;
  const candidate = await pinnedCandidate(root, source, reason);
  if (!candidate) return false;
  const handover = await freshHandover(root, address, source.session, observedAt);
  if (!handover) return false;
  const intent: Intent = {
    schema: "atdd-flow/session-rotation/v1", seat: address, reason, source_session: source.session,
    source_receipt: source.receipt, ...(handover ? { source_handover: handover } : {}),
    candidate, created_at: new Date().toISOString(),
  };
  return persistRequest(root, source, token, intent);
}

/** A replacement may not rely on a stale or forged handover ID/hash. */
async function handoverMatches(root: string, intent: Intent) {
  const original = await readYaml<Handover>(paths(root).handoverFile(intent.seat)).catch(() => undefined);
  const proof = intent.source_handover;
  return Boolean(original && proof && proof.id === original.handover_id && proof.sha256 === digest(original.text));
}

/** Compare the stored intent against current Desk policy at launch time.
 * The model portfolio or role fallback may have changed while Pi was stopped.
 */
async function validSource(root: string, intent: Intent): Promise<Source | undefined> {
  const source = sourceOf(await seat(root, intent.seat));
  if (!source || source.session !== intent.source_session || source.receipt !== intent.source_receipt) return;
  const pinned = await pinnedCandidate(root, source, intent.reason);
  if (!pinned || pinned !== intent.candidate) return;
  if (!await handoverMatches(root, intent)) return;
  return source;
}

/** A preselected candidate reuses the existing launcher, which verifies
 * vacancy, exact seat placement, session receipt and single-writer ownership.
 */
async function launchFromIntent(root: string, path: string, intent: Intent, source: Source,
  options: RotationDependencies): Promise<RotationReport> {
  const locator = source.runtime.addresses.herdr;
  if (!locator || typeof locator === "string") return { seat: intent.seat, outcome: "refused", detail: "Missing Herdr locator" };
  try {
    await (options.launch ?? launchPiRuntime)(root, intent.seat, ["--herdr-session", locator.session, "--pane", locator.pane], {
      select: async ({ candidates }) => candidates.some((entry) => entry.id === intent.candidate)
        ? { available: true, selected_model: intent.candidate, confidence: 1 }
        : { available: false, reason: "Pinned candidate unavailable" },
    });
    await rm(path);
    return { seat: intent.seat, outcome: "launched" };
  } catch (error) {
    return { seat: intent.seat, outcome: "refused", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function reconcileIntent(root: string, path: string, intent: Intent, options: RotationDependencies): Promise<RotationReport> {
  const status = (outcome: RotationReport["outcome"]): RotationReport => ({ seat: intent.seat, outcome });
  if (intent.schema !== "atdd-flow/session-rotation/v1") return status("refused");
  const source = await validSource(root, intent);
  if (!source) return status("stale");
  const live = await readRuntimeState(root, intent.seat);
  if (live && live.pi_session === intent.source_session && !isRuntimeStateStale(live, 60_000)) return status("running");
  if (options.dryRun) return status("ready");
  return launchFromIntent(root, path, intent, source, options);
}

/** One-shot pass for the existing scheduler. No daemon or duplicate inbox.
 * Existing main-seat Path-A and task/Desk authority remain unchanged.
 */
export async function reconcileRotations(root: string, options: RotationDependencies = {}): Promise<RotationReport[]> {
  const files = await readdir(directory(root)).catch(() => [] as string[]);
  const results: RotationReport[] = [];
  for (const file of files.filter((entry) => entry.endsWith(".yaml")).sort()) {
    const path = join(directory(root), file);
    try {
      const intent = Bun.YAML.parse(await readFile(path, "utf8")) as Intent;
      results.push(await reconcileIntent(root, path, intent, options));
    } catch (error) {
      // One incomplete or malformed advisory record must not strand another seat.
      results.push({ seat: file, outcome: "refused", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
