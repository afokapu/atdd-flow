import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { discoverAddress, discoverHerdrLocator, notify } from "./adapters";
import {
  type Checkpoint, type Desk, type ModelCandidate, type ModelPortfolio, type Project, type Role, type Runtime, type Seat,
  atomicYaml, canonicalAddress, desk, exists, fill, migrateDesk, modelPortfolio, now, paths, project, readYaml,
  required, run, runOutput, runtimeAddress, seat, words, yaml,
} from "./core";
import { type ModelSelectionInput, type ModelSelectionResponse, selectModel } from "./judgment";
import { seatTasks } from "./tasks";
import { projectHerdrSeat } from "./multiplexer";

const lifecycleConventionPath = "conventions/atdd-workflow.workflow/atdd-workflow.workflow.lifecycle.convention.yaml";

const defaultRoles = (dynamicModels = true): Record<string, Role> => ({
  main: {
    address: "main@{project}", branch: "main", worktree: "{repository}",
    ...(dynamicModels ? {} : { agent: "pi" }),
  },
  coordinator: {
    address: "coordinator.{name}@{project}", branch: "integration/{name}", base: "main", worktree: "{worktree_root}/{name}",
    ...(dynamicModels ? {} : { agent: "pi" }),
  },
  driver: {
    address: "driver.{name}@{project}", branch: "delivery/{name}", base: "main", worktree: "{worktree_root}/{name}",
    ...(dynamicModels ? {} : { agent: "pi" }),
  },
});

const defaultExecutables = () => ({ pi: "pi" });
const defaultModels = (): ModelPortfolio => ({
  schema: "atdd-workflow/models/v1",
  models: [
    { id: "pi", executable: "pi", description: "Default coding runtime. Configure Pi model arguments here when local policy requires a specific model." },
  ],
});

/** Resolve the seat's named agent through the Desk-wide executable registry. */
export function resolveExecutable(config: Desk, agent: string) {
  return config.executables?.[agent] ?? agent;
}

export async function init(root: string, name: string, args: string[]) {
  if (await exists(paths(root).desk)) {
    throw new Error(`Desk registry already exists at ${paths(root).desk}; refusing to overwrite it. Use an existing Desk command, or choose a new directory.`);
  }
  const config = { schema: "atdd-workflow/desk/v1" as const, desk: name, application: "herdr", executables: defaultExecutables() };
  await Promise.all([mkdir(paths(root).work, { recursive: true }), mkdir(paths(root).threads, { recursive: true })]);
  await Promise.all([atomicYaml(paths(root).desk, config), atomicYaml(paths(root).models, defaultModels())]);
  if (args.includes("--git") && !await exists(join(root, ".git"))) await run(["git", "init", "--initial-branch=main", root]);
  console.log(`Initialized Desk ${root}`);
}

export async function migrate(root: string) {
  if (await migrateDesk(root)) console.log("Migrated legacy coordination registry to desk.yaml");
  else console.log("Desk registry already exists");
}

export async function initProject(root: string, name: string) {
  await desk(root);
  const config: Project = { schema: "atdd-workflow/project/v1", project: name, roles: defaultRoles(Boolean(await modelPortfolio(root))) };
  await mkdir(paths(root).seats(name), { recursive: true });
  await atomicYaml(paths(root).projectFile(name), config);
  console.log(`Initialized project ${name}`);
}

async function ensureWorktree(config: Project, role: Role, worktree: string, branch: string) {
  if (!config.repository || worktree === resolve(config.repository) || await exists(worktree)) return;
  await mkdir(dirname(worktree), { recursive: true });
  const ref = `refs/heads/${branch}`;
  const probe = Bun.spawn(["git", "-C", config.repository, "show-ref", "--verify", "--quiet", ref]);
  const branchExists = await probe.exited === 0;
  const command = branchExists
    ? ["git", "-C", config.repository, "worktree", "add", worktree, branch]
    : ["git", "-C", config.repository, "worktree", "add", "-b", branch, worktree, role.base ?? "HEAD"];
  await run(command, true);
}

export async function spawn(root: string, projectName: string, roleName: string, name: string, args: string[]) {
  const config = await project(root, projectName);
  const role = required(config.roles[roleName], `role ${roleName}`);
  const entries = { project: config.project, name, worktree_root: config.worktree_root ?? "" };
  // Retain the historical primary coordinator command for existing Desks while
  // new defaults make main@project the only new primary identity.
  const legacyPrimaryCoordinator = roleName === "coordinator" && name === "main"
    && role.address === "coordinator.{name}@{project}" && role.branch === "integration/{name}";
  const address = legacyPrimaryCoordinator ? `coordinator@${config.project}` : fill(role.address, entries);
  const configuredPath = legacyPrimaryCoordinator ? config.repository : role.worktree ? fill(role.worktree, { ...entries, repository: config.repository ?? "" }) : undefined;
  const worktree = resolve(required(words(args, "--worktree") ?? configuredPath, "--worktree or role worktree template"));
  const branch = words(args, "--branch") ?? (legacyPrimaryCoordinator ? "main" : fill(role.branch, { project: config.project, name }));
  const newMainDefaults = roleName === "main" && role.address === "main@{project}" && role.branch === "main";
  const newNamedCoordinatorDefaults = roleName === "coordinator" && !legacyPrimaryCoordinator
    && role.address === "coordinator.{name}@{project}" && role.branch === "integration/{name}";
  if (newMainDefaults && (branch !== "main" || (config.repository && worktree !== resolve(config.repository)))) {
    throw new Error(`Main seat main@${config.project} must use the declared primary main worktree and branch.`);
  }
  if (newNamedCoordinatorDefaults) {
    const expectedWorktree = resolve(fill(required(role.worktree, "named coordinator worktree template"), { ...entries, repository: config.repository ?? "" }));
    if (branch !== `integration/${name}` || worktree !== expectedWorktree) {
      throw new Error(`Named coordinator ${address} must use its declared integration/${name} branch and linked worktree.`);
    }
  }
  await ensureWorktree(config, role, worktree, branch);
  const purpose = words(args, "--purpose") ?? (role.purpose ? fill(role.purpose, entries) : undefined);
  const portfolio = await modelPortfolio(root);
  const requestedAgent = words(args, "--agent");
  if (portfolio && requestedAgent) throw new Error("--agent is a legacy pin and cannot be used when models.yaml owns model allocation.");
  const legacyAgent = portfolio ? undefined : requestedAgent ?? role.agent;
  const record: Seat = {
    schema: "atdd-workflow/seat/v2", address, role: roleName, project: config.project, worktree, branch,
    ...(legacyAgent ? { agent: legacyAgent } : {}), ...(purpose ? { purpose } : {}),
  };
  await atomicYaml(paths(root).seatFile(address), record);
  console.log(address);
}

export async function bind(root: string, address: string, args: string[], selectedModel?: string, wake?: Runtime["wake"], piSession?: string, piSessionPath?: string, launchReceipt?: string) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  const config = await desk(root);
  const application = words(args, "--application") ?? config.application;
  const requestedAgent = words(args, "--agent");
  const requestedWorktree = words(args, "--worktree");
  const requestedWake = words(args, "--wake");
  if (requestedWake && requestedWake !== "host" && requestedWake !== "native") throw new Error("Wake must be host or native.");
  const selectedWake = wake ?? requestedWake as Runtime["wake"] | undefined;
  if (!/^[a-z][a-z0-9_-]*$/.test(application)) throw new Error(`Application must use lowercase letters, numbers, underscores, or hyphens: ${application}`);
  const nativeAddress = required(words(args, "--address"), "--address");
  const requestedSession = words(args, "--session");
  const addresses = record.runtime?.addresses ?? {};
  const runtimeBinding = application === "herdr" && requestedSession ? { session: requestedSession, pane: nativeAddress } : nativeAddress;
  record.runtime = {
    ...record.runtime,
    application,
    addresses: { ...addresses, [application]: runtimeBinding },
    attached_at: now(),
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(selectedWake ? { wake: selectedWake } : {}),
    ...(piSession ? { pi_session: piSession } : {}),
    ...(piSessionPath ? { pi_session_path: piSessionPath } : {}),
    ...(launchReceipt ? { launch_receipt: launchReceipt } : {}),
  };
  // Legacy Desks use this field as the executable chosen by a later `launch`.
  // Keep it aligned when an existing seat is deliberately re-homed to Pi.
  if (requestedAgent) record.agent = requestedAgent;
  if (requestedWorktree) {
    const worktree = resolve(requestedWorktree);
    if (!existsSync(worktree)) throw new Error(`Worktree does not exist: ${worktree}`);
    record.worktree = worktree;
  }
  await atomicYaml(paths(root).seatFile(resolved), record);
  console.log(`Bound ${resolved} to ${application}:${nativeAddress}`);
}

export async function useApplication(root: string, address: string, application: string) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  const runtime = required(record.runtime, `a runtime binding for ${resolved}`);
  const stored = runtime.addresses[application];
  if (!stored) throw new Error(`${resolved} has no ${application} address. Bind it first.`);
  record.runtime = { ...runtime, application, attached_at: now() };
  await atomicYaml(paths(root).seatFile(resolved), record);
  const locator = runtimeAddress(application, stored, (await desk(root)).herdr_session);
  console.log(`Using ${application}:${locator.session ? `${locator.session}/` : ""}${locator.address} for ${resolved}`);
}

export async function attach(root: string, address: string, args: string[]) {
  const application = words(args, "--application") ?? (await desk(root)).application;
  const nativeAddress = discoverAddress(application);
  const wake = words(args, "--wake");
  const session = application === "herdr" ? discoverHerdrLocator().session : undefined;
  await bind(root, address, ["--application", application, "--address", nativeAddress, ...(session ? ["--session", session] : []), ...(wake ? ["--wake", wake] : [])]);
}

export function availableModelCandidates(config: Desk, portfolio: ModelPortfolio) {
  return portfolio.models.filter((candidate) => {
    if (candidate.enabled === false) return false;
    const executable = resolveExecutable(config, candidate.executable);
    return executable.includes("/") ? existsSync(executable) : Boolean(Bun.which(executable));
  });
}

export function resolveModelCommand(config: Desk, candidate: ModelCandidate) {
  return { agent: resolveExecutable(config, candidate.executable), args: candidate.args ?? [] };
}

async function launchEligibleTasks(root: string, record: Seat) {
  const tasks = await seatTasks(root, record.project, record.address);
  const eligible = await Promise.all(tasks.map(async (entry) => {
    if (entry.task.assignee !== record.address || entry.task.blocker) return undefined;
    if (entry.task.status === "in_progress") return entry;
    if (entry.task.status !== "todo") return undefined;
    const dependencies = await Promise.all((entry.task.depends_on ?? []).map(async (id) => {
      try { return (await readYaml<{ status?: string }>(paths(root).taskFile(record.project, id))).status === "done"; }
      catch { return false; }
    }));
    return dependencies.every(Boolean) ? entry : undefined;
  }));
  return eligible.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

async function chooseLaunchModel(root: string, config: Desk, record: Seat, portfolio: ModelPortfolio, select: (input: ModelSelectionInput) => Promise<ModelSelectionResponse> = selectModel) {
  const candidates = availableModelCandidates(config, portfolio);
  if (!candidates.length) throw new Error("No enabled model in models.yaml has an available executable.");
  const work = (await seatTasks(root, record.project, record.address)).filter((entry) => entry.task.status !== "done");
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
    return { candidate: candidates[0]!, selection, fallback: reason };
  }
  return { candidate: required(candidates.find((entry) => entry.id === selection.selected_model), `selected model ${selection.selected_model}`), selection };
}

/** Pi loads this extension inside its own process, so it can wake without host text injection. */
export const piExtensionPath = () => join(import.meta.dir, "..", "extensions", "pi", "index.ts");

type HerdrRequest = { session: string; pane: string; seat: string; root: string; piSession: string; sessionPath?: string; resume: boolean; args: string[] };
type Command = (command: string[]) => Promise<string>;
export type PiRuntimeLaunchDependencies = {
  select?: (input: ModelSelectionInput) => Promise<ModelSelectionResponse>;
  command?: Command;
  sessionId?: () => string;
  at?: () => string;
};

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

/** A deliberately narrow Pi+Herdr launch using only installed CLI commands on an existing shell pane. */
export async function launchPiRuntime(root: string, address: string, args: string[], dependencies: PiRuntimeLaunchDependencies = {}) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  const config = await desk(root);
  const requestedPane = words(args, "--pane");
  const herdrSession = required(words(args, "--herdr-session"), "--herdr-session");
  const resume = args.includes("--resume");
  const dryRun = args.includes("--dry-run");
  const allowed = ["--herdr-session", herdrSession, "--resume", "--dry-run", ...(requestedPane ? ["--pane", requestedPane] : [])];
  if (args.some((argument) => !allowed.includes(argument))) throw new Error("Use `pi runtime launch <seat> [--pane <asserted-pane>] --herdr-session <session> [--resume] [--dry-run]`.");
  const active = await launchEligibleTasks(root, record);
  if (!active.length) throw new Error(`${resolved} has no launch-eligible task; refusing runtime launch.`);
  const selection = await chooseLaunchModel(root, config, record, required(await modelPortfolio(root), "models.yaml for Pi runtime launch"), dependencies.select);
  const model = resolveModelCommand(config, selection.candidate);
  if (basename(model.agent) !== "pi") throw new Error(`Pi runtime launch requires a Pi candidate, received ${selection.candidate.id}.`);
  const command = dependencies.command ?? runOutput;
  const projection = await projectHerdrSeat(root, resolved, herdrSession, command);
  if (requestedPane && requestedPane !== projection.pane) throw new Error("The asserted --pane does not match the seat-scoped Herdr projection.");
  const pane = projection.pane;
  const [paneRaw, processRaw] = await Promise.all([command(herdr(herdrSession, "pane", "get", pane)), command(herdr(herdrSession, "pane", "process-info", "--pane", pane))]);
  const currentPane = paneReport(JSON.parse(paneRaw));
  const currentProcess = processReport(JSON.parse(processRaw));
  if (currentPane.pane !== pane) throw new Error("Herdr reported a different pane; refusing runtime launch.");
  if (currentPane.agent || piProcess(currentProcess.processes)) throw new Error(resume ? "Resume requires the prior Pi to have exited and been released." : "New launch requires an available shell pane.");
  const piSession = resume ? record.runtime?.pi_session : (dependencies.sessionId ?? (() => crypto.randomUUID()))();
  if (!piSession) throw new Error("Resume requires the exact Pi session stored on the seat.");
  if (resume) {
    const prior = record.runtime?.launch_receipt;
    if (!prior) throw new Error("Resume requires an existing Flow launch receipt.");
    try {
      const receipt = await readYaml<{ seat?: string; pi_session?: string; pi_session_path?: string; herdr_session?: string; pane?: string }>(prior);
      if (receipt.seat !== resolved || receipt.pi_session !== piSession || receipt.pi_session_path !== record.runtime?.pi_session_path || receipt.herdr_session !== herdrSession || receipt.pane !== pane) throw new Error("receipt does not match seat/session/path/pane");
    } catch (error) { throw new Error(`Resume requires a valid Flow launch receipt: ${(error as Error).message}`); }
  }
  const priorSessionPath = resume ? required(record.runtime?.pi_session_path, "a previously verified Pi session path") : undefined;
  const request: HerdrRequest = { session: herdrSession, pane, seat: resolved, root, piSession, ...(priorSessionPath ? { sessionPath: priorSessionPath } : {}), resume, args: [...model.args, "--extension", piExtensionPath()] };
  const plan = { candidate: selection.candidate.id, piSession, pane, herdrSession, receipt: receiptPath(root, piSession), command: startCommand(request), ...(dryRun ? { dryRun: true } : {}) };
  if (dryRun) return plan;
  await command(herdr(herdrSession, "pane", "run", pane, `export ATDD_WORKFLOW_ROOT=${shellQuote(root)} ATDD_WORKFLOW_SEAT=${shellQuote(resolved)} ATDD_FLOW_PI_SESSION=${shellQuote(piSession)} ATDD_FLOW_HERDR_SESSION=${shellQuote(herdrSession)} ATDD_FLOW_HERDR_PANE=${shellQuote(pane)}`));
  await command(startCommand(request));
  const [agentRaw, verifiedPaneRaw, verifiedProcessRaw] = await Promise.all([command(herdr(herdrSession, "agent", "get", agentName(resolved))), command(herdr(herdrSession, "pane", "get", pane)), command(herdr(herdrSession, "pane", "process-info", "--pane", pane))]);
  const agent = agentReport(JSON.parse(agentRaw));
  const verifiedPane = paneReport(JSON.parse(verifiedPaneRaw));
  const verifiedProcess = piProcess(processReport(JSON.parse(verifiedProcessRaw)).processes);
  const sessionPath = verifiedPane.sessionPath;
  if (!sessionPath) throw new Error("Herdr did not report an exact Pi session path; seat binding was not changed.");
  const reportedId = sessionIdFromPiJsonlPath(sessionPath);
  if (reportedId !== piSession) throw new Error("Herdr did not verify the exact requested Pi session ID; seat binding was not changed.");
  if (resume && sessionPath !== record.runtime?.pi_session_path) throw new Error("Herdr did not verify the exact requested Pi session path; seat binding was not changed.");
  if (agent.name !== agentName(resolved) || agent.pane !== pane || ![agent.status, verifiedPane.status].every((status) => status === "idle" || status === "done") || verifiedPane.pane !== pane || !verifiedProcess) throw new Error("Herdr did not verify the replacement Pi process; seat binding was not changed.");
  const receipt = plan.receipt;
  const receiptRecord = {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: resolved, tasks: active.map((entry) => entry.id), candidate: selection.candidate.id,
    selection: selection.fallback ? { result: "fallback", reason: selection.fallback } : { result: "selected", confidence: selection.selection.confidence, ...(selection.selection.available && selection.selection.model ? { model: selection.selection.model } : {}) },
    pi_session: piSession, pi_session_path: sessionPath, herdr_session: herdrSession, pane, created_at: dependencies.at?.() ?? now(),
  };
  await mkdir(dirname(receipt), { recursive: true });
  await writeFile(receipt, yaml.print(receiptRecord), { encoding: "utf8", flag: "wx" });
  await bind(root, resolved, ["--application", "herdr", "--address", pane, "--session", herdrSession], selection.candidate.id, "native", piSession, sessionPath, receipt);
  return plan;
}

export async function describe(root: string, address: string, args: string[]) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  record.purpose = required(words(args, "--purpose"), "--purpose");
  await atomicYaml(paths(root).seatFile(resolved), record);
  console.log(`Described ${resolved}`);
}

export async function checkpoint(root: string, address: string, args: string[]) {
  const resolved = await canonicalAddress(root, address);
  await seat(root, resolved);
  const references = words(args, "--references")?.split(",").filter(Boolean);
  const record: Checkpoint = {
    schema: "atdd-workflow/checkpoint/v1", seat: resolved,
    status: (words(args, "--status") ?? "active") as Checkpoint["status"], updated_at: now(),
    summary: required(words(args, "--summary"), "--summary"), next_action: required(words(args, "--next"), "--next"),
    ...(references?.length ? { references } : {}),
  };
  await atomicYaml(paths(root).checkpointFile(resolved), record);
  console.log(`Checkpointed ${resolved}`);
}

export async function openSeat(root: string, address: string) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  console.log(yaml.print(record));
  // Keep the native pane visible to scripts and operators that consumed the
  // legacy scalar form while the durable record now carries its session too.
  const herdr = record.runtime?.addresses.herdr;
  if (herdr && typeof herdr !== "string") console.log(`herdr: ${herdr.pane} (session: ${herdr.session})`);
  const checkpointFile = paths(root).checkpointFile(resolved);
  if (await exists(checkpointFile)) console.log(yaml.print(await readYaml<Checkpoint>(checkpointFile)));
  const threadIds = await readdir(paths(root).threads);
  for (const threadId of threadIds) {
    const file = paths(root).threadFile(threadId);
    if (!await exists(file)) continue;
    const entry = await readYaml<{ participants: string[]; state: string; subject: string }>(file);
    if (entry.participants.includes(resolved)) console.log(`${threadId}  ${entry.state}  ${entry.subject}`);
  }
  console.log(`Convention: ${lifecycleConventionPath}`);
}
