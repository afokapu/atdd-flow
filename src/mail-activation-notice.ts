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
