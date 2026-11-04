// URN: component:flow:e031:compaction-handover:backend:application
// Tested-By:
// - test:flow:same-session-compaction-engine
// Runtime: bun
// Purpose: Plan and verify same-session compaction handover; never starts a session or pane

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type Checkpoint, atomicYaml, canonicalAddress, exists, now, paths, readYaml, seat as readSeat } from "./core";
import { type Handover, contextHandoverThreshold, handoverProblems, recordHandoverText } from "./handover";

/** Upper bound (inclusive) of the compaction window; above it only the fallback path remains. */
const windowCeiling = 90;
const compactTimeoutMs = 120_000;

export type FallbackReason =
  | "above-window" | "invalid-handover" | "foreign-seat" | "unknown-first-kept-entry" | "identity-drift"
  | "postcondition" | "nothing-to-compact" | "already-compacted" | "compaction-failed" | "handover-not-recorded" | "identity-unavailable";
/** Typed fail-closed result: the caller (T3) routes it to the verified successor path; this engine never relaunches. */
export type Fallback = { ok: false; fallback: true; reason: FallbackReason; detail: string };
const fallback = (reason: FallbackReason, detail: string): Fallback => ({ ok: false, fallback: true, reason, detail });

export type LiveIdentity = { pi_session: string; herdr_session: string; pane: string };
export type Identity = Record<string, string | undefined>;
export type CompactionDraft = { type: "compaction"; summary: string; firstKeptEntryId: string | null; details: { seat: string; handover_id: string } };
export type PreparedHandover = { ok: true; seat: string; handover_id: string; text: string };

export const compactionDecision = (percent: number, threshold: number, ceiling = windowCeiling): "wait" | "compact" | "fallback" =>
  percent < threshold ? "wait" : percent <= ceiling ? "compact" : "fallback";

/** One compaction per session until a verified result re-arms it. */
export function createCompactionGate() {
  const armed = new Set<string>();
  return {
    arm: (session: string) => !armed.has(session) && Boolean(armed.add(session)),
    rearm: (session: string) => { armed.delete(session); },
  };
}
export type CompactionGate = ReturnType<typeof createCompactionGate>;

type PrepareInput = { root: string; seat: string; actor: string; handoverText: string; checkpoint: { summary: string; next_action: string } };

/** Validates and records the seat's handover and checkpoint; only the seat itself may self-service. */
export async function prepareHandover(input: PrepareInput): Promise<PreparedHandover | Fallback> {
  const resolved = await canonicalAddress(input.root, input.seat);
  const actor = await canonicalAddress(input.root, input.actor);
  if (actor !== resolved) return fallback("foreign-seat", `${actor} may not compact ${resolved}; each seat self-services its own address.`);
  await readSeat(input.root, resolved);
  const outcome = await recordHandoverText(input.root, resolved, input.handoverText);
  if (!outcome.ok) return fallback("invalid-handover", outcome.problems.join("; "));
  const record: Checkpoint = { schema: "atdd-workflow/checkpoint/v1", seat: resolved, status: "active", updated_at: now(), ...input.checkpoint };
  await atomicYaml(paths(input.root).checkpointFile(resolved), record);
  return { ok: true, seat: resolved, handover_id: outcome.id, text: input.handoverText };
}

type AdoptInput = { root: string; seat: string; actor: string; since: string; percent: number };

/**
 * Adopts the handover the seat itself recorded after `since` (the prompt), re-validating it, and records the
 * checkpoint unless the seat wrote a current one. A missing, older, foreign or invalid record is a typed fallback.
 */
export async function adoptRecordedHandover(input: AdoptInput): Promise<PreparedHandover | Fallback> {
  const resolved = await canonicalAddress(input.root, input.seat);
  if (await canonicalAddress(input.root, input.actor) !== resolved) return fallback("foreign-seat", `${input.actor} may not compact ${resolved}.`);
  const file = paths(input.root).handoverFile(resolved);
  const record = await exists(file) ? await readYaml<Handover>(file) : undefined;
  if (!record || record.recorded_at < input.since) return fallback("handover-not-recorded", `no handover recorded after the compaction prompt (${record ? `latest ${record.handover_id}` : "none"}).`);
  const problems = handoverProblems(record.text, resolved, record.supersedes === "none" ? undefined : record.supersedes);
  if (record.seat !== resolved || problems.length) return fallback("invalid-handover", problems.join("; ") || `recorded handover is for ${record.seat}.`);
  const checkpointFile = paths(input.root).checkpointFile(resolved);
  const current = await exists(checkpointFile) ? await readYaml<Checkpoint>(checkpointFile) : undefined;
  if (!current || current.updated_at < input.since) {
    const checkpoint: Checkpoint = {
      schema: "atdd-workflow/checkpoint/v1", seat: resolved, status: "active", updated_at: now(),
      summary: `Same-session compaction at ${input.percent}% with handover ${record.handover_id}.`,
      next_action: `Resume from section 4 of the recorded handover: atdd-flow handover show ${resolved}`,
    };
    await atomicYaml(checkpointFile, checkpoint);
  }
  return { ok: true, seat: resolved, handover_id: record.handover_id, text: record.text };
}

type DraftInput = { prepared: PreparedHandover; bundle?: string; branchEntries: { id: string }[]; firstKeptEntryId?: string | null };

/** The typed draft for Pi's turn_end/agent_before_settle path; null keeps no tail, any explicit id must be a branch entry. */
export function buildCompactionDraft(input: DraftInput): { ok: true; draft: CompactionDraft } | Fallback {
  const kept = input.firstKeptEntryId ?? null;
  if (kept !== null && !input.branchEntries.some((entry) => entry.id === kept)) return fallback("unknown-first-kept-entry", `firstKeptEntryId ${kept} is not a branch entry.`);
  const { prepared } = input;
  const summary = [`Flow same-session handover ${prepared.handover_id} for ${prepared.seat}; continue in this session from section 4 after: atdd-flow open ${prepared.seat}`, prepared.text.trimEnd(), ...(input.bundle ? [input.bundle] : [])].join("\n");
  return { ok: true, draft: { type: "compaction", summary, firstKeptEntryId: kept, details: { seat: prepared.seat, handover_id: prepared.handover_id } } };
}

const sha256 = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

/** Every identity field the primary path must leave untouched: the recorded runtime, the launch receipt bytes, and the live process tuple. */
export async function snapshotIdentity(root: string, seat: string, live: LiveIdentity): Promise<Identity> {
  const runtime = (await readSeat(root, await canonicalAddress(root, seat))).runtime;
  const locator = runtime?.addresses.herdr;
  const receipt = runtime?.launch_receipt;
  return {
    pi_session: runtime?.pi_session, pi_session_path: runtime?.pi_session_path, launch_receipt: receipt,
    receipt_sha256: receipt && await exists(receipt) ? await sha256(receipt) : undefined,
    herdr_session: typeof locator === "object" ? locator.session : undefined, pane: typeof locator === "object" ? locator.pane : locator,
    live_pi_session: live.pi_session, live_herdr_session: live.herdr_session, live_pane: live.pane,
  };
}

export function compareIdentity(before: Identity, after: Identity): { ok: true } | Fallback {
  const drifted = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((field) => before[field] !== after[field]);
  return drifted.length ? fallback("identity-drift", `identity changed during compaction: ${drifted.join(", ")}`) : { ok: true };
}

type VerifyInput = {
  root: string; seat: string; live: LiveIdentity; before: Identity; handover_id: string;
  event: { compactionEntry: { id: string; firstKeptEntryId: string | null; summary: string } };
};

/** Postcondition after Pi's session_compact: identity unchanged, entry self-retaining, summary and Desk record are this handover. */
export async function verifyCompaction(input: VerifyInput): Promise<{ ok: true } | Fallback> {
  const resolved = await canonicalAddress(input.root, input.seat);
  const identity = compareIdentity(input.before, await snapshotIdentity(input.root, resolved, input.live));
  if (!identity.ok) return identity;
  const entry = input.event.compactionEntry;
  if (entry.firstKeptEntryId !== entry.id) return fallback("postcondition", `compaction entry ${entry.id} is not self-retaining (firstKeptEntryId ${entry.firstKeptEntryId}).`);
  if (!entry.summary.includes(input.handover_id)) return fallback("postcondition", `compaction summary does not carry handover ${input.handover_id}.`);
  const handoverFile = paths(input.root).handoverFile(resolved);
  const recorded = await exists(handoverFile) ? (await readYaml<Handover>(handoverFile)).handover_id : undefined;
  if (recorded !== input.handover_id) return fallback("postcondition", `recorded handover is ${recorded ?? "absent"}, expected ${input.handover_id}.`);
  if (!await exists(paths(input.root).checkpointFile(resolved))) return fallback("postcondition", "checkpoint was not recorded.");
  return { ok: true };
}

type CompactOptions = { customInstructions?: string; onComplete?: (result: unknown) => void; onError?: (error: Error) => void };
type CompactHost = { compact(options: CompactOptions): void };

const refusal = (message: string): FallbackReason =>
  /nothing to compact/i.test(message) ? "nothing-to-compact" : /already compacted/i.test(message) ? "already-compacted" : "compaction-failed";

/** ctx.compact is fire-and-forget and may refuse; success is only what onComplete reports. */
export function requestCompaction(host: CompactHost, options: { customInstructions?: string; timeoutMs?: number }) {
  return new Promise<{ ok: true; result: unknown } | Fallback>((resolve) => {
    const timer = setTimeout(() => resolve(fallback("compaction-failed", "compaction did not report within the timeout.")), options.timeoutMs ?? compactTimeoutMs);
    const settle = (value: { ok: true; result: unknown } | Fallback) => { clearTimeout(timer); resolve(value); };
    try {
      host.compact({
        customInstructions: options.customInstructions,
        onComplete: (result) => settle({ ok: true, result }),
        onError: (error) => settle(fallback(refusal(error.message), error.message)),
      });
    } catch (error) {
      settle(fallback("compaction-failed", (error as Error).message));
    }
  });
}

type PlanInput = PrepareInput & Omit<DraftInput, "prepared"> & { live: LiveIdentity; percent: number; gate: CompactionGate };
export type Planned =
  | { ok: true; action: "skip"; reason: "below-threshold" | "already-armed" }
  | { ok: true; action: "compact"; entries: [CompactionDraft]; continue: true; handover_id: string; identity: Identity }
  | Fallback;

/** The whole primary decision: window, one-shot gate, validated handover/checkpoint, identity snapshot, self-retaining draft. */
export async function planSameSessionCompaction(input: PlanInput): Promise<Planned> {
  const threshold = await contextHandoverThreshold(input.root);
  const decision = compactionDecision(input.percent, threshold);
  if (decision === "wait") return { ok: true, action: "skip", reason: "below-threshold" };
  if (decision === "fallback") return fallback("above-window", `context ${input.percent}% is above ${windowCeiling}%; compaction is not attempted.`);
  if (!input.gate.arm(input.live.pi_session)) return { ok: true, action: "skip", reason: "already-armed" };
  const identity = await snapshotIdentity(input.root, input.seat, input.live);
  const prepared = await prepareHandover(input);
  if (!prepared.ok) return prepared;
  const built = buildCompactionDraft({ prepared, bundle: input.bundle, branchEntries: input.branchEntries, firstKeptEntryId: input.firstKeptEntryId });
  if (!built.ok) return built;
  return { ok: true, action: "compact", entries: [built.draft], continue: true, handover_id: prepared.handover_id, identity };
}
