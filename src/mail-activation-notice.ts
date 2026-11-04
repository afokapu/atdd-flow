// URN: component:flow:e009:mail-activation-notice:backend:application
// Tested-By:
// - test:flow:relaunched-seat-mail-activation
// - test:flow:inactive-mail-notice-diagnosable
// Runtime: bun
// Purpose: Name a Pi whose native mail is inactive; it never rewrites a binding.

import { existsSync } from "node:fs";
import { paths, readYaml, type Seat } from "./core";
import type { MailActivation } from "./runtime-state";
import { seatTasks, terminal } from "./tasks";

/** The bound and live Pi sessions of a seat whose native mail cannot activate. */
export type InactiveMail = { bound?: string; live?: string };

/** The live identifiers a Pi compared with its seat binding; an unknown value is left undefined. */
export type LiveIdentity = { pi_session?: string; herdr_session?: string; pane?: string };

async function readSeat(root: string, seat: string) {
  try { return await readYaml<Seat>(paths(root).seatFile(seat)); } catch { return undefined; }
}

/** Only a seat bound for native wake expects Pi to deliver its mail; host-wake seats are not warned. */
export async function expectsNativeMail(root: string, seat: string) {
  return (await readSeat(root, seat))?.runtime?.wake === "native";
}

/** The task coordinator to ask for a relaunch, or main of the seat's project when no open task names one. */
async function relaunchOwner(root: string, seat: string) {
  const project = seat.slice(seat.lastIndexOf("@") + 1);
  try {
    const open = (await seatTasks(root, project, seat)).find((entry) => entry.task.assignee === seat && !terminal(entry.task));
    return open?.task.coordinator ?? `main@${project}`;
  } catch { return `main@${project}`; }
}

function boundIdentity(record: Seat | undefined): MailActivation["bound"] {
  const runtime = record?.runtime;
  const locator = runtime?.addresses.herdr;
  const scoped = typeof locator === "object" ? locator : undefined;
  const receipt = runtime?.launch_receipt ? (existsSync(runtime.launch_receipt) ? "present" : "missing") : "none";
  return { pi_session: runtime?.pi_session, herdr_session: scoped?.session, pane: scoped?.pane, receipt };
}

/** Compares the live identity with the seat binding at call time; an unknown live value counts as differing from a bound one. */
export async function diagnoseMailActivation(root: string, seat: string, live: LiveIdentity, transport: MailActivation["transport"], error?: string): Promise<MailActivation> {
  const bound = boundIdentity(await readSeat(root, seat));
  const fields = [["session", live.pi_session, bound.pi_session], ["herdr", live.herdr_session, bound.herdr_session], ["pane", live.pane, bound.pane]] as const;
  const differs = fields.filter(([, liveValue, boundValue]) => boundValue !== undefined && liveValue !== boundValue).map(([name]) => name);
  return { at: new Date().toISOString(), transport, live, bound, differs, ...(error ? { error } : {}) };
}

/** The exact compared values, shared by the notice and `status seat`. */
export function describeActivation(activation: MailActivation) {
  const value = (entry?: string) => entry ?? "unknown";
  const { live, bound } = activation;
  return `live session=${value(live.pi_session)} herdr=${value(live.herdr_session)} pane=${value(live.pane)}; bound session=${value(bound.pi_session)} herdr=${value(bound.herdr_session)} pane=${value(bound.pane)} receipt=${bound.receipt}`;
}

/** Display-only text: INACTIVE only when the transport never started; a failed later startup step is reported as ACTIVE. */
export async function activationNotice(root: string, seat: string, activation: MailActivation) {
  const values = describeActivation(activation);
  if (activation.transport === "active") {
    return `SYSTEM: native Flow mail is ACTIVE for ${seat}; a startup step failed: ${activation.error ?? "unknown"}. Display only; no action is required for mail delivery. ${values}.`;
  }
  const differs = activation.differs.length ? ` Differs: ${activation.differs.join(", ")} (live does not match the binding).` : " All compared values match.";
  const error = activation.error ? ` Last activation error: ${activation.error}.` : "";
  const owner = await relaunchOwner(root, seat);
  return `SYSTEM: native Flow mail is INACTIVE for ${seat} (display only). ${values}.${differs}${error} Queued mail will not reach this pane. Run atdd-flow status seat ${seat}; ask ${owner} to relaunch via atdd-flow pi runtime launch ${seat}.`;
}

/** A fresh advisory runtime whose live session differs from the seat binding; legacy or matching records report nothing. */
export function nativeMailInactive(bound: string | undefined, live: string | undefined): InactiveMail | undefined {
  return bound && live && bound !== live ? { bound, live } : undefined;
}

/** The snapshot's recorded live identity compared with the durable seat record as it stands now. */
async function currentComparison(root: string, seat: string, activation: MailActivation) {
  const now = await diagnoseMailActivation(root, seat, activation.live, activation.transport);
  return { bound: now.bound, differs: now.differs };
}

/**
 * The `status seat` line for a recorded activation. The snapshot is history: its bound values and differing fields are
 * recomputed from the durable record at read time, so a binding repaired after the snapshot is reported stale, not as a live mismatch.
 */
export async function describeSnapshot(root: string, seat: string, activation: MailActivation) {
  const { bound, differs } = await currentComparison(root, seat, activation);
  const current = { ...activation, bound, differs };
  const error = activation.error ? `; error: ${activation.error}` : "";
  const stamp = activation.at.slice(0, 19);
  if (activation.transport === "inactive" && activation.differs.length && !differs.length) {
    return `native mail snapshot of ${stamp} is stale: it was inactive before the binding was repaired. The durable binding now matches the live Pi (${describeActivation(current)}). Not a live mismatch; a running Pi re-verifies and activates by itself${error}`;
  }
  return `native mail ${activation.transport} (as of ${stamp}): ${describeActivation(current)}${differs.length ? `; differs ${differs.join(", ")}` : ""}${error}`;
}

type LaunchReceipt = { seat?: string; pi_session?: string; pi_session_path?: string; herdr_session?: string; pane?: string };

/** What a running Pi can prove about itself; an absent value is unknown and proves nothing. */
export type LiveProof = { pi_session?: string; pi_session_path?: string; herdr_session?: string; pane?: string };

const unsetOrEqual = (recorded?: string, current?: string) => !recorded || recorded === current;

type NativeRuntime = NonNullable<Seat["runtime"]>;

/** The durable native Herdr locator is exactly this live Herdr session and pane. */
function locatesLive(runtime: NativeRuntime | undefined, live: LiveProof): runtime is NativeRuntime {
  const locator = runtime?.addresses.herdr;
  return runtime?.application === "herdr" && runtime.wake === "native" && typeof locator === "object"
    && locator.session === live.herdr_session && locator.pane === live.pane;
}

/** A launcher-bound seat holds a readable receipt for this same Pi session; its pane is the launch-time pane and may differ after a bind. */
async function receiptProvesLive(seat: string, runtime: NativeRuntime, receiptFile: string, live: LiveProof) {
  if (!live.pi_session || runtime.pi_session !== live.pi_session) return false;
  const receipt = await readYaml<LaunchReceipt>(receiptFile);
  return receipt.seat === seat && receipt.pi_session === live.pi_session && receipt.pi_session_path === runtime.pi_session_path && receipt.herdr_session === live.herdr_session;
}

/**
 * True only when the durable native binding names exactly this live Pi: the Herdr session and pane match the live ones and
 * the bound Pi session is the live one. A launcher-bound seat must also hold a receipt for that same session.
 * This reads and never writes.
 */
export async function bindingMatchesLive(root: string, seat: string, live: LiveProof): Promise<boolean> {
  if (!live.herdr_session || !live.pane) return false;
  try {
    const runtime = (await readSeat(root, seat))?.runtime;
    if (!locatesLive(runtime, live)) return false;
    if (runtime.launch_receipt) return await receiptProvesLive(seat, runtime, runtime.launch_receipt, live);
    return unsetOrEqual(runtime.pi_session, live.pi_session) && unsetOrEqual(runtime.pi_session_path, live.pi_session_path);
  } catch { return false; }
}
