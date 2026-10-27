// URN: component:flow:e015:main-mail-repair:backend:application
// Tested-By:
// - test:flow:main-mail-repair:E015-UNIT-001
// Runtime: bun
// Purpose: Reach identity-verified main agents whose native inbox is disabled.
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { type Seat, atomicYaml, exists, paths, project, readYaml, runOutput } from "./core";
import { notify } from "./adapters";
import { type RuntimeState, isRuntimeStateStale, readRuntimeState, withOwnedRuntimeState } from "./runtime-state";
import { add as addTask, type Task } from "./tasks";

export type MainRepairReport = { seat: string; task?: string; outcome: "reached" | "ready" | "cooldown" | "exhausted" | "unverified" | "failed" };
export type MainRepairOptions = {
  now?: Date;
  dryRun?: boolean;
  inspect?: (session: string, pane: string, name: string) => Promise<{ name: string; pane: string; cwd: string; sessionPath: string }>;
  deliver?: (session: string, pane: string, notice: string) => Promise<void>;
};
type Candidate = { seat: Seat; live: RuntimeState; herdr: { session: string; pane: string }; bound: string };
type Memo = { schema: "atdd-flow/main-mail-repair-notice/v1"; at: string; count: number };
const codeFor = (address: string) => `flow-${address.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`.slice(0, 32);
const taskId = (candidate: Candidate) => "mail-repair-" + createHash("sha256")
  .update([candidate.seat.address, candidate.bound, candidate.live.pi_session].join("\0")).digest("hex").slice(0, 12);
const memoPath = (root: string, candidate: Candidate) => join(root, ".atdd-flow", "main-repair", `${taskId(candidate)}.yaml`);
const unwrap = (value: unknown) => {
  const record = value as { result?: { agent?: Record<string, unknown> }; agent?: Record<string, unknown> };
  return record?.result?.agent ?? record?.agent ?? record?.result ?? record;
};

/** The Herdr process itself must match the recorded seat, not just its pane. */
async function inspectHerdr(session: string, pane: string, name: string) {
  const command = (kind: string, target: string) => ["herdr", "--session", session, kind, "get", target];
  const raw = JSON.parse(await runOutput(command("agent", name)));
  const item = unwrap(raw) as Record<string, any>;
  const path = item?.agent_session?.kind === "path" ? item.agent_session.value : undefined;
  return { name: String(item?.name ?? ""), pane: String(item?.pane_id ?? ""),
    cwd: String(item?.cwd ?? ""), sessionPath: typeof path === "string" ? path : "" };
}

/** Only canonical main seats are allowed to receive this special repair path.
 * Other roles continue to use their existing coordinator escalation rules.
 */
function canonicalMain(seat: Seat) {
  return seat.role === "main" && seat.address === `main@${seat.project}` && !seat.retired;
}

/** Runtime placement cannot differ: only the Pi session ID may be stale. */
function eligibleRuntime(seat: Seat, live: RuntimeState) {
  const runtime = seat.runtime, herdr = runtime?.addresses.herdr;
  return runtime?.application === "herdr" && runtime.wake === "native"
    && !!herdr && typeof herdr !== "string" && !!runtime.pi_session
    && !!live.pi_session && runtime.pi_session !== live.pi_session && live.seat === seat.address;
}

/** A failed activation must name exactly the session field, not a pane or host. */
function exactInactiveMail(seat: Seat, live: RuntimeState) {
  const activation = live.mail_activation, runtime = seat.runtime;
  const herdr = runtime?.addresses.herdr;
  if (!activation || !herdr || typeof herdr === "string") return false;
  const compared = activation.bound.pi_session === runtime?.pi_session
    && activation.live.pi_session === live.pi_session;
  const placement = activation.live.herdr_session === herdr.session
    && activation.live.pane === herdr.pane;
  return activation.transport === "inactive" && compared && placement
    && activation.differs.length === 1 && activation.differs[0] === "session";
}

/** Mismatches of session ID alone can trigger this narrow repair pathway. */
function onlySessionMismatch(seat: Seat, live: RuntimeState): Candidate | undefined {
  if (!canonicalMain(seat) || !eligibleRuntime(seat, live) || !exactInactiveMail(seat, live)) return;
  const runtime = seat.runtime!, herdr = runtime.addresses.herdr;
  if (!herdr || typeof herdr === "string") return;
  return { seat, live, herdr, bound: runtime.pi_session! };
}

/** Verify main's primary worktree, live Pi identity, and exact JSONL session. */
async function confirm(root: string, candidate: Candidate, inspect: NonNullable<MainRepairOptions["inspect"]>) {
  const primary = (await project(root, candidate.seat.project)).repository;
  if (!primary || resolve(primary) !== resolve(candidate.seat.worktree)) return false;
  const agent = await inspect(candidate.herdr.session, candidate.herdr.pane, codeFor(candidate.seat.address));
  const sessionId = agent.sessionPath.match(/_([0-9a-f-]{36})\.jsonl$/i)?.[1];
  return agent.name === codeFor(candidate.seat.address) && agent.pane === candidate.herdr.pane
    && resolve(agent.cwd) === resolve(candidate.seat.worktree) && sessionId === candidate.live.pi_session;
}

/** Repair is an ordinary, assigned task; only verified existing authority can complete it. */
async function repairTask(root: string, candidate: Candidate, id: string) {
  const file = paths(root).taskFile(candidate.seat.project, id);
  if (await exists(file)) {
    const current = await readYaml<Task>(file);
    return current.schema === "atdd-workflow/task/v1" && current.assignee === candidate.seat.address
      && current.coordinator === candidate.seat.address && current.status !== "done" ? true : false;
  }
  await addTask(root, candidate.seat.project, id, [
    "--title", "Repair externally restarted main Pi native mail",
    "--coordinator", candidate.seat.address, "--assignee", candidate.seat.address,
    "--body", `Native inbox inactive: Flow bound session ${candidate.bound}, live Pi session ${candidate.live.pi_session}. Same recorded Herdr pane and main worktree. Obtain existing operator authorization for exact-session recovery. Never overwrite seat.yaml or trust pane position alone.`,
    "--done-when", "Current main Pi session has a verified Flow receipt and matching bound ID, with native mail active.",
  ], { quiet: true });
  return true;
}

/** A bounded memo makes direct Herdr prompts idempotent across host restarts.
 * A failed prompt counts as an attempt, preventing storming a broken host.
 */
async function reservePrompt(root: string, candidate: Candidate, at: Date) {
  const file = memoPath(root, candidate);
  const previous = await readYaml<Memo>(file).catch(() => undefined);
  if (previous?.count === 2) return "exhausted" as const;
  if (previous && at.getTime() - Date.parse(previous.at) < 300_000) return "cooldown" as const;
  await atomicYaml(file, { schema: "atdd-flow/main-mail-repair-notice/v1", at: at.toISOString(),
    count: (previous?.count ?? 0) + 1 } satisfies Memo);
  return "reserved" as const;
}

/** A single prompt is not a substitute for a repaired binding.
 * The repair task is permanent Desk work; the memo is temporary host evidence.
 */
async function sendRepair(root: string, candidate: Candidate, options: MainRepairOptions) {
  const id = taskId(candidate);
  const prior = await readYaml<Memo>(memoPath(root, candidate)).catch(() => undefined);
  if (prior?.count === 2) return "exhausted" as const;
  if (prior && (options.now ?? new Date()).getTime() - Date.parse(prior.at) < 300_000) return "cooldown" as const;
  if (!await repairTask(root, candidate, id)) return "failed" as const;
  const disposition = await reservePrompt(root, candidate, options.now ?? new Date());
  if (disposition !== "reserved") return disposition;
  const notice = `SYSTEM: repair task ${candidate.seat.project}/${id} for ${candidate.seat.address}. Your native Flow inbox is inactive because bound Pi session ${candidate.bound} differs from your live Pi session ${candidate.live.pi_session}. This exact Herdr prompt is a recovery notice, not mail activation. Read 'atdd-flow task open ${candidate.seat.project} ${id}' and 'atdd-flow status seat ${candidate.seat.address}'. Coordinate the existing operator-authorized exact-session recovery and verify native mail; do not blindly rebind or invent authorization.`;
  try {
    await (options.deliver ?? ((session, pane, body) => notify("herdr", pane, body, session)))
      (candidate.herdr.session, candidate.herdr.pane, notice);
    return "reached" as const;
  } catch { return "failed" as const; }
}

async function inspectMain(root: string, seat: Seat, options: MainRepairOptions): Promise<MainRepairReport | undefined> {
  if (seat.role !== "main") return;
  const live = await readRuntimeState(root, seat.address);
  if (!live || isRuntimeStateStale(live, 60_000, options.now ?? new Date())) return;
  const candidate = onlySessionMismatch(seat, live);
  if (!candidate) return;
  const task = taskId(candidate);
  try {
    if (!await confirm(root, candidate, options.inspect ?? inspectHerdr))
      return { seat: seat.address, task, outcome: "unverified" };
    if (options.dryRun) return { seat: seat.address, task, outcome: "ready" };
    const fenced = await withOwnedRuntimeState(root, seat.address, live.owner_token, () => sendRepair(root, candidate, options));
    return { seat: seat.address, task, outcome: fenced.owned ? fenced.value : "unverified" };
  } catch { return { seat: seat.address, task, outcome: "unverified" }; }
}

/** Inspect only project mains and bypass inactive native mail through exact Herdr targeting. */
export async function reconcileMainMailRepairs(root: string, options: MainRepairOptions = {}): Promise<MainRepairReport[]> {
  const result: MainRepairReport[] = [];
  for (const projectName of await readdir(paths(root).work).catch(() => [] as string[])) {
    const file = paths(root).seatFile(`main@${projectName}`);
    const seat = await readYaml<Seat>(file).catch(() => undefined);
    if (!seat) continue;
    const repair = await inspectMain(root, seat, options);
    if (repair) result.push(repair);
  }
  return result;
}
