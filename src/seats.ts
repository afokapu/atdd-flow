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

const defaultRoles = (dynamicModels = true): Record<string, Role> => ({
  coordinator: {
    address: "coordinator@{project}", branch: "main", worktree: "{repository}",
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
  const address = fill(role.address, entries);
  const configuredPath = role.worktree ? fill(role.worktree, { ...entries, repository: config.repository ?? "" }) : undefined;
  const worktree = resolve(required(words(args, "--worktree") ?? configuredPath, "--worktree or role worktree template"));
  const branch = words(args, "--branch") ?? fill(role.branch, { project: config.project, name });
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

export async function bind(root: string, address: string, args: string[], selectedModel?: string, wake?: Runtime["wake"], piSession?: string, launchReceipt?: string) {
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

export type HerdrPaneReport = { session: string; pane: string; state: string; pi_session?: string };
export type HerdrStartReport = { session: string; pane: string; pi_session: string };
type HerdrRequest = { session: string; pane: string; seat: string; root: string; piSession: string; args: string[] };
export type PiRuntimeLaunchDependencies = {
  select?: (input: ModelSelectionInput) => Promise<ModelSelectionResponse>;
  herdr?: {
    inspect: (session: string, pane: string) => Promise<HerdrPaneReport>;
    stop?: (request: Pick<HerdrRequest, "session" | "pane" | "piSession">) => Promise<void>;
    start: (request: HerdrRequest) => Promise<HerdrStartReport>;
  };
  sessionId?: () => string;
  at?: () => string;
};

async function inspectHerdrPane(session: string, pane: string): Promise<HerdrPaneReport> {
  const output = await runOutput(["herdr", "--session", session, "agent", "inspect", pane, "--json"]);
  try {
    const report = JSON.parse(output) as HerdrPaneReport;
    if (typeof report.session !== "string" || typeof report.pane !== "string" || typeof report.state !== "string") throw new Error("missing session, pane, or state");
    return report;
  } catch (error) {
    throw new Error(`Herdr did not report a usable pane: ${(error as Error).message}`);
  }
}

function herdrStartCommand(request: HerdrRequest) {
  return [
    "herdr", "--session", request.session, "agent", "start", `flow-${request.seat}`, "--kind", "pi", "--pane", request.pane, "--json",
    "--env", `ATDD_WORKFLOW_ROOT=${request.root}`, "--env", `ATDD_WORKFLOW_SEAT=${request.seat}`, "--",
    "--session", request.piSession, ...request.args,
  ];
}

async function startPiInHerdr(request: HerdrRequest): Promise<HerdrStartReport> {
  const output = await runOutput(herdrStartCommand(request));
  try {
    const report = JSON.parse(output) as HerdrStartReport;
    if (typeof report.session !== "string" || typeof report.pane !== "string" || typeof report.pi_session !== "string") throw new Error("missing session, pane, or Pi session");
    return report;
  } catch (error) {
    throw new Error(`Herdr did not verify the started Pi runtime: ${(error as Error).message}`);
  }
}

async function stopIdlePiInHerdr(request: Pick<HerdrRequest, "session" | "pane" | "piSession">) {
  // Deliberately stop only the agent. The named shell pane remains available
  // until the replacement has reported the exact requested session.
  await run(["herdr", "--session", request.session, "agent", "stop", "--pane", request.pane, "--session-id", request.piSession], true);
}

function receiptPath(root: string, piSession: string) {
  return join(root, ".atdd-flow", "runtime-launch", `${encodeURIComponent(piSession)}-${crypto.randomUUID().slice(0, 8)}.yaml`);
}

/** A deliberately narrow Pi+Herdr launch: an existing pane only, no pane lifecycle management. */
export async function launchPiRuntime(root: string, address: string, args: string[], dependencies: PiRuntimeLaunchDependencies = {}) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  const config = await desk(root);
  const pane = required(words(args, "--pane"), "--pane");
  const herdrSession = required(words(args, "--herdr-session"), "--herdr-session");
  const resume = args.includes("--resume");
  const dryRun = args.includes("--dry-run");
  if (args.some((argument) => !["--pane", pane, "--herdr-session", herdrSession, "--resume", "--dry-run"].includes(argument))) {
    throw new Error("Use `pi runtime launch <seat> --pane <existing-pane> --herdr-session <session> [--resume] [--dry-run]`.");
  }
  const portfolio = required(await modelPortfolio(root), "models.yaml for Pi runtime launch");
  const active = (await seatTasks(root, record.project, resolved)).filter((entry) => entry.task.status === "in_progress");
  if (!active.length) throw new Error(`${resolved} has no active bounded task; refusing runtime launch.`);
  const selection = await chooseLaunchModel(root, config, record, portfolio, dependencies.select);
  const command = resolveModelCommand(config, selection.candidate);
  if (basename(command.agent) !== "pi") throw new Error(`Pi runtime launch requires a Pi candidate, received ${selection.candidate.id}.`);
  const inspect = dependencies.herdr?.inspect ?? inspectHerdrPane;
  const start = dependencies.herdr?.start ?? startPiInHerdr;
  const observed = await inspect(herdrSession, pane);
  if (observed.session !== herdrSession || observed.pane !== pane) throw new Error("Herdr reported a different session or pane; refusing runtime launch.");
  const piSession = resume ? record.runtime?.pi_session : (dependencies.sessionId ?? (() => crypto.randomUUID()))();
  if (!piSession) throw new Error("Resume requires the exact Pi session stored on the seat.");
  if (resume) {
    if (observed.state !== "idle") throw new Error(`Resume requires an idle Pi session; Herdr reports ${observed.state}.`);
    if (observed.pi_session !== piSession) throw new Error("Herdr Pi session does not match the exact session stored on the seat.");
    const prior = record.runtime?.launch_receipt;
    if (!prior) throw new Error("Resume requires an existing Flow launch receipt.");
    try {
      const receipt = await readYaml<{ seat?: string; pi_session?: string }>(prior);
      if (receipt.seat !== resolved || receipt.pi_session !== piSession) throw new Error("receipt does not match seat/session");
    } catch (error) {
      throw new Error(`Resume requires a valid Flow launch receipt: ${(error as Error).message}`);
    }
  } else if (observed.state !== "available") {
    throw new Error(`New launch requires an available shell pane; Herdr reports ${observed.state}.`);
  }
  const receipt = receiptPath(root, piSession);
  const modelArgs = [...command.args, "--extension", piExtensionPath()];
  const startRequest: HerdrRequest = { session: herdrSession, pane, seat: resolved, root, piSession, args: modelArgs };
  const plan = {
    candidate: selection.candidate.id, piSession, pane, herdrSession, receipt, command: herdrStartCommand(startRequest),
    ...(dryRun ? { dryRun: true } : {}),
  };
  if (dryRun) return plan;
  const receiptRecord = {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: resolved, tasks: active.map((entry) => entry.id), candidate: selection.candidate.id,
    selection: selection.fallback
      ? { result: "fallback", reason: selection.fallback }
      : { result: "selected", confidence: selection.selection.confidence, ...(selection.selection.available && selection.selection.model ? { model: selection.selection.model } : {}) },
    pi_session: piSession, herdr_session: herdrSession, pane, created_at: dependencies.at?.() ?? now(),
  };
  await mkdir(dirname(receipt), { recursive: true });
  await writeFile(receipt, yaml.print(receiptRecord), { encoding: "utf8", flag: "wx" });
  if (resume) await (dependencies.herdr?.stop ?? stopIdlePiInHerdr)({ session: herdrSession, pane, piSession });
  const verified = await start(startRequest);
  if (verified.session !== herdrSession || verified.pane !== pane || verified.pi_session !== piSession) {
    throw new Error("Herdr did not verify the exact requested Pi session; seat binding was not changed.");
  }
  await bind(root, resolved, ["--application", "herdr", "--address", pane, "--session", herdrSession], selection.candidate.id, "native", piSession, receipt);
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
}
