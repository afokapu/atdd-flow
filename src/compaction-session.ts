// URN: component:flow:e032:compaction-session:backend:application
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

/** Per-extension state machine: prompt in the window, adopt the recorded handover at settle, verify after compaction. */
export function createCompactionSession(options: SessionOptions) {
  const { root, seat, environment } = options;
  const gate = createCompactionGate();
  const clock = options.clock ?? (() => new Date().toISOString());
  let pending: Pending | undefined;

  const live = (): LiveIdentity | undefined => {
    const { ATDD_FLOW_PI_SESSION: pi_session, ATDD_FLOW_HERDR_SESSION: herdr_session, ATDD_FLOW_HERDR_PANE: pane } = environment;
    return pi_session && herdr_session && pane ? { pi_session, herdr_session, pane } : undefined;
  };
  const session = () => environment.ATDD_FLOW_PI_SESSION ?? "unidentified";
  const bundle = () => options.recovery().catch(() => undefined);

  async function fallbackDirective(failure: Pick<Fallback, "reason" | "detail">, percent?: number): Promise<Directive> {
    pending = undefined;
    return {
      path: "fallback", content: compactionFallbackInstruction(failure.reason, failure.detail, await bundle()),
      details: { seat, authority: "handover", path: "fallback", reason: failure.reason, ...(percent === undefined ? {} : { percent }) },
    };
  }
  /** An unexpected error never leaves the seat without a path: it becomes the typed fallback. */
  const guarded = async <T>(work: () => Promise<T>): Promise<T | Directive> => {
    try { return await work(); } catch (error) { return fallbackDirective({ reason: "compaction-failed", detail: (error as Error).message }); }
  };

  async function turnEnd(percent: number | null | undefined): Promise<Directive | undefined> {
    if (percent === null || percent === undefined) return undefined;
    let threshold: number;
    try { threshold = await contextHandoverThreshold(root); } catch { return undefined; }
    const decision = compactionDecision(percent, threshold);
    if (decision === "wait" || !gate.arm(session())) return undefined;
    const result = await guarded<Directive>(async () => {
      if (decision === "fallback") return fallbackDirective({ reason: "above-window", detail: `context ${percent}% is above the 90% compaction window` }, percent);
      const identity = live();
      if (!identity) return fallbackDirective({ reason: "identity-unavailable", detail: "the live Pi session, Herdr session and pane are not all known" }, percent);
      pending = { stage: "prompted", since: clock(), percent, identity: await snapshotIdentity(root, seat, identity) };
      return { path: "compaction", content: compactionThresholdInstruction(percent, threshold, await bundle()), details: { seat, threshold, percent, authority: "handover", path: "compaction" } };
    });
    return result;
  }

  async function beforeSettle(branchEntries: { id: string }[]): Promise<{ directive?: Directive; boundary?: Boundary }> {
    const current = pending;
    const identity = live();
    if (!current || current.stage !== "prompted" || !identity) return {};
    const outcome = await guarded<{ boundary: Boundary } | Directive>(async () => {
      const drift = compareIdentity(current.identity, await snapshotIdentity(root, seat, identity));
      if (!drift.ok) return fallbackDirective(drift, current.percent);
      const prepared = await adoptRecordedHandover({ root, seat, actor: seat, since: current.since, percent: current.percent });
      if (!prepared.ok) return fallbackDirective(prepared, current.percent);
      const built = buildCompactionDraft({ prepared, bundle: await bundle(), branchEntries });
      if (!built.ok) return fallbackDirective(built, current.percent);
      pending = { ...current, stage: "drafted", handover_id: prepared.handover_id };
      return { boundary: { entries: [built.draft], continue: true } };
    });
    return "boundary" in outcome ? outcome : { directive: outcome };
  }

  async function compacted(event: CompactEvent): Promise<Directive | undefined> {
    const current = pending;
    const identity = live();
    if (!current || current.stage !== "drafted" || !current.handover_id || !identity) return undefined;
    const result = await guarded<{ ok: true } | Directive>(async () => {
      const verdict = await verifyCompaction({ root, seat, live: identity, before: current.identity, handover_id: current.handover_id!, event });
      return verdict.ok ? verdict : fallbackDirective(verdict, current.percent);
    });
    if ("path" in result) return result;
    pending = undefined;
    gate.rearm(session());
    return undefined;
  }

  async function compactFailed(event: FailedEvent): Promise<Directive | undefined> {
    const current = pending;
    if (!current || current.stage !== "drafted") return undefined;
    return fallbackDirective({ reason: "compaction-failed", detail: event.aborted ? "compaction was aborted" : event.errorMessage ?? "compaction failed" }, current.percent);
  }

  return { turnEnd, beforeSettle, compacted, compactFailed };
}
