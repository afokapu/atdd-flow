// URN: component:flow:e004:pi-wake:backend:application
// Tested-By:
// - test:atdd-flow:fleet-model-swap-and-wake
// Runtime: bun
// Purpose: Wake live Herdr-bound Pi seats with /flow-wake, optionally swapping model.

import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { addressParts, canonicalAddress, modelPortfolio, paths, piModel, readYaml, type ModelPortfolio, type Seat } from "./core";
import { readRuntimeState } from "./runtime-state";
import { seatTasks, terminal } from "./tasks";
import {
  type TranscriptEntry, activeBranch, branchModel, customEntries, parseTranscript,
  wakeCapabilityType, wakeRequestType, wakeResultType, wakeStartType,
} from "./pi-wake-protocol";

export const wakeUsage = "Use `atdd-flow pi wake <seat>|--scope project|desk [--model-profile <name>] --by <authorized-seat>`.";

type Outcome = "woke" | "swapped+woke" | "deferred" | "refused" | "skipped" | "failed";
export type WakeRow = { seat: string; outcome: Outcome; detail?: string };
type Options = { target?: string; scope?: "project" | "desk"; profile?: string; by: string };
type Target = { provider: string; model: string };
/** What Herdr reports about the bound pane; nothing here is trusted until it matches the Desk and runtime records. */
type Pane = { agent?: string; status?: string; sessionPath?: string; pids: number[] };
type Ready = { session: string; pane: string; sessionId: string; sessionPath: string };
type Inspection = { row: WakeRow } | { ready: Ready };
type Prepared = { row: WakeRow } | { record: Seat; ready: Ready; inspectedAt: number };

const pollMs = 50;
/** A runtime heartbeat older than this is not a live Pi (the extension beats every 15 s). */
const heartbeatMs = 120_000;
/** An inspection this recent still describes the seat; an older one is repeated just before anything is sent. */
const freshMs = 2_000;

/** Every wait is bounded; the variable exists so fixtures that never answer fail quickly. */
const timeouts = () => {
  const configured = Number(process.env.ATDD_FLOW_WAKE_TIMEOUT_MS);
  const explicit = Number.isFinite(configured) && configured > 0 ? configured : undefined;
  // A bootstrap reload may start a full resumed-work turn; waiting for the seat to be idle again is bounded separately.
  return { step: explicit ?? 30_000, idle: explicit ?? 300_000 };
};
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const row = (seat: string, outcome: Outcome, detail?: string): WakeRow => ({ seat, outcome, ...(detail ? { detail } : {}) });
const hold = (seat: string, outcome: Outcome, detail: string): { row: WakeRow } => ({ row: row(seat, outcome, detail) });
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown) => typeof value === "string" ? value : undefined;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Polls until `read` yields a value or the bound elapses; one read always happens. */
async function until<T>(read: () => Promise<T | undefined>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await pause(pollMs);
  }
}

function flagsOf(args: string[]) {
  const flags = new Map<string, string>(), targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!, value = args[index + 1];
    if (!argument.startsWith("--")) targets.push(argument);
    else if (["--scope", "--model-profile", "--by"].includes(argument) && value && !value.startsWith("--") && !flags.has(argument)) { flags.set(argument, value); index += 1; }
    else throw new Error(wakeUsage);
  }
  return { flags, targets };
}

/** The grammar is closed: exactly one of a seat or --scope, one --by, and an optional profile. */
export function parseWakeArguments(args: string[]): Options {
  const { flags, targets } = flagsOf(args);
  const scope = flags.get("--scope"), by = flags.get("--by"), profile = flags.get("--model-profile");
  if (!by || targets.length + (scope ? 1 : 0) !== 1) throw new Error(wakeUsage);
  if (scope && scope !== "project" && scope !== "desk") throw new Error(wakeUsage);
  return { ...(targets[0] ? { target: targets[0] } : {}), ...(scope ? { scope } : {}), ...(profile ? { profile } : {}), by };
}

async function herdr(session: string, ...args: string[]) {
  const child = Bun.spawn(["herdr", "--session", session, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  return stdout;
}

/** Herdr pane metadata plus foreground processes; read-only. */
async function observe(session: string, pane: string): Promise<Pane> {
  const [paneRaw, processRaw] = await Promise.all([herdr(session, "pane", "get", pane), herdr(session, "pane", "process-info", "--pane", pane)]);
  const info = object(object(object(JSON.parse(paneRaw))?.result)?.pane);
  const processResult = object(object(JSON.parse(processRaw))?.result);
  const processes = object(processResult?.process_info)?.foreground_processes;
  const sessionInfo = object(info?.agent_session);
  return {
    ...(text(info?.agent) ? { agent: text(info?.agent) } : {}),
    ...(text(info?.agent_status) ? { status: text(info?.agent_status) } : {}),
    ...(sessionInfo?.kind === "path" && text(sessionInfo.value) ? { sessionPath: text(sessionInfo.value) } : {}),
    pids: (Array.isArray(processes) ? processes : []).flatMap((entry) => typeof object(entry)?.pid === "number" ? [object(entry)!.pid as number] : []),
  };
}

/** The transcript's active branch: the chain from the newest entry, excluding abandoned siblings. */
const readBranch = async (path: string) => activeBranch(parseTranscript(await readFile(path, "utf8")));

/** Resolve a profile mapping for the seat's current model. `{}` means wake without a swap. */
function resolveSwap(portfolio: ModelPortfolio, profile: string, branch: TranscriptEntry[]): { candidate?: string; target?: Target } | { refused: string } {
  const current = branchModel(branch);
  if (!current) return { refused: "no model recorded in the transcript" };
  const migration = portfolio.model_migrations?.[profile] ?? {};
  const exact = (id: string) => { const candidate = portfolio.models.find((entry) => entry.id === id); return candidate && piModel(candidate); };
  const same = (target?: Target) => target?.provider === current.provider && target.model === current.model;
  const id = migration[`${current.provider}/${current.model}`];
  // A seat already on a mapped target needs no swap, which makes a partly applied fleet run safe to repeat.
  if (!id) return Object.values(migration).some((target) => same(exact(target))) ? {} : { refused: `no ${profile} migration for ${current.provider}/${current.model}` };
  const target = exact(id);
  return !target || same(target) ? {} : { candidate: id, target };
}

function bindingOf(record: Seat) {
  const locator = record.runtime?.addresses.herdr;
  return record.runtime?.application === "herdr" && typeof locator === "object" && locator.session && locator.pane ? locator : undefined;
}

/** Why the live pane cannot be trusted as this seat's Pi, or undefined when it can. */
async function identityProblem(root: string, address: string, record: Seat, live: Pane) {
  const runtime = await readRuntimeState(root, address);
  if (!runtime || Date.now() - Date.parse(runtime.heartbeat_at) > heartbeatMs) return "no live Pi runtime heartbeat";
  const recorded = record.runtime;
  if (!recorded?.pi_session || !recorded.pi_session_path) return "seat records no exact Pi session";
  if (live.sessionPath !== recorded.pi_session_path) return "Herdr reports a different Pi session than the seat binding";
  return live.pids.includes(runtime.pid) ? undefined : "pane foreground process is not the registered Pi runtime";
}

/** Only idle/done is a safe boundary: working defers, any blocking UI or unknown state is refused. */
function boundary(address: string, status?: string) {
  if (status === "idle" || status === "done") return undefined;
  return status === "working" ? row(address, "deferred", "agent is working") : row(address, "refused", `agent is ${status ?? "in an unknown state"}`);
}

function absentAgent(live: Pane) {
  if (!live.agent) return "no agent in the bound pane";
  return live.agent === "pi" ? undefined : `bound pane runs ${live.agent}, not Pi`;
}

/** Read-only check that the seat's recorded pane, session and process are the live Pi at a safe boundary. */
async function inspect(root: string, address: string, record: Seat): Promise<Inspection> {
  const locator = bindingOf(record);
  if (!locator) return hold(address, "skipped", "no native Herdr binding");
  const live = await observe(locator.session, locator.pane).catch((error) => error as Error);
  if (live instanceof Error) return hold(address, "refused", `Herdr observation failed: ${live.message}`);
  const absent = absentAgent(live);
  if (absent) return hold(address, "skipped", absent);
  const problem = await identityProblem(root, address, record, live);
  if (problem) return hold(address, "refused", problem);
  const unsafe = boundary(address, live.status);
  if (unsafe) return { row: unsafe };
  return { ready: { session: locator.session, pane: locator.pane, sessionId: record.runtime!.pi_session!, sessionPath: record.runtime!.pi_session_path! } };
}

const capabilityOf = (branch: TranscriptEntry[], ready: Ready, address: string) =>
  customEntries(branch, wakeCapabilityType).filter((entry) => entry.data?.seat === address && entry.data.pi_session === ready.sessionId && entry.data.pane === ready.pane);

/** Classify one seat without sending anything; every non-eligible seat resolves to its final row. */
async function prepare(root: string, address: string, actor: string): Promise<Prepared> {
  if (address === actor) return hold(address, "skipped", "invoking seat");
  const record = await readYaml<Seat>(paths(root).seatFile(address)).catch(() => undefined);
  if (!record) return hold(address, "skipped", "no seat record");
  if (record.retired) return hold(address, "skipped", "retired");
  const assigned = await seatTasks(root, record.project, address).catch(() => []);
  if (assigned.length && assigned.every((entry) => terminal(entry.task))) return hold(address, "skipped", "all assigned tasks are terminal");
  const inspection = await inspect(root, address, record);
  return "row" in inspection ? inspection : { record, ready: inspection.ready, inspectedAt: Date.now() };
}

/**
 * A Pi that predates `/flow-wake` gets one `/reload` at a safe boundary; only a fresh capability entry proves it
 * loaded, and the seat must return to idle/done (the reload may start a normal startup turn) before the wake.
 */
async function bootstrap(root: string, address: string, record: Seat, ready: Ready, branch: TranscriptEntry[]): Promise<WakeRow | undefined> {
  const limit = timeouts(), known = new Set(customEntries(branch, wakeCapabilityType).map((entry) => entry.id));
  try { await herdr(ready.session, "agent", "prompt", ready.pane, "/reload"); }
  catch (error) { return row(address, "failed", message(error)); }
  const fresh = await until(async () => capabilityOf(await readBranch(ready.sessionPath), ready, address).some((entry) => !known.has(entry.id)) || undefined, limit.step);
  if (!fresh) return row(address, "failed", "no fresh flow-wake capability after /reload; the Flow extension did not activate");
  const settled = await until(async () => {
    const again = await inspect(root, address, record);
    return "row" in again && again.row.outcome === "deferred" ? undefined : again;
  }, limit.idle);
  if (!settled) return row(address, "failed", "seat did not return to idle/done after reload");
  return "row" in settled ? settled.row : undefined;
}

/** Dispatch one wake to an eligible seat and verify it from the seat's own transcript. */
async function wakeOne(root: string, address: string, prepared: Extract<Prepared, { record: Seat }>, portfolio: ModelPortfolio | undefined, profile: string | undefined): Promise<WakeRow> {
  const { record } = prepared;
  const inspection = Date.now() - prepared.inspectedAt <= freshMs ? { ready: prepared.ready } : await inspect(root, address, record);
  if ("row" in inspection) return inspection.row;
  const { ready } = inspection;
  const branch = await readBranch(ready.sessionPath).catch((error) => error as Error);
  if (branch instanceof Error) return row(address, "refused", `cannot read the Pi transcript: ${branch.message}`);
  const swap = profile ? resolveSwap(portfolio!, profile, branch) : {};
  if ("refused" in swap) return row(address, "refused", swap.refused);
  const unready = capabilityOf(branch, ready, address).length ? undefined : await bootstrap(root, address, record, ready, branch);
  if (unready) return unready;

  const requestId = `wake-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  try { await herdr(ready.session, "agent", "prompt", ready.pane, swap.candidate ? `/flow-wake ${swap.candidate} ${requestId}` : `/flow-wake ${requestId}`); }
  catch (error) { return row(address, "failed", message(error)); }
  return verify(ready.sessionPath, address, requestId, swap.target, timeouts().step);
}

type Verdict = { outcome: "failed"; detail: string } | { outcome: "woke" | "swapped+woke" };

/** A swap needs a native model change to exactly the target between request and result, and a result that says so. */
function modelProblem(span: TranscriptEntry[], result: Record<string, unknown>, target: Target | undefined) {
  const changed = span.filter((entry) => entry.type === "model_change").at(-1);
  if (!target) return changed ? "unexpected model change during a keep-model wake" : undefined;
  if (changed?.provider !== target.provider || changed.modelId !== target.model) return "no native model change to the requested target between request and result";
  const reported = object(result.target);
  return reported?.provider === target.provider && reported.model === target.model ? undefined : "result does not report the requested target";
}

/** Undefined until request, result and the one startup turn for this request id are all present in order. */
function judge(branch: TranscriptEntry[], requestId: string, target: Target | undefined): Verdict | undefined {
  const requestAt = branch.findIndex((entry) => entry.customType === wakeRequestType && entry.data?.request_id === requestId);
  const resultAt = branch.findIndex((entry, index) => index > requestAt && entry.customType === wakeResultType && entry.data?.request_id === requestId);
  if (requestAt < 0 || resultAt < 0) return undefined;
  const result = branch[resultAt]!.data!, expected = target ? "swapped+woke" : "woke";
  if (result.outcome === "failed") return { outcome: "failed", detail: text(result.reason) ?? "the seat reported a failed wake" };
  const problem = result.outcome === expected ? modelProblem(branch.slice(requestAt, resultAt), result, target) : `unexpected result outcome ${String(result.outcome)}`;
  if (problem) return { outcome: "failed", detail: problem };
  const started = branch.slice(resultAt).some((entry) => entry.customType === wakeStartType && entry.details?.request_id === requestId);
  return started ? { outcome: expected } : undefined;
}

/** Waits a bounded time for the complete handshake; whatever is missing is reported, never retried. */
async function verify(sessionPath: string, address: string, requestId: string, target: Target | undefined, timeoutMs: number): Promise<WakeRow> {
  const verdict = await until(async () => judge(await readBranch(sessionPath).catch(() => []), requestId, target), timeoutMs);
  if (verdict) return verdict.outcome === "failed" ? row(address, "failed", verdict.detail) : row(address, verdict.outcome);
  const branch = await readBranch(sessionPath).catch(() => []);
  const seen = [wakeRequestType, wakeResultType].filter((type) => branch.some((entry) => entry.customType === type && entry.data?.request_id === requestId));
  return row(address, "failed", `incomplete wake ${requestId}: observed ${seen.length ? seen.join(", ") : "nothing"}; not retried`);
}

async function seatAddresses(root: string, project: string) {
  const entries = await readdir(paths(root).seats(project), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => `${entry.name}@${project}`);
}

/** Authorization is by address: the operator may wake anything; a project main only its own project. */
async function targetAddresses(root: string, options: Options, actor: string) {
  const operator = actor === "operator@desk";
  if (options.target) {
    const target = await canonicalAddress(root, options.target), project = addressParts(target).project;
    if (!operator && actor !== `main@${project}`) throw new Error(`${actor} is not authorized to wake ${target}; use operator@desk or main@${project}.`);
    return [target];
  }
  if (options.scope === "desk") {
    if (!operator) throw new Error("Desk scope requires --by operator@desk.");
    const projects = await readdir(paths(root).work, { withFileTypes: true }).catch(() => []);
    return (await Promise.all(projects.filter((entry) => entry.isDirectory()).map((entry) => seatAddresses(root, entry.name)))).flat();
  }
  const { local, project } = addressParts(actor);
  if (local !== "main") throw new Error("Project scope requires --by main@<project>.");
  return seatAddresses(root, project);
}

/** Runs the closed `pi wake` grammar; reports each seat's row in lexical order as it completes. */
export async function wakePi(root: string, args: string[], report: (line: WakeRow) => void = () => undefined) {
  const options = parseWakeArguments(args);
  const actor = await canonicalAddress(root, options.by);
  const addresses = (await targetAddresses(root, options, actor)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const portfolio = options.profile ? await modelPortfolio(root) : undefined;
  if (options.profile && !portfolio?.model_migrations?.[options.profile]) throw new Error(`models.yaml declares no model_migrations profile ${options.profile}.`);

  // Classification is read-only and concurrent; anything that sends a prompt then runs one seat at a time in lexical order.
  const prepared = await Promise.all(addresses.map((address) => prepare(root, address, actor).catch((error) => hold(address, "failed", message(error)) as Prepared)));
  const rows: WakeRow[] = [];
  for (const [index, address] of addresses.entries()) {
    const ready = prepared[index]!;
    const outcome = "row" in ready ? ready.row : await wakeOne(root, address, ready, portfolio, options.profile).catch((error) => row(address, "failed", message(error)));
    rows.push(outcome);
    report(outcome);
  }
  // A named seat must be woken; a fleet is unsuccessful only when something was refused or failed.
  const woke = (entry: WakeRow) => entry.outcome === "woke" || entry.outcome === "swapped+woke";
  const success = options.target ? rows.every(woke) : rows.every((entry) => entry.outcome !== "refused" && entry.outcome !== "failed");
  return { rows, success };
}

export const formatWakeRow = (entry: WakeRow) => `${entry.seat}  ${entry.outcome}${entry.detail ? `  ${entry.detail}` : ""}`;
