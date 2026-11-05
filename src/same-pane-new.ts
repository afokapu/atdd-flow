// URN: component:flow:e005:same-pane-new:backend:integration
// Tested-By:
// - test:atdd-flow:same-pane-new-context-verifier
// Runtime: bun
// Purpose: Verify a handover then same-pane /new and refresh the seat Pi binding.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type HerdrLocator, type Runtime, type Seat, atomicYaml, exists, paths, readYaml, yaml } from "./core";
import { type Handover, handoverProblems, handoverReplacementPath } from "./handover";

export type SamePaneLive = { session?: string; sessionPath?: string; herdrSession?: string; pane?: string };
export type Refusal = { refused: string };
export type Quiescence = { isIdle?: unknown; hasPendingMessages?: unknown };
export type VerifiedSamePaneNew = { record: Seat; handover: Handover; attestation: string };
type Attestation = { schema?: string; seat?: string; source_pi_session?: string; attested_at?: string };
type ReceiptRecord = { same_pane_new?: { handover?: string } };

const attestationTtlMs = 120_000;
const inFlightHeading = "2. OPEN WORK AND IN-FLIGHT OPERATIONS";
const nextHeading = "3. DEPENDENCIES";

const noInFlight = "no IN-FLIGHT declaration";
const runtimeLaunchDirectory = (root: string) => join(root, ".atdd-flow", "runtime-launch");
const attestationPath = (root: string, seat: string) => join(root, ".atdd-flow", "same-pane-new", `${encodeURIComponent(seat)}.yaml`);

async function readHandover(root: string, seat: string): Promise<Handover | undefined> {
  const file = paths(root).handoverFile(seat);
  return await exists(file) ? readYaml<Handover>(file).catch(() => undefined) : undefined;
}

/**
 * Structural problems of a recorded handover. Supersession and id-reuse are properties of recording, not of consuming a handover,
 * so they are excluded; a handover written for another seat is always a problem.
 */
function structuralProblems(handover: Handover, seat: string) {
  if (handover.seat !== seat) return [`handover seat ${handover.seat} is not ${seat}`];
  return handoverProblems(handover.text, seat, undefined).filter((problem) => !/supersedes|already recorded/.test(problem));
}

/** `none` only when section 2 declares exactly one `- IN-FLIGHT: none` and no other IN-FLIGHT operation. */
export function handoverInFlight(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(inFlightHeading));
  if (start < 0) return noInFlight;
  const end = lines.findIndex((line, index) => index > start && line.trim().startsWith(nextHeading));
  const declared = lines.slice(start + 1, end < 0 ? undefined : end).map((line) => line.trim()).filter((line) => /^-\s*IN-FLIGHT:/.test(line));
  if (!declared.length) return noInFlight;
  if (declared.length === 1 && /^-\s*IN-FLIGHT:\s*none\s*$/.test(declared[0]!)) return undefined;
  return "an IN-FLIGHT operation is declared";
}

/** Pi-visible quiescence: both signals must exist and report idle with nothing pending; unknown refuses. */
export function piQuiescence(ctx: Quiescence): string | undefined {
  if (typeof ctx.isIdle !== "function" || typeof ctx.hasPendingMessages !== "function") return "quiescence unknown: the host exposes no isIdle/hasPendingMessages";
  let idle: unknown, pending: unknown;
  try { idle = (ctx.isIdle as () => unknown)(); pending = (ctx.hasPendingMessages as () => unknown)(); }
  catch { return "quiescence unknown: the host quiescence signals failed"; }
  if (idle !== true) return "not quiescent: the agent is running (a push, rebase, review submission or test run may be in flight)";
  if (pending !== false) return "not quiescent: messages are pending delivery";
  return undefined;
}

/**
 * The `session_before_switch` gate for reason `new`. Returns the refusal reason, or records a short-lived attestation that this
 * `/new` passed the quiescence checks, so the reloaded extension's session_start can refuse a switch that bypassed the gate.
 */
export async function attestQuiescent(root: string, seat: string, ctx: Quiescence, sourceSession: string | undefined): Promise<string | undefined> {
  const reason = piQuiescence(ctx);
  if (reason) return reason;
  const handover = await readHandover(root, seat);
  // An unreadable or invalid handover is refused later by the session_start verifier, which names the exact problem.
  if (handover && !structuralProblems(handover, seat).length) {
    const inFlight = handoverInFlight(handover.text);
    if (inFlight) return `handover ${handover.handover_id} is not quiescent: ${inFlight}; section 2 must declare exactly "- IN-FLIGHT: none"`;
  }
  await atomicYaml(attestationPath(root, seat), { schema: "atdd-flow/same-pane-new-attestation/v1", seat, source_pi_session: sourceSession ?? "", attested_at: new Date().toISOString() });
  return undefined;
}

/** A seat record whose runtime is a native Herdr binding that already names a Pi session and its JSONL. */
type BoundRuntime = Runtime & { pi_session: string; pi_session_path: string };
type Bound = { runtime: BoundRuntime; locator: HerdrLocator };

/** Everything a guard may consult; one guard decides one refusal. */
type Evidence = Bound & { root: string; seat: string; live: SamePaneLive; previousSessionFile: string | undefined; handover: Handover };
type Guard = (evidence: Evidence) => string | undefined | Promise<string | undefined>;

/** The native Herdr binding that a same-pane `/new` refreshes, or undefined when the seat has none. */
function nativeBinding(record: Seat): Bound | undefined {
  const runtime = record.runtime, locator = runtime?.addresses.herdr;
  if (runtime?.application !== "herdr" || runtime.wake !== "native" || typeof locator !== "object") return undefined;
  if (!runtime.pi_session || !runtime.pi_session_path) return undefined;
  return { runtime: runtime as BoundRuntime, locator };
}

const invalidHandover: Guard = ({ seat, handover }) => {
  const [problem] = structuralProblems(handover, seat);
  return problem ? `invalid handover for ${seat}: ${problem}` : undefined;
};

const pathARequest: Guard = async ({ root, seat }) =>
  await exists(handoverReplacementPath(root, seat)) ? `an active Path-A replacement request exists for ${seat}; a same-pane /new does not replace it` : undefined;

const samePane: Guard = ({ live, locator }) =>
  live.herdrSession && live.pane && live.herdrSession === locator.session && live.pane === locator.pane ? undefined
    : `the live Herdr session/pane ${live.herdrSession ?? "?"}:${live.pane ?? "?"} is not the bound pane ${locator.session}:${locator.pane}`;

const liveSessionKnown: Guard = ({ live }) => live.session && live.sessionPath ? undefined : "the live Pi session id or file is unavailable";

const isNewSession: Guard = ({ live, runtime }) =>
  live.session === runtime.pi_session || resolve(live.sessionPath!) === resolve(runtime.pi_session_path) ? "the live Pi is not a new session (it is the bound session)" : undefined;

const previousIsBound: Guard = ({ previousSessionFile, runtime }) =>
  previousSessionFile && resolve(previousSessionFile) === resolve(runtime.pi_session_path) ? undefined : `the previous session file is not the bound session ${runtime.pi_session}`;

const notYetConsumed: Guard = async ({ runtime, handover }) => {
  const receipt = runtime.launch_receipt ? await readYaml<ReceiptRecord>(runtime.launch_receipt).catch(() => undefined) : undefined;
  return receipt?.same_pane_new?.handover === handover.handover_id ? `handover ${handover.handover_id} was already consumed by a same-pane /new` : undefined;
};

/** A handover reconstructed by a third party names a Pi session this seat never bound. */
const namesBoundSession: Guard = ({ runtime, handover }) => {
  const named = /\|\s*pi session (\S+)\s*\|/.exec(handover.text.split("\n")[1] ?? "")?.[1];
  return named === runtime.pi_session ? undefined : `handover ${handover.handover_id} names a different Pi session (${named ?? "none"}) than the bound ${runtime.pi_session}; third-party reconstruction is refused`;
};

const handoverQuiescent: Guard = ({ handover }) => {
  const inFlight = handoverInFlight(handover.text);
  return inFlight ? `handover ${handover.handover_id} is not quiescent (in-flight): ${inFlight}` : undefined;
};

/** The reloaded extension may refresh only a `/new` that passed the session_before_switch gate recently, from the bound source session. */
const gateAttested: Guard = async ({ root, seat, runtime }) => {
  const attested = await readYaml<Attestation>(attestationPath(root, seat)).catch(() => undefined);
  const fresh = attested?.attested_at !== undefined && Date.now() - Date.parse(attested.attested_at) <= attestationTtlMs;
  return fresh && attested?.source_pi_session === runtime.pi_session ? undefined : "quiescence was not attested: this /new did not pass the session_before_switch gate";
};

/** Order is the refusal precedence: the first guard that objects names the one reason reported. */
const lineageGuards: Guard[] = [invalidHandover, pathARequest, samePane, liveSessionKnown, isNewSession, previousIsBound, notYetConsumed, namesBoundSession, handoverQuiescent, gateAttested];

/** Verify every lineage guard for a `/new` landing in the bound pane. Never writes. */
export async function verifySamePaneNew(root: string, seat: string, live: SamePaneLive, previousSessionFile: string | undefined): Promise<Refusal | VerifiedSamePaneNew> {
  const record = await readYaml<Seat>(paths(root).seatFile(seat)).catch(() => undefined);
  if (!record) return { refused: `seat ${seat} is not readable` };
  const bound = nativeBinding(record);
  if (!bound) return { refused: `${seat} has no native binding (Herdr session and pane with a bound Pi session) to refresh` };
  const handover = await readHandover(root, seat);
  if (!handover) return { refused: `no recorded handover for ${seat}` };
  const evidence: Evidence = { ...bound, root, seat, live, previousSessionFile, handover };
  for (const guard of lineageGuards) {
    const refused = await guard(evidence);
    if (refused) return { refused };
  }
  return { record, handover, attestation: attestationPath(root, seat) };
}

/** Refresh the durable binding to the live Pi (same seat, pane, application and wake mode) and record an immutable receipt. */
export async function refreshSamePaneNew(root: string, seat: string, live: Required<SamePaneLive>, verified: VerifiedSamePaneNew) {
  const { record, handover } = verified, runtime = record.runtime!;
  const receipt = join(runtimeLaunchDirectory(root), `${encodeURIComponent(live.session)}-${crypto.randomUUID().slice(0, 8)}.yaml`);
  await mkdir(runtimeLaunchDirectory(root), { recursive: true });
  await writeFile(receipt, yaml.print({
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: live.session, pi_session_path: live.sessionPath, herdr_session: live.herdrSession, pane: live.pane,
    created_at: new Date().toISOString(), same_pane_new: { handover: handover.handover_id, previous_pi_session: runtime.pi_session, previous_receipt: runtime.launch_receipt ?? null },
  }), { encoding: "utf8", flag: "wx" });
  // Re-read immediately before writing so only the session fields change.
  const latest = await readYaml<Seat>(paths(root).seatFile(seat));
  latest.runtime = { ...latest.runtime!, pi_session: live.session, pi_session_path: live.sessionPath, launch_receipt: receipt };
  await atomicYaml(paths(root).seatFile(seat), latest);
  await rm(verified.attestation, { force: true });
}

/** A refused or consumed attestation is never reusable. */
export const clearAttestation = (root: string, seat: string) => rm(attestationPath(root, seat), { force: true });

/** True when the seat's current receipt records a same-pane /new refresh to exactly this live session. */
export async function samePaneNewLineage(root: string, seat: string, session: string | undefined) {
  if (!session) return false;
  try {
    const runtime = (await readYaml<Seat>(paths(root).seatFile(seat))).runtime;
    if (!runtime?.launch_receipt || runtime.pi_session !== session) return false;
    return Boolean((await readYaml<ReceiptRecord>(runtime.launch_receipt)).same_pane_new);
  } catch { return false; }
}
