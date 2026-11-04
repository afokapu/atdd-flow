// URN: component:flow:e038:compaction-session:backend:application
// Tested-By:
// - test:flow:same-session-compaction-wiring
// Runtime: bun
// Purpose: Drive same-session compaction across Pi events; fail closed to Path-A

import { contextHandoverThreshold } from "./handover";
import { compactionFallbackInstruction, compactionThresholdInstruction } from "./collaboration-policy";
import {
  type CompactionDraft, type Fallback, type Identity, type LiveIdentity, adoptRecordedHandover, buildCompactionDraft, compactionDecision,
  compareIdentity, createCompactionGate, snapshotIdentity, verifyCompaction,
} from "./compaction-handover";

/** One message for the seat: the primary same-session prompt or the typed fail-closed fallback. */
export type Directive = { path: "compaction" | "fallback"; content: string; details: Record<string, unknown> };
export type Boundary = { entries: [CompactionDraft]; continue: true };
/** The prompt was sent (`prompted`) or the draft was handed to Pi (`drafted`); identity is the snapshot taken at the prompt. */
type Pending = { stage: "prompted" | "drafted"; since: string; percent: number; identity: Identity; handover_id?: string };
type SessionOptions = {
  root: string;
  seat: string;
  environment: NodeJS.ProcessEnv;
  /** Advisory recovery bundle text; failures degrade to no bundle. */
  recovery: () => Promise<string | undefined>;
  clock?: () => string;
};
type CompactEvent = { compactionEntry: { id: string; firstKeptEntryId: string | null; summary: string } };
type FailedEvent = { errorMessage?: string; aborted?: boolean };
/** Mutable per-extension state shared by the step functions below. */
type Machine = { options: SessionOptions; gate: ReturnType<typeof createCompactionGate>; pending?: Pending };

/** The live Pi/Herdr tuple Flow's launcher exported into this process; absent means the primary path is unavailable. */
function liveIdentity(environment: NodeJS.ProcessEnv): LiveIdentity | undefined {
  const { ATDD_FLOW_PI_SESSION: pi_session, ATDD_FLOW_HERDR_SESSION: herdr_session, ATDD_FLOW_HERDR_PANE: pane } = environment;
  return pi_session && herdr_session && pane ? { pi_session, herdr_session, pane } : undefined;
}

const bundleOf = (machine: Machine) => machine.options.recovery().catch(() => undefined);

/** Clears any pending compaction and returns the typed Path-A fallback directive for `failure`. */
async function fallbackDirective(machine: Machine, failure: Pick<Fallback, "reason" | "detail">, percent?: number): Promise<Directive> {
  machine.pending = undefined;
  const content = compactionFallbackInstruction(failure.reason, failure.detail, await bundleOf(machine));
  return { path: "fallback", content, details: { seat: machine.options.seat, authority: "handover", path: "fallback", reason: failure.reason, ...(percent === undefined ? {} : { percent }) } };
}

/** An unexpected error never leaves the seat without a path: it becomes the typed fallback. */
async function guarded<T>(machine: Machine, work: () => Promise<T>): Promise<T | Directive> {
  try { return await work(); } catch (error) { return fallbackDirective(machine, { reason: "compaction-failed", detail: (error as Error).message }); }
}

/** In the window: snapshot identity, remember the prompt time, and ask the seat to record its handover. */
async function promptForCompaction(machine: Machine, percent: number, threshold: number): Promise<Directive> {
  const { root, seat, environment, clock } = machine.options;
  const identity = liveIdentity(environment);
  if (!identity) return fallbackDirective(machine, { reason: "identity-unavailable", detail: "the live Pi session, Herdr session and pane are not all known" }, percent);
  machine.pending = { stage: "prompted", since: (clock ?? (() => new Date().toISOString()))(), percent, identity: await snapshotIdentity(root, seat, identity) };
  const content = compactionThresholdInstruction(seat, percent, threshold, await bundleOf(machine));
  return { path: "compaction", content, details: { seat, threshold, percent, authority: "handover", path: "compaction" } };
}

/** At settle: identity must be unchanged and the handover recorded after the prompt, then Pi gets one self-retaining entry. */
async function draftCompaction(machine: Machine, current: Pending, live: LiveIdentity, branchEntries: { id: string }[]): Promise<{ boundary: Boundary } | Directive> {
  const { root, seat } = machine.options;
  const drift = compareIdentity(current.identity, await snapshotIdentity(root, seat, live));
  if (!drift.ok) return fallbackDirective(machine, drift, current.percent);
  const prepared = await adoptRecordedHandover({ root, seat, actor: seat, since: current.since, percent: current.percent });
  if (!prepared.ok) return fallbackDirective(machine, prepared, current.percent);
  const built = buildCompactionDraft({ prepared, bundle: await bundleOf(machine), branchEntries });
  if (!built.ok) return fallbackDirective(machine, built, current.percent);
  machine.pending = { ...current, stage: "drafted", handover_id: prepared.handover_id };
  return { boundary: { entries: [built.draft], continue: true } };
}

/** After session_compact: the postcondition decides between re-arming and the fallback. */
async function checkCompaction(machine: Machine, current: Pending, live: LiveIdentity, event: CompactEvent): Promise<Directive | undefined> {
  const { root, seat } = machine.options;
  const verdict = await verifyCompaction({ root, seat, live, before: current.identity, handover_id: current.handover_id ?? "", event });
  if (!verdict.ok) return fallbackDirective(machine, verdict, current.percent);
  machine.pending = undefined;
  machine.gate.rearm(live.pi_session);
  return undefined;
}

/** Window decision for one turn: wait, fall back above 90%, or prompt; one-shot per Pi session. */
async function onTurnEnd(machine: Machine, percent: number | null | undefined): Promise<Directive | undefined> {
  if (percent === null || percent === undefined) return undefined;
  const threshold = await contextHandoverThreshold(machine.options.root).catch(() => undefined);
  if (threshold === undefined) return undefined;
  const decision = compactionDecision(percent, threshold);
  if (decision === "wait" || !machine.gate.arm(machine.options.environment.ATDD_FLOW_PI_SESSION ?? "unidentified")) return undefined;
  if (decision === "fallback") return fallbackDirective(machine, { reason: "above-window", detail: `context ${percent}% is above the 90% compaction window` }, percent);
  return guarded(machine, () => promptForCompaction(machine, percent, threshold)) as Promise<Directive>;
}

async function onBeforeSettle(machine: Machine, branchEntries: { id: string }[]): Promise<{ directive?: Directive; boundary?: Boundary }> {
  const current = machine.pending;
  const live = liveIdentity(machine.options.environment);
  if (!current || current.stage !== "prompted" || !live) return {};
  const outcome = await guarded(machine, () => draftCompaction(machine, current, live, branchEntries));
  return "boundary" in outcome ? outcome : { directive: outcome };
}

async function onCompacted(machine: Machine, event: CompactEvent): Promise<Directive | undefined> {
  const current = machine.pending;
  const live = liveIdentity(machine.options.environment);
  if (!current || current.stage !== "drafted" || !live) return undefined;
  return guarded(machine, () => checkCompaction(machine, current, live, event)) as Promise<Directive | undefined>;
}

async function onCompactFailed(machine: Machine, event: FailedEvent): Promise<Directive | undefined> {
  const current = machine.pending;
  if (!current || current.stage !== "drafted") return undefined;
  const detail = event.aborted ? "compaction was aborted" : event.errorMessage ?? "compaction failed";
  return fallbackDirective(machine, { reason: "compaction-failed", detail }, current.percent);
}

/** Per-extension state machine: prompt in the window, adopt the recorded handover at settle, verify after compaction. */
export function createCompactionSession(options: SessionOptions) {
  const machine: Machine = { options, gate: createCompactionGate() };
  return {
    turnEnd: (percent: number | null | undefined) => onTurnEnd(machine, percent),
    beforeSettle: (branchEntries: { id: string }[]) => onBeforeSettle(machine, branchEntries),
    compacted: (event: CompactEvent) => onCompacted(machine, event),
    compactFailed: (event: FailedEvent) => onCompactFailed(machine, event),
  };
}
