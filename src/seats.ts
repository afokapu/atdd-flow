import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { discoverAddress, launchedAddress, launchCommand, notify } from "./adapters";
import {
  type Checkpoint, type Desk, type ModelCandidate, type ModelPortfolio, type Project, type Role, type Runtime, type Seat,
  atomicYaml, canonicalAddress, desk, exists, fill, migrateDesk, modelPortfolio, now, paths, project, readYaml,
  required, run, runOutput, seat, words, yaml,
} from "./core";
import { selectModel } from "./judgment";
import { seatTasks } from "./tasks";

const defaultRoles = (dynamicModels = true): Record<string, Role> => ({
  coordinator: {
    address: "coordinator@{project}", branch: "main", worktree: "{repository}",
    ...(dynamicModels ? {} : { agent: "claude" }),
  },
  driver: {
    address: "driver.{name}@{project}", branch: "delivery/{name}", base: "main", worktree: "{worktree_root}/{name}",
    ...(dynamicModels ? {} : { agent: "codex" }),
  },
});

const defaultExecutables = () => ({ claude: "claude", codex: "codex", pi: "pi", kimi: "kimi", glm: "glm" });
const defaultModels = (): ModelPortfolio => ({
  schema: "atdd-workflow/models/v1",
  models: [
    { id: "claude", executable: "claude", description: "Default high-capability candidate; replace or refine this portfolio for the local environment." },
    { id: "codex", executable: "codex", description: "Default lower-cost candidate." },
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
  const config = { schema: "atdd-workflow/desk/v1" as const, desk: name, application: "tuios", executables: defaultExecutables() };
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

export async function bind(root: string, address: string, args: string[], selectedModel?: string, wake?: Runtime["wake"]) {
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
  const addresses = record.runtime?.addresses ?? {};
  record.runtime = {
    ...record.runtime,
    application,
    addresses: { ...addresses, [application]: nativeAddress },
    attached_at: now(),
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(selectedWake ? { wake: selectedWake } : {}),
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
  if (!runtime.addresses[application]) throw new Error(`${resolved} has no ${application} address. Bind it first.`);
  record.runtime = { ...runtime, application, attached_at: now() };
  await atomicYaml(paths(root).seatFile(resolved), record);
  console.log(`Using ${application}:${record.runtime.addresses[application]} for ${resolved}`);
}

export async function attach(root: string, address: string, args: string[]) {
  const application = words(args, "--application") ?? (await desk(root)).application;
  const nativeAddress = discoverAddress(application);
  const wake = words(args, "--wake");
  await bind(root, address, ["--application", application, "--address", nativeAddress, ...(wake ? ["--wake", wake] : [])]);
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

async function chooseLaunchModel(root: string, config: Desk, record: Seat, portfolio: ModelPortfolio) {
  const candidates = availableModelCandidates(config, portfolio);
  if (!candidates.length) throw new Error("No enabled model in models.yaml has an available executable.");
  const work = (await seatTasks(root, record.project, record.address)).filter((entry) => entry.task.status !== "done");
  const selection = await selectModel({
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
  if (!selection.available) {
    console.warn(`Model selection for ${record.address} unavailable: ${selection.reason} Falling back to strongest available model.`);
    return candidates[0]!;
  }
  return required(candidates.find((entry) => entry.id === selection.selected_model), `selected model ${selection.selected_model}`);
}

export const launchNotice = (address: string) =>
  `SYSTEM: you are ${address}. Read your durable seat and assigned task with: atdd-flow open ${address}. Use the installed atdd-flow command; never use bunx to replace it or run atdd-flow init against an existing Desk. Routing: operator@desk is the human authority; drivers report to coordinators, and main seats are the normal technical gateway to the operator. Continue assigned in_progress work until it is review-ready or explicitly blocked.`;

/** Pi loads this extension inside its own process, so it can wake without host text injection. */
export const piExtensionPath = () => join(import.meta.dir, "..", "extensions", "pi", "index.ts");
export const isPiExecutable = (agent: string) => basename(agent) === "pi";
export const piLaunchArgs = (agent: string, args: string[]) => isPiExecutable(agent) ? [...args, "--extension", piExtensionPath()] : args;

export async function launch(root: string, address: string, args: string[]) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  const config = await desk(root);
  const application = required(words(args, "--application"), "--application");
  const placement = required(words(args, "--placement"), "--placement");
  const portfolio = await modelPortfolio(root);
  let agent: string;
  let modelArgs: string[] = [];
  let selectedModel: string;
  if (portfolio) {
    const selected = await chooseLaunchModel(root, config, record, portfolio);
    const command = resolveModelCommand(config, selected);
    agent = command.agent;
    modelArgs = command.args;
    selectedModel = selected.id;
  } else {
    const legacyAgent = required(record.agent, "models.yaml or a legacy seat agent");
    agent = resolveExecutable(config, legacyAgent);
    selectedModel = legacyAgent;
  }
  const wake: Runtime["wake"] = isPiExecutable(agent) ? "native" : "host";
  modelArgs = piLaunchArgs(agent, modelArgs);
  const output = await runOutput(launchCommand({
    application, placement, name: resolved, worktree: record.worktree,
    agent, args: modelArgs, root, seat: resolved,
  }));
  const nativeAddress = launchedAddress(application, placement, output);
  await bind(root, resolved, ["--application", application, "--address", nativeAddress], selectedModel, wake);
  if (wake === "native") return;
  const notice = launchNotice(resolved);
  try { await notify(application, nativeAddress, notice, config.herdr_session); }
  catch (error) { console.warn(`Launch notification for ${resolved} was not delivered: ${(error as Error).message}`); }
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
