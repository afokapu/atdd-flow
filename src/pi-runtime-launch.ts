// URN: component:flow:e003:pi-runtime-launch:backend:integration
// Tested-By:
// - test:atdd-flow:context-handover-session-replacement
// Runtime: bun
// Purpose: Execute generic, exact Pi/Herdr runtime launch mechanics for seats.

/**
 * This module owns only generic launch mechanics shared by driver, coordinator,
 * and Path-A main seats. Seat policy remains in seats and handover modules.
 *
 * The sequence is deliberately fail-closed:
 * - resolve the canonical seat and one eligible task;
 * - select an installed Pi model;
 * - project and inspect exactly one Herdr pane;
 * - refuse any occupied pane before process start;
 * - verify the reported Pi session, JSONL path, pane and agent;
 * - persist a create-only receipt; then bind the seat through the injected writer.
 *
 * The injected bind callback keeps this orchestration independent of seat
 * mutation while preserving the public seats API and avoiding an import cycle.
 * It does not stop a source, attach a terminal, apply a multiplexer, or select
 * recipients. Path-A source/authorization policy is validated before this
 * module is invoked and appears only as receipt provenance.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { type Desk, type ModelCandidate, type ModelPortfolio, type Runtime, type Seat, atomicYaml, canonicalAddress, desk, exists, fill, modelPortfolio, now, paths, project, readYaml, required, runOutput, seat, words, yaml } from "./core";
import { type ModelSelectionInput, type ModelSelectionResponse, selectModel } from "./judgment";
import { type Task, seatTasks, terminal } from "./tasks";
import { projectHerdrSeat } from "./multiplexer";
import { resolveExactSessionAdoptionAuthorization } from "./adoption-authorizations";
import { assertReplacementTarget, replacementForMainLaunch } from "./handover";

export type PiRuntimeLaunchDependencies = {
  select?: (input: ModelSelectionInput) => Promise<ModelSelectionResponse>;
  command?: (command: string[]) => Promise<string>;
  sessionId?: () => string;
  at?: () => string;
  /** Pause between session-path polls; injectable so tests need no real delay. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** How long Herdr may take to report the exact session path after start. */
  sessionPathWindowMs?: number;
};

type Bind = (root: string, address: string, args: string[], selectedModel?: string, wake?: Runtime["wake"], piSession?: string, piSessionPath?: string, launchReceipt?: string) => Promise<void>;

export function availableModelCandidates(config: Desk, portfolio: ModelPortfolio) {
  return portfolio.models.filter((candidate) => {
    if (candidate.enabled === false) return false;
    const executable = config.executables?.[candidate.executable] ?? candidate.executable;
    return executable.includes("/") ? existsSync(executable) : Boolean(Bun.which(executable));
  });
}

export function resolveModelCommand(config: Desk, candidate: ModelCandidate) {
  return { agent: config.executables?.[candidate.executable] ?? candidate.executable, args: candidate.args ?? [] };
}

async function hasUniqueCoordinatorPlacement(root: string, record: Seat, expectedWorktree: string) {
  try {
    const peers = await Promise.all((await readdir(paths(root).seats(record.project))).map(async (name) => {
      try { return await readYaml<Seat>(join(paths(root).seats(record.project), name, "seat.yaml")); }
      catch { return undefined; }
    }));
    return !peers.some((peer) => peer && peer.address !== record.address && peer.role === "coordinator"
      && (peer.branch === record.branch || resolve(peer.worktree) === expectedWorktree));
  } catch { return false; }
}

function namedCoordinatorStream(config: Awaited<ReturnType<typeof project>>, record: Seat, address: string) {
  if (record.address !== address || record.role !== "coordinator") return undefined;
  const role = config.roles.coordinator;
  if (!config.repository || !role?.worktree) return undefined;
  if (role.address !== "coordinator.{name}@{project}" || role.branch !== "integration/{name}") return undefined;
  const local = record.address.slice(0, -`@${config.project}`.length);
  return local.match(/^coordinator\.([a-z0-9_-]+)$/)?.[1];
}

async function namedCoordinatorWorktree(root: string, record: Seat, address: string) {
  const config = await project(root, record.project);
  const stream = namedCoordinatorStream(config, record, address);
  if (!stream || !config.repository || !config.roles.coordinator?.worktree) return undefined;
  const worktree = resolve(fill(config.roles.coordinator.worktree, {
    project: config.project, name: stream, worktree_root: config.worktree_root ?? "", repository: config.repository,
  }));
  if (record.branch !== `integration/${stream}` || resolve(record.worktree) !== worktree) return undefined;
  return worktree !== resolve(config.repository) ? worktree : undefined;
}

async function isExactNamedCoordinator(root: string, record: Seat, address: string) {
  const worktree = await namedCoordinatorWorktree(root, record, address);
  return Boolean(worktree && await hasUniqueCoordinatorPlacement(root, record, worktree));
}

async function launchEligibleTasks(root: string, record: Seat, address: string) {
  const coordinator = await isExactNamedCoordinator(root, record, address);
  const tasks = await seatTasks(root, record.project, record.address);
  const eligible = await Promise.all(tasks.map(async (entry) => {
    const accountable = record.role === "driver" ? entry.task.assignee === record.address
      : coordinator && entry.task.coordinator === record.address;
    if (!accountable || entry.task.blocker) return undefined;
    if (entry.task.status === "in_progress") return entry;
    if (entry.task.status !== "todo") return undefined;
    const dependencies = await Promise.all((entry.task.depends_on ?? []).map(async (id) => {
      try { return terminal(await readYaml<{ status: Task["status"] }>(paths(root).taskFile(record.project, id))); }
      catch { return false; }
    }));
    return dependencies.every(Boolean) ? entry : undefined;
  }));
  return eligible.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

/** Fallback is the role's configured model when set (failing closed if unavailable), else the strongest candidate. */
function fallbackCandidate(config: Desk, role: string, candidates: ModelCandidate[], reason: string) {
  const configured = config.fallback_model?.[role];
  if (configured === undefined) return { candidate: candidates[0]! };
  const candidate = candidates.find((entry) => entry.id === configured);
  if (!candidate) throw new Error(`fallback_model.${role} names "${configured}", which is not an enabled model with an available executable in models.yaml; refusing launch.`);
  return { candidate, appliedFallback: { role, model: candidate.id, reason } };
}

async function chooseLaunchModel(root: string, config: Desk, record: Seat, portfolio: ModelPortfolio, select: (input: ModelSelectionInput) => Promise<ModelSelectionResponse> = selectModel) {
  const candidates = availableModelCandidates(config, portfolio);
  if (!candidates.length) throw new Error("No enabled model in models.yaml has an available executable.");
  const work = (await seatTasks(root, record.project, record.address)).filter((entry) => !terminal(entry.task));
  const selection = await select({
    seat: { address: record.address, role: record.role, ...(record.purpose ? { purpose: record.purpose } : {}) },
    tasks: work.map((entry) => ({
      id: entry.id,
      title: entry.task.title,
      status: entry.task.status,
      ...(entry.task.body ? { body: entry.task.body } : {}),
      doneWhen: entry.task.done_when.map((item) => item.text),
      ...(entry.task.blocker ? { blocker: entry.task.blocker } : {}),
    })),
    candidates,
  });
  if (!selection.available || selection.confidence < 0.75 || !candidates.some((entry) => entry.id === selection.selected_model)) {
    const reason = !selection.available ? selection.reason : selection.confidence < 0.75
      ? `Jev model selection confidence is low (${selection.confidence}).`
      : `Jev selected a model outside the available portfolio: ${selection.selected_model}.`;
    return { selection, fallback: reason, ...fallbackCandidate(config, record.role, candidates, reason) };
  }
  return { candidate: required(candidates.find((entry) => entry.id === selection.selected_model), `selected model ${selection.selected_model}`), selection };
}

/** Pi loads this extension inside its own process, so it can wake without host text injection. */
export const piExtensionPath = () => join(import.meta.dir, "..", "extensions", "pi", "index.ts");

type HerdrRequest = { session: string; pane: string; seat: string; root: string; piSession: string; sessionPath?: string; resume: boolean; args: string[] };
type Command = (command: string[]) => Promise<string>;
type PaneReport = { pane: string; agent?: string; status?: string; sessionPath?: string };
type ProcessReport = { shell?: number; processes: Array<{ name?: string; argv0?: string; cmdline?: string }> };

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown) => typeof value === "string" ? value : undefined;
const number = (value: unknown) => typeof value === "number" ? value : undefined;
function result(value: unknown) { const root = object(value); return object(root?.result) ?? root; }
function paneReport(value: unknown): PaneReport {
  const pane = object(result(value)?.pane) ?? result(value);
  const session = object(pane?.agent_session);
  const id = text(pane?.pane_id);
  if (!id) throw new Error("Herdr pane get did not report a pane id.");
  return {
    pane: id,
    ...(text(pane?.agent) ? { agent: text(pane?.agent) } : {}),
    ...(text(pane?.agent_status) ? { status: text(pane?.agent_status) } : {}),
    ...(session?.kind === "path" && text(session.value) ? { sessionPath: text(session.value) } : {}),
  };
}
function processReport(value: unknown): ProcessReport {
  const report = object(result(value)?.process_info) ?? result(value);
  const processes = Array.isArray(report?.foreground_processes) ? report.foreground_processes.flatMap((entry) => {
    const process = object(entry);
    return process ? [{ name: text(process.name), argv0: text(process.argv0), cmdline: text(process.cmdline) }] : [];
  }) : [];
  return { ...(number(report?.shell_pid) ? { shell: number(report?.shell_pid) } : {}), processes };
}
function agentReport(value: unknown) {
  const agent = object(result(value)?.agent) ?? result(value);
  const name = text(agent?.name);
  const pane = text(agent?.pane_id);
  if (!name || !pane) throw new Error("Herdr agent get did not report agent name and pane id.");
  return { name, pane, status: text(agent?.agent_status) ?? text(agent?.status) ?? text(agent?.state) };
}
function piProcess(processes: ProcessReport["processes"]) {
  return processes.find((entry) => entry.name === "pi" || entry.argv0?.endsWith("/pi") || entry.argv0 === "pi" || /(^|\/)pi(?:\s|$)/.test(entry.cmdline ?? ""));
}
/** Pi's durable JSONL session filenames end in `_<session-id>.jsonl`. */
function sessionIdFromPiJsonlPath(path: string) {
  const match = basename(path).match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  if (!match) throw new Error("Herdr did not report a Pi JSONL path with a documented session ID.");
  return match[1]!;
}
function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function agentName(address: string) { return `flow-${address.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`.slice(0, 32); }
function herdr(session: string, ...args: string[]) { return ["herdr", "--session", session, ...args]; }
function startCommand(request: HerdrRequest) {
  const session = request.resume ? ["--session", required(request.sessionPath, "a previously verified Pi session path")] : ["--session-id", request.piSession];
  return herdr(request.session, "agent", "start", agentName(request.seat), "--kind", "pi", "--pane", request.pane, "--", ...session, ...request.args);
}
function receiptPath(root: string, piSession: string) { return join(root, ".atdd-flow", "runtime-launch", `${encodeURIComponent(piSession)}-${crypto.randomUUID().slice(0, 8)}.yaml`); }

async function immutableSessionBackup(root: string, sessionPath: string, piSession: string) {
  const content = await readFile(sessionPath);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const backup = join(root, ".atdd-flow", "runtime-launch", "backups", `${encodeURIComponent(piSession)}-${crypto.randomUUID()}.jsonl`);
  await mkdir(dirname(backup), { recursive: true });
  await writeFile(backup, content, { flag: "wx" });
  return { backup, sha256 };
}

/** Validated CLI intent kept separate from runtime discovery and side effects. */
type LaunchOptions = {
  requestedPane?: string;
  herdrSession: string;
  resume: boolean;
  dryRun: boolean;
  adoptedSessionPath?: string;
  sourceHerdrSession?: string;
  sourcePane?: string;
  authorization?: string;
  adopting: boolean;
};

type PreparedLaunch = Awaited<ReturnType<typeof prepareLaunch>>;
type LaunchPlan = ReturnType<typeof buildLaunchPlan>;

function optionalArgument(name: string, value?: string) { return value ? [name, value] : []; }

/** Parse the closed launch grammar before reading or changing external state. */
function parseLaunchOptions(args: string[]): LaunchOptions {
  const requestedPane = words(args, "--pane");
  const herdrSession = required(words(args, "--herdr-session"), "--herdr-session");
  const resume = args.includes("--resume"), dryRun = args.includes("--dry-run");
  const adoptedSessionPath = words(args, "--adopt-session");
  const sourceHerdrSession = words(args, "--source-herdr-session"), sourcePane = words(args, "--source-pane");
  const authorization = words(args, "--authorization");
  const adoptionFields = [adoptedSessionPath, sourceHerdrSession, sourcePane, authorization];
  const adopting = adoptionFields.some(Boolean);
  const allowed = ["--herdr-session", herdrSession, "--resume", "--dry-run", ...optionalArgument("--pane", requestedPane),
    ...optionalArgument("--adopt-session", adoptedSessionPath), ...optionalArgument("--source-herdr-session", sourceHerdrSession),
    ...optionalArgument("--source-pane", sourcePane), ...optionalArgument("--authorization", authorization)];
  if (args.some((argument) => !allowed.includes(argument))) throw new Error("Use `pi runtime launch <seat> [--pane <asserted-pane>] --herdr-session <session> [--resume] [--dry-run] [--adopt-session <exact-jsonl> --source-herdr-session <session> --source-pane <pane> --authorization <owner-reference>]`.");
  if (adopting && (resume || !adoptionFields.every(Boolean))) throw new Error("Exact-session adoption requires --adopt-session, --source-herdr-session, --source-pane, and --authorization without --resume.");
  return { requestedPane, herdrSession, resume, dryRun, adoptedSessionPath, sourceHerdrSession, sourcePane, authorization, adopting };
}

/** Legacy resume is constrained to the seat's already-recorded Herdr location. */
function existingPaneForResume(record: Seat, options: LaunchOptions) {
  const existingHerdr = record.runtime?.addresses.herdr;
  const pane = typeof existingHerdr === "object" ? existingHerdr.pane : undefined;
  const session = typeof existingHerdr === "object" ? existingHerdr.session : undefined;
  if (options.resume && ((options.requestedPane && options.requestedPane !== pane) || options.herdrSession !== session)) {
    throw new Error("Resume cannot relocate a Pi session across a Herdr session or pane; use explicit exact-session adoption.");
  }
  return pane;
}

/** Preserve adopted and resumed identities; mint an ID only for a new launch. */
function launchSessionId(record: Seat, options: LaunchOptions, dependencies: PiRuntimeLaunchDependencies) {
  if (options.adopting) return sessionIdFromPiJsonlPath(required(options.adoptedSessionPath, "an exact adopted Pi session path"));
  if (options.resume) return record.runtime?.pi_session;
  return (dependencies.sessionId ?? (() => crypto.randomUUID()))();
}

/** Resolve authorization against the complete immutable source and target tuple. */
async function adoptionAuthorization(root: string, resolved: string, record: Seat, options: LaunchOptions, piSession: string, adoptedPath?: string) {
  if (!options.adopting) return undefined;
  return resolveExactSessionAdoptionAuthorization(root, required(options.authorization, "an immutable operator authorization record"), {
    seat: resolved, pi_session: piSession, pi_session_path: required(adoptedPath, "an exact adopted Pi session path"),
    source: { herdr_session: required(options.sourceHerdrSession, "a source Herdr session"), pane: required(options.sourcePane, "a source pane") },
    target: { herdr_session: options.herdrSession, pane: required(options.requestedPane, "--pane for exact-session adoption"), cwd: resolve(record.worktree) },
  });
}

/** Resolve launch policy inputs without projecting, starting, or binding a pane. */
async function prepareLaunch(root: string, address: string, args: string[], dependencies: PiRuntimeLaunchDependencies) {
  const resolved = await canonicalAddress(root, address), record = await seat(root, resolved), config = await desk(root);
  const options = parseLaunchOptions(args), existingPane = existingPaneForResume(record, options);
  const replacement = await replacementForMainLaunch(root, record, resolved);
  const active = replacement ? [{ id: replacement.request.task, task: replacement.task }] : await launchEligibleTasks(root, record, resolved);
  if (!active.length) throw new Error(`${resolved} has no launch-eligible task; refusing runtime launch.`);
  const selection = await chooseLaunchModel(root, config, record, required(await modelPortfolio(root), "models.yaml for Pi runtime launch"), dependencies.select);
  const model = resolveModelCommand(config, selection.candidate);
  if (basename(model.agent) !== "pi") throw new Error(`Pi runtime launch requires a Pi candidate, received ${selection.candidate.id}.`);
  const command = dependencies.command ?? runOutput;
  const piSession = launchSessionId(record, options, dependencies);
  if (!piSession) throw new Error("Resume requires the exact Pi session stored on the seat.");
  const adoptedPath = options.adopting ? resolve(required(options.adoptedSessionPath, "an exact adopted Pi session path")) : undefined;
  const authorizationRecord = await adoptionAuthorization(root, resolved, record, options, piSession, adoptedPath);
  return { root, resolved, record, options, existingPane, replacement, active, selection, model, command, piSession, adoptedPath, authorizationRecord, dependencies };
}

/** Match the seat-scoped projection to all caller and replacement assertions. */
function assertProjectedPane(launch: PreparedLaunch, pane: string) {
  const { options, existingPane, replacement, record } = launch;
  if (options.resume && pane !== existingPane) throw new Error("Resume cannot relocate a Pi session across a Herdr session or pane; use explicit exact-session adoption.");
  if (options.requestedPane && options.requestedPane !== pane) throw new Error("The asserted --pane does not match the seat-scoped Herdr projection.");
  if (replacement) assertReplacementTarget(replacement.request, options.herdrSession, pane, record.worktree);
}

/** Require both Herdr metadata and process inspection to report a vacant target. */
async function assertVacantTarget(launch: PreparedLaunch, pane: string) {
  const { command, options } = launch;
  const [paneRaw, processRaw] = await Promise.all([
    command(herdr(options.herdrSession, "pane", "get", pane)),
    command(herdr(options.herdrSession, "pane", "process-info", "--pane", pane)),
  ]);
  const currentPane = paneReport(JSON.parse(paneRaw));
  if (currentPane.pane !== pane) throw new Error("Herdr reported a different pane; refusing runtime launch.");
  if (currentPane.agent || piProcess(processReport(JSON.parse(processRaw)).processes)) {
    throw new Error(options.resume ? "Resume requires the prior Pi to have exited and been released." : "New launch requires an available shell pane.");
  }
}

/** Resume only from a Flow receipt that names this exact runtime tuple. */
async function assertResumeReceipt(launch: PreparedLaunch, pane: string) {
  const { options, record, resolved, piSession } = launch;
  if (!options.resume) return;
  const prior = record.runtime?.launch_receipt;
  if (!prior) throw new Error("Resume requires an existing Flow launch receipt.");
  try {
    const receipt = await readYaml<{ seat?: string; pi_session?: string; pi_session_path?: string; herdr_session?: string; pane?: string }>(prior);
    if (receipt.seat !== resolved || receipt.pi_session !== piSession || receipt.pi_session_path !== record.runtime?.pi_session_path
      || receipt.herdr_session !== options.herdrSession || receipt.pane !== pane) throw new Error("receipt does not match seat/session/path/pane");
  } catch (error) { throw new Error(`Resume requires a valid Flow launch receipt: ${(error as Error).message}`); }
}

/** Select the immutable path that Herdr must report after a continued launch. */
function priorSessionPath(launch: PreparedLaunch) {
  if (launch.options.adopting) return required(launch.adoptedPath, "an exact adopted Pi session path");
  if (launch.options.resume) return required(launch.record.runtime?.pi_session_path, "a previously verified Pi session path");
  return undefined;
}

/** Recheck source release immediately before creating an adoption launch plan. */
async function assertAdoptionSourceReleased(launch: PreparedLaunch) {
  const { options, command } = launch;
  if (!options.adopting) return;
  const sourceSession = required(options.sourceHerdrSession, "a source Herdr session"), sourcePane = required(options.sourcePane, "a source pane");
  const [paneRaw, processRaw] = await Promise.all([
    command(herdr(sourceSession, "pane", "get", sourcePane)),
    command(herdr(sourceSession, "pane", "process-info", "--pane", sourcePane)),
  ]);
  const report = paneReport(JSON.parse(paneRaw));
  if (report.pane !== sourcePane || report.agent || piProcess(processReport(JSON.parse(processRaw)).processes)) {
    throw new Error("Exact-session adoption requires proof that the source Pi has exited and been released.");
  }
}

/** Materialize the exact command and receipt path shared by dry and live runs. */
function buildLaunchPlan(launch: PreparedLaunch, pane: string, sessionPath?: string) {
  const { root, resolved, options, piSession, model, selection } = launch;
  const request: HerdrRequest = { session: options.herdrSession, pane, seat: resolved, root, piSession,
    ...(sessionPath ? { sessionPath } : {}), resume: options.resume || options.adopting, args: [...model.args, "--extension", piExtensionPath()] };
  const plan = { candidate: selection.candidate.id, piSession, pane, herdrSession: options.herdrSession,
    receipt: receiptPath(root, piSession), command: startCommand(request), ...(options.dryRun ? { dryRun: true } : {}) };
  return { request, plan };
}

async function startRuntime(launch: PreparedLaunch, pane: string, request: HerdrRequest) {
  const { root, resolved, options, piSession, adoptedPath, command } = launch;
  // Snapshot is a pre-migration prerequisite: never start a target without its recovery copy.
  const relocation = options.adopting ? await immutableSessionBackup(root, required(adoptedPath, "an exact adopted Pi session path"), piSession) : undefined;
  await command(herdr(options.herdrSession, "pane", "run", pane, `export ATDD_WORKFLOW_ROOT=${shellQuote(root)} ATDD_WORKFLOW_SEAT=${shellQuote(resolved)} ATDD_FLOW_PI_SESSION=${shellQuote(piSession)} ATDD_FLOW_HERDR_SESSION=${shellQuote(options.herdrSession)} ATDD_FLOW_HERDR_PANE=${shellQuote(pane)}`));
  await command(startCommand(request));
  return relocation;
}

/** Bind only a documented Pi JSONL path with the requested immutable identity. */
function assertVerifiedSession(launch: PreparedLaunch, verifiedPane: PaneReport, priorPath?: string) {
  const sessionPath = verifiedPane.sessionPath;
  if (!sessionPath) throw new Error("Herdr did not report an exact Pi session path; seat binding was not changed.");
  if (sessionIdFromPiJsonlPath(sessionPath) !== launch.piSession) throw new Error("Herdr did not verify the exact requested Pi session ID; seat binding was not changed.");
  if ((launch.options.resume || launch.options.adopting) && sessionPath !== priorPath) throw new Error("Herdr did not verify the exact requested Pi session path; seat binding was not changed.");
  return sessionPath;
}

function assertVerifiedProcess(launch: PreparedLaunch, pane: string, agent: ReturnType<typeof agentReport>, verifiedPane: PaneReport, verifiedProcess: ReturnType<typeof piProcess>) {
  const statusVerified = [agent.status, verifiedPane.status].every((status) => status === "idle" || status === "done");
  if (agent.name !== agentName(launch.resolved) || agent.pane !== pane || !statusVerified || verifiedPane.pane !== pane || !verifiedProcess) {
    throw new Error("Herdr did not verify the replacement Pi process; seat binding was not changed.");
  }
}

const sessionPathPollMs = 250;
const defaultSessionPathWindowMs = 10_000;

async function readRuntimeReports(launch: PreparedLaunch, pane: string) {
  const { command, options, resolved } = launch;
  const [agentRaw, paneRaw, processRaw] = await Promise.all([
    command(herdr(options.herdrSession, "agent", "get", agentName(resolved))),
    command(herdr(options.herdrSession, "pane", "get", pane)),
    command(herdr(options.herdrSession, "pane", "process-info", "--pane", pane)),
  ]);
  return { agent: agentReport(JSON.parse(agentRaw)), verifiedPane: paneReport(JSON.parse(paneRaw)), verifiedProcess: piProcess(processReport(JSON.parse(processRaw)).processes) };
}

/**
 * Corroborate the started runtime through agent, pane, and process reports. Only an absent session path is
 * polled again, within a bounded window: Herdr may report it a moment after the process starts. Every other
 * mismatch, and a path still absent when the window ends, fails closed without changing the seat binding.
 */
async function verifyRuntime(launch: PreparedLaunch, pane: string, priorPath?: string) {
  const { dependencies } = launch;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const polls = Math.floor((dependencies.sessionPathWindowMs ?? defaultSessionPathWindowMs) / sessionPathPollMs);
  let reports = await readRuntimeReports(launch, pane);
  for (let poll = 0; poll < polls && !reports.verifiedPane.sessionPath; poll += 1) {
    await sleep(sessionPathPollMs);
    reports = await readRuntimeReports(launch, pane);
  }
  const sessionPath = assertVerifiedSession(launch, reports.verifiedPane, priorPath);
  assertVerifiedProcess(launch, pane, reports.agent, reports.verifiedPane, reports.verifiedProcess);
  return sessionPath;
}

function receiptSelection(launch: PreparedLaunch) {
  const { selection } = launch;
  if (selection.fallback) return { result: "fallback", reason: selection.fallback, ...(selection.appliedFallback ? { applied_fallback: selection.appliedFallback } : {}) };
  return { result: "selected", confidence: selection.selection.confidence,
    ...(selection.selection.available && selection.selection.model ? { model: selection.selection.model } : {}) };
}

/** Persist the verified receipt before delegating the final seat binding mutation. */
async function persistLaunch(launch: PreparedLaunch, plan: LaunchPlan["plan"], sessionPath: string, relocation: Awaited<ReturnType<typeof immutableSessionBackup>> | undefined, bind: Bind) {
  const { root, resolved, options, piSession, active, selection, replacement, authorizationRecord, dependencies } = launch;
  const receiptRecord = {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: resolved, tasks: active.map((entry) => entry.id), candidate: selection.candidate.id,
    selection: receiptSelection(launch), pi_session: piSession, pi_session_path: sessionPath, herdr_session: options.herdrSession, pane: plan.pane,
    ...(replacement ? { handover_replacement: { request: replacement.request, successor_session: piSession } } : {}),
    ...(relocation ? { relocation: { source_herdr_session: options.sourceHerdrSession, source_pane: options.sourcePane, authorization: authorizationRecord, backup: relocation.backup, backup_sha256: relocation.sha256 } } : {}),
    created_at: dependencies.at?.() ?? now(),
  };
  await mkdir(dirname(plan.receipt), { recursive: true });
  await writeFile(plan.receipt, yaml.print(receiptRecord), { encoding: "utf8", flag: "wx" });
  await bind(root, resolved, ["--application", "herdr", "--address", plan.pane, "--session", options.herdrSession], selection.candidate.id, "native", piSession, sessionPath, plan.receipt);
}

/** A deliberately narrow Pi+Herdr launch using only installed CLI commands on an existing shell pane. */
export async function launchPiRuntimeImplementation(root: string, address: string, args: string[], bind: Bind, dependencies: PiRuntimeLaunchDependencies = {}) {
  const launch = await prepareLaunch(root, address, args, dependencies);
  const pane = (await projectHerdrSeat(root, launch.resolved, launch.options.herdrSession, launch.command)).pane;
  assertProjectedPane(launch, pane);
  await assertVacantTarget(launch, pane);
  await assertResumeReceipt(launch, pane);
  const priorPath = priorSessionPath(launch);
  await assertAdoptionSourceReleased(launch);
  const { request, plan } = buildLaunchPlan(launch, pane, priorPath);
  if (launch.options.dryRun) return plan;
  const relocation = await startRuntime(launch, pane, request);
  const sessionPath = await verifyRuntime(launch, pane, priorPath);
  await persistLaunch(launch, plan, sessionPath, relocation, bind);
  return plan;
}
