// URN: component:flow:e009:mail-activation-notice:backend:application
// Tested-By:
// - test:flow:relaunched-seat-mail-activation
// Runtime: bun
// Purpose: Name a Pi whose native mail is inactive; it never rewrites a binding.

import { paths, readYaml, type Seat } from "./core";
import { seatTasks, terminal } from "./tasks";

/** The bound and live Pi sessions of a seat whose native mail cannot activate. */
export type InactiveMail = { bound?: string; live?: string };

/** Reads the seat binding at call time; a missing or unreadable seat has no bound session. */
async function boundSession(root: string, seat: string) {
  try { return (await readYaml<Seat>(paths(root).seatFile(seat))).runtime?.pi_session; } catch { return undefined; }
}

/** Only a seat bound for native wake expects Pi to deliver its mail; host-wake seats are not warned. */
export async function expectsNativeMail(root: string, seat: string) {
  try { return (await readYaml<Seat>(paths(root).seatFile(seat))).runtime?.wake === "native"; } catch { return false; }
}

/** The task coordinator to ask for a relaunch, or main of the seat's project when no open task names one. */
async function relaunchOwner(root: string, seat: string) {
  const project = seat.slice(seat.lastIndexOf("@") + 1);
  try {
    const open = (await seatTasks(root, project, seat)).find((entry) => entry.task.assignee === seat && !terminal(entry.task));
    return open?.task.coordinator ?? `main@${project}`;
  } catch { return `main@${project}`; }
}

/** One line for the agent: native mail will not arrive, with the bound and live sessions and the supported recovery. */
export async function inactiveMailNotice(root: string, seat: string, live?: string) {
  const bound = await boundSession(root, seat);
  const owner = await relaunchOwner(root, seat);
  return `SYSTEM: native Flow mail is INACTIVE for ${seat}: live Pi session ${live ?? "unknown"} does not match bound session ${bound ?? "none"}, or its launch receipt is missing. Queued mail will not reach this pane. Run atdd-flow status seat ${seat}; ask ${owner} to relaunch via atdd-flow pi runtime launch ${seat}.`;
}

/** A fresh advisory runtime whose live session differs from the seat binding; legacy or matching records report nothing. */
export function nativeMailInactive(bound: string | undefined, live: string | undefined): InactiveMail | undefined {
  return bound && live && bound !== live ? { bound, live } : undefined;
}
