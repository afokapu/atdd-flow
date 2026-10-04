import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { discoverAddress, launchedAddress, launchCommand, notify } from "./adapters";
import {
  type Checkpoint, type Desk, type ModelCandidate, type ModelPortfolio, type Project, type Role, type Seat,
  atomicYaml, canonicalAddress, desk, exists, fill, migrateDesk, modelPortfolio, now, paths, project, readYaml,
  required, run, runOutput, seat, words, yaml,
} from "./core";
import { type ReviewRoute, reviewTask, selectModel } from "./judgment";
import { seatTasks } from "./tasks";

const defaultRoles = (): Record<string, Role> => ({
  coordinator: { address: "coordinator@{project}", branch: "main", worktree: "{repository}" },
  driver: { address: "driver.{name}@{project}", branch: "delivery/{name}", base: "main", worktree: "{worktree_root}/{name}" },
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
  const config: Project = { schema: "atdd-workflow/project/v1", project: name, roles: defaultRoles() };
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
  const legacyAgent = words(args, "--agent") ?? role.agent;
  const record: Seat = {
    schema: "atdd-workflow/seat/v2", address, role: roleName, project: config.project, worktree, branch,
    ...(legacyAgent ? { agent: legacyAgent } : {}), ...(purpose ? { purpose } : {}),
  };
  await atomicYaml(paths(root).seatFile(address), record);
  console.log(address);
}

export async function bind(root: string, address: string, args: string[], selectedModel?: string) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  const config = await desk(root);
  const application = words(args, "--application") ?? config.application;
  if (!/^[a-z][a-z0-9_-]*$/.test(application)) throw new Error(`Application must use lowercase letters, numbers, underscores, or hyphens: ${application}`);
  const nativeAddress = required(words(args, "--address"), "--address");
  const addresses = record.runtime?.addresses ?? {};
  record.runtime = {
    ...record.runtime,
    application,
    addresses: { ...addresses, [application]: nativeAddress },
    attached_at: now(),
    ...(selectedModel ? { model: selectedModel } : {}),
  };
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
  await bind(root, address, ["--application", application, "--address", nativeAddress]);
}

function modelIsAvailable(config: Desk, candidate: ModelCandidate) {
  if (candidate.enabled === false) return false;
  const executable = resolveExecutable(config, candidate.executable);
  return executable.includes("/") ? existsSync(executable) : Boolean(Bun.which(executable));
}

function resolveModelCommand(config: Desk, candidate: ModelCandidate) {
  return { agent: resolveExecutable(config, candidate.executable), args: candidate.args ?? [] };
}

async function reviewRouteForSeat(root: string, record: Seat): Promise<ReviewRoute | undefined> {
  const reviews = (await seatTasks(root, record.project, record.address))
    .filter((entry) => entry.task.status === "review" && entry.task.coordinator === record.address);
  if (!reviews.length) return undefined;
  let route: ReviewRoute = "CONFORMANCE";
  for (const entry of reviews) {
    const judgment = await reviewTask(root, record.project, entry.id);
    if (!judgment.available || judgment.route === "ADVERSARIAL") return "ADVERSARIAL";
    route = judgment.route;
  }
  return route;
}

async function chooseLaunchModel(root: string, config: Desk, record: Seat, portfolio: ModelPortfolio) {
  const candidates = portfolio.models.filter((entry) => modelIsAvailable(config, entry));
  if (!candidates.length) throw new Error("No enabled model in models.yaml has an available executable.");
  const work = (await seatTasks(root, record.project, record.address)).filter((entry) => entry.task.status !== "done");
  const reviewRoute = await reviewRouteForSeat(root, record);
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
    ...(reviewRoute ? { reviewRoute } : {}),
  });
  if (!selection.available) {
    console.warn(`Model selection for ${record.address} unavailable: ${selection.reason} Falling back to strongest available model.`);
    return { candidate: candidates[0]!, reviewRoute };
  }
  return { candidate: required(candidates.find((entry) => entry.id === selection.selected_model), `selected model ${selection.selected_model}`), reviewRoute };
}

export const launchNotice = (address: string, reviewRoute?: ReviewRoute) => {
  const base = `SYSTEM: you are ${address}. Read your durable seat and assigned task with: atdd-workflow open ${address}. Continue assigned in_progress work until it is review-ready or explicitly blocked.`;
  if (reviewRoute === "ADVERSARIAL") return `${base} For review work, assume the acceptance, tests, implementation, and proof may agree around a bad assumption; look for omitted correctness behavior before accepting conformance.`;
  if (reviewRoute === "CONFORMANCE") return `${base} For review work, verify the supplied proof against done_when and existing repository invariants; do not reopen settled scope without concrete evidence.`;
  return base;
};

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
  let reviewRoute: ReviewRoute | undefined;
  if (portfolio) {
    const selected = await chooseLaunchModel(root, config, record, portfolio);
    const command = resolveModelCommand(config, selected.candidate);
    agent = command.agent;
    modelArgs = command.args;
    selectedModel = selected.candidate.id;
    reviewRoute = selected.reviewRoute;
  } else {
    const legacyAgent = required(record.agent, "models.yaml or a legacy seat agent");
    agent = resolveExecutable(config, legacyAgent);
    selectedModel = legacyAgent;
  }
  const output = await runOutput(launchCommand({
    application, placement, name: resolved, worktree: record.worktree,
    agent, args: modelArgs, root, seat: resolved,
  }));
  const nativeAddress = launchedAddress(application, placement, output);
  await bind(root, resolved, ["--application", application, "--address", nativeAddress], selectedModel);
  const notice = launchNotice(resolved, reviewRoute);
  try { await notify(application, nativeAddress, notice); }
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
