import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { discoverAddress, discoverHerdrLocator, notify } from "./adapters";
import {
  type Checkpoint, type Desk, type ModelCandidate, type ModelPortfolio, type Project, type Role, type Runtime, type Seat,
  atomicYaml, canonicalAddress, desk, exists, fill, has, migrateDesk, modelPortfolio, now, paths, project, readYaml,
  required, run, runOutput, runtimeAddress, seat, taskId, words, yaml,
} from "./core";
import { type ModelSelectionInput, type ModelSelectionResponse, selectModel } from "./judgment";
import { type Task, seatTasks, terminal } from "./tasks";
import { misplacedSeats, projectHerdrSeat } from "./multiplexer";
import { isRuntimeStateStale, readRuntimeState } from "./runtime-state";
import { resolveExactSessionAdoptionAuthorization } from "./adoption-authorizations";
import { projectCollaborationPolicy } from "./collaboration-policy";
import { assertReplacementTarget, replacementForMainLaunch } from "./handover";
import { addWorkspace, assertBranchReady, assertRepository, branchCommit, branchExists, commitExists, isAncestor, rollbackWorkspace, vcsMode } from "./vcs";

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
  await projectCollaborationPolicy(root);
  if (args.includes("--git") && !await exists(join(root, ".git"))) await run(["git", "init", "--initial-branch=main", root]);
  console.log(`Initialized Desk ${root}`);
}

export async function migrate(root: string) {
  if (await migrateDesk(root)) console.log("Migrated legacy coordination registry to desk.yaml");
  else console.log("Desk registry already exists");
  await projectCollaborationPolicy(root);
}

export async function initProject(root: string, name: string) {
  await desk(root);
  const config: Project = { schema: "atdd-workflow/project/v1", project: name, roles: defaultRoles(Boolean(await modelPortfolio(root))) };
  await mkdir(paths(root).seats(name), { recursive: true });
  await atomicYaml(paths(root).projectFile(name), config);
  console.log(`Initialized project ${name}`);
}

const configureUsage = "Use `atdd-flow project configure <project> [--vcs <git|jj>] [--repository <primary-checkout>] [--worktree-root <directory>]`.";

/**
 * The supported way to declare an existing project's VCS, primary checkout, and linked-worktree root.
 * Everything is validated before one atomic write; no seat, task, runtime, branch/bookmark, or workspace is mutated.
 */
type MigrationSeat = { folder: string; record: Seat };

const namedTopologyMigrationUsage = "Use `atdd-flow project migrate-named-coordinator-topology <project> --baseline <40-lowercase-hex-remote-main-sha>`.";

async function migrationSeats(root: string, config: Project): Promise<MigrationSeat[]> {
  const directory = paths(root).seats(config.project);
  if (!await exists(directory)) return [];
  return Promise.all((await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(async (entry) => ({
    folder: entry.name,
    record: await readYaml<Seat>(join(directory, entry.name, "seat.yaml")),
  })));
}

/**
 * Validates existing coordinator records without provisioning anything. A policy
 * migration must preserve generic history while refusing ambiguous named resources.
 */
function assertMigrationTopology(config: Project, seats: MigrationSeat[]) {
  const primary = resolve(config.repository!);
  const root = resolve(config.worktree_root!);
  const coordinators = seats.filter(({ record }) => record.role === "coordinator");
  const genericAddress = `coordinator@${config.project}`;
  const generic = coordinators.filter(({ record }) => record.address === genericAddress);
  if (generic.length > 1 || generic.some(({ folder }) => folder !== "coordinator")) throw new Error("Legacy generic coordinator collides with another coordinator record.");

  const named = coordinators.filter(({ record }) => record.address !== genericAddress);
  for (const { record } of generic) for (const namedRecord of named) {
    if (record.branch === namedRecord.branch || record.worktree === namedRecord.worktree) {
      throw new Error("Legacy generic coordinator collides with a named coordinator resource.");
    }
  }
  const addresses = new Set<string>(), branches = new Set<string>(), worktrees = new Set<string>();
  for (const { record } of named) {
    if (!record.address.match(new RegExp(`^coordinator\\.([a-z0-9_-]+)@${config.project}$`))) throw new Error("Named coordinator seat collision.");
    if (addresses.has(record.address)) throw new Error("Named coordinator seat collision.");
    addresses.add(record.address);
    if (branches.has(record.branch)) throw new Error("Named coordinator branch collision.");
    branches.add(record.branch);
    const worktree = resolve(record.worktree);
    if (worktrees.has(worktree)) throw new Error("Named coordinator worktree collision.");
    worktrees.add(worktree);
  }
  for (const { record } of named) {
    const stream = record.address.slice("coordinator.".length, -(`@${config.project}`).length);
    const worktree = resolve(record.worktree);
    if (record.branch !== `integration/${stream}` || worktree !== resolve(join(root, stream)) || worktree === primary) {
      throw new Error("Named coordinator seat collision.");
    }
  }
  for (const { record } of seats.filter(({ record }) => record.role !== "coordinator")) for (const namedRecord of named) {
    if (record.branch === namedRecord.branch) throw new Error("Named coordinator branch collision.");
    if (resolve(record.worktree) === resolve(namedRecord.worktree)) throw new Error("Named coordinator worktree collision.");
  }
}

/**
 * Migrates only an existing project's coordinator role template. Validation is
 * read-only and precedes the one atomic policy write, so no resource can leak.
 */
export async function migrateNamedCoordinatorTopology(root: string, name: string, args: string[]) {
  if (args.length !== 2 || args[0] !== "--baseline" || !args[1]) throw new Error(args.includes("--baseline") ? namedTopologyMigrationUsage : "Missing --baseline.");
  const baseline = args[1]!;
  if (!/^[0-9a-f]{40}$/.test(baseline)) throw new Error("--baseline must be a full lowercase SHA-1.");
  if (!await exists(paths(root).projectFile(name))) throw new Error(`Project ${name} does not exist.`);
  const config = await project(root, name);
  if (!config.repository) throw new Error(`Project ${name} has no repository.`);
  if (!config.worktree_root) throw new Error(`Project ${name} has no worktree_root.`);
  const repository = resolve(config.repository), worktreeRoot = resolve(config.worktree_root);
  const top = existsSync(repository) ? Bun.spawnSync(["git", "-C", repository, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" }) : undefined;
  if (!top || top.exitCode !== 0 || realpathSync(top.stdout.toString().trim()) !== realpathSync(repository)) throw new Error(`Project ${name} repository is not a Git top level.`);
  try { if (!(await stat(worktreeRoot)).isDirectory()) throw new Error(); }
  catch { throw new Error(`Project ${name} has no worktree_root.`); }

  const remote = (await runOutput(["git", "-C", repository, "ls-remote", "--exit-code", "origin", "refs/heads/main"])).trim().split(/\s+/)[0];
  if (remote !== baseline) throw new Error(`Baseline ${baseline} does not equal origin/main.`);
  try { await runOutput(["git", "-C", repository, "cat-file", "-e", `${baseline}^{commit}`]); }
  catch { throw new Error(`Baseline ${baseline} is not available locally.`); }
  assertMigrationTopology(config, await migrationSeats(root, config));

  const coordinator = config.roles.coordinator;
  if (!coordinator) throw new Error(`Project ${name} has no coordinator role policy.`);
  const next: Project = {
    ...config,
    roles: {
      ...config.roles,
      coordinator: {
        ...coordinator,
        address: "coordinator.{name}@{project}", branch: "integration/{name}", base: "main", worktree: "{worktree_root}/{name}",
      },
    },
  };
  try { await atomicYaml(paths(root).projectFile(name), next); }
  catch { throw new Error("Unable to atomically write migration policy."); }
  console.log(`${name}  named coordinator topology migrated`);
}

export async function configureProject(root: string, name: string, args: string[]) {
  const config = await project(root, name);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!["--vcs", "--repository", "--worktree-root"].includes(flag) || values.has(flag) || !value || value.startsWith("--")) throw new Error(configureUsage);
    values.set(flag, value);
  }
  if (!values.size) throw new Error(configureUsage);
  const selectedVcs = values.get("--vcs");
  if (selectedVcs && selectedVcs !== "git" && selectedVcs !== "jj") throw new Error(configureUsage);
  const mode = (selectedVcs ?? vcsMode(config)) as "git" | "jj";
  const repository = values.get("--repository"), worktreeRoot = values.get("--worktree-root");
  const configuredRepository = repository ?? config.repository;
  if (selectedVcs && !configuredRepository) throw new Error("Project repository is required before selecting a VCS.");
  const repositoryPath = configuredRepository ? resolve(configuredRepository) : undefined;
  if (repositoryPath && (repository || selectedVcs)) {
    try { await assertRepository(mode, repositoryPath); }
    catch (error) { throw new Error((error as Error).message); }
    config.repository = repositoryPath;
  }
  if (selectedVcs) config.vcs = mode;
  if (worktreeRoot) config.worktree_root = resolve(worktreeRoot);
  await atomicYaml(paths(root).projectFile(name), config);
  for (const entry of await misplacedSeats(root, name)) console.log(`unprojected  ${entry.address}: ${entry.reason}`);
  console.log(`${name}  configured`);
}

async function ensureWorktree(config: Project, role: Role, worktree: string, branch: string) {
  if (!config.repository || worktree === resolve(config.repository) || await exists(worktree)) return;
  await mkdir(dirname(worktree), { recursive: true });
  await addWorkspace(vcsMode(config), config.repository, worktree, branch, role.base ?? "HEAD");
}

async function noBranch(config: Project, branch: string) {
  if (await branchExists(vcsMode(config), required(config.repository, "project repository"), branch)) {
    throw new Error(`Driver branch ${branch} already exists; refusing to reuse it.`);
  }
}

async function taskCoordinatorBase(root: string, config: Project, task: Task, requireCleanCheckout = true) {
  const coordinatorAddress = await canonicalAddress(root, task.coordinator);
  const suffix = `@${config.project}`;
  if (!coordinatorAddress.endsWith(suffix)) throw new Error(`Task coordinator ${coordinatorAddress} is outside project ${config.project}.`);
  const coordinator = await seat(root, coordinatorAddress);
  const primary = resolve(required(config.repository, "project repository"));
  let branch: string;
  if (coordinator.role === "main") {
    if (coordinator.address !== `main@${config.project}` || coordinator.branch !== "main" || resolve(coordinator.worktree) !== primary) {
      throw new Error(`Main coordinator ${coordinator.address} has mismatched primary lineage.`);
    }
    branch = "main";
  } else if (coordinator.role === "coordinator") {
    const match = coordinator.address.match(new RegExp(`^coordinator\\.([a-z0-9_-]+)@${config.project}$`));
    if (!match || coordinator.branch !== `integration/${match[1]}` || resolve(coordinator.worktree) === primary) {
      throw new Error(`Coordinator ${coordinator.address} has mismatched, generic, or nested integration lineage.`);
    }
    branch = coordinator.branch;
  } else {
    throw new Error(`Task coordinator ${coordinator.address} must be main or a named coordinator.`);
  }
  if (coordinator.project !== config.project) throw new Error(`Task coordinator ${coordinator.address} is outside project ${config.project}.`);
  const mode = vcsMode(config);
  const branchHead = await branchCommit(mode, coordinator.worktree, branch);
  if (!requireCleanCheckout) return { coordinator, branch, commit: branchHead };
  if (mode === "git") {
    if (await runOutput(["git", "-C", coordinator.worktree, "status", "--porcelain"])) throw new Error(`Coordinator ${coordinator.address} worktree is dirty.`);
    const checkedOut = await runOutput(["git", "-C", coordinator.worktree, "branch", "--show-current"]);
    if (checkedOut !== branch) throw new Error(`Coordinator ${coordinator.address} is not checked out at ${branch}.`);
    const head = await runOutput(["git", "-C", coordinator.worktree, "rev-parse", "HEAD"]);
    if (head !== branchHead) throw new Error(`Coordinator ${coordinator.address} head is stale relative to ${branch}.`);
  } else {
    try { await assertBranchReady(mode, coordinator.worktree, branch); }
    catch (error) { throw new Error(`Coordinator ${coordinator.address} is not ready: ${(error as Error).message}`); }
  }
  return { coordinator, branch, commit: branchHead };
}

/** Creates a fresh driver and assigns its existing todo task from the task coordinator's exact head. */
async function spawnTaskDriver(root: string, config: Project, role: Role, name: string, args: string[]) {
  if (role.address !== "driver.{name}@{project}" || role.branch !== "delivery/{name}" || !role.worktree) {
    throw new Error("Task-aware driver spawn requires the canonical driver role topology.");
  }
  if (has(args, "--worktree") || has(args, "--branch")) throw new Error("Task-aware driver spawn derives its worktree and branch; do not provide --worktree or --branch.");
  const baseArgument = words(args, "--base");
  const dryRun = has(args, "--dry-run");
  const explicit = args.includes("--base") || dryRun;
  if (explicit) {
    const allowed = new Set(["--task", "--base", "--dry-run"]);
    const taskArgument = words(args, "--task");
    const onlyExpectedValues = args.every((arg, index) => allowed.has(arg)
      || (index > 0 && ["--task", "--base"].includes(args[index - 1]!)));
    if (!onlyExpectedValues || args.filter((arg) => arg === "--task").length !== 1
      || args.filter((arg) => arg === "--base").length !== 1
      || args.filter((arg) => arg === "--dry-run").length > 1
      || !taskArgument || taskArgument.startsWith("--")
      || !baseArgument || !/^[0-9a-f]{40}$/.test(baseArgument)) {
      throw new Error("Task-aware explicit base requires one --task <task-id> and one --base <full-40-lowercase-commit-sha>.");
    }
  }
  const id = taskId(required(words(args, "--task"), "--task"));
  const task = await readYaml<Task>(paths(root).taskFile(config.project, id));
  if (task.schema !== "atdd-workflow/task/v1") throw new Error(`Unsupported task schema: ${id}`);
  if (task.status !== "todo" || task.assignee) throw new Error(`Task ${id} must be an unassigned todo task.`);
  const entries = { project: config.project, name, worktree_root: config.worktree_root ?? "" };
  const address = fill(role.address, entries);
  const branch = fill(role.branch, entries);
  const worktree = resolve(fill(role.worktree, { ...entries, repository: config.repository ?? "" }));
  if (await exists(paths(root).seatFile(address))) throw new Error(`Driver seat ${address} already exists; refusing to reuse it.`);
  if (await exists(worktree)) throw new Error(`Driver worktree ${worktree} already exists; refusing to reuse it.`);
  await noBranch(config, branch);
  // An explicit baseline is governed by the repository ref, never by a
  // potentially dirty or stale coordinator checkout. Legacy spawn retains its
  // existing clean-checkout guard and derives exactly as before.
  const coordinatorBase = await taskCoordinatorBase(root, config, task, !baseArgument);
  let base = coordinatorBase;
  if (baseArgument) {
    const repository = required(config.repository, "project repository");
    if (!await commitExists(repository, baseArgument)) throw new Error(`Explicit base ${baseArgument} does not exist locally in the configured repository.`);
    if (!await isAncestor(repository, coordinatorBase.commit, baseArgument)) throw new Error(`Explicit base ${baseArgument} does not descend ${coordinatorBase.branch}.`);
    base = { ...coordinatorBase, commit: baseArgument };
  }
  if (dryRun) {
    if (!baseArgument) throw new Error("--dry-run is supported only with explicit --base task-aware spawn.");
    console.log(`${address}  dry-run ${id}  base ${base.commit}  branch ${branch}  worktree ${worktree}`);
    return;
  }
  const portfolio = await modelPortfolio(root);
  const requestedAgent = words(args, "--agent");
  if (portfolio && requestedAgent) throw new Error("--agent is a legacy pin and cannot be used when models.yaml owns model allocation.");
  const legacyAgent = portfolio ? undefined : requestedAgent ?? role.agent;
  const purpose = words(args, "--purpose") ?? (role.purpose ? fill(role.purpose, entries) : undefined);
  const record: Seat = {
    schema: "atdd-workflow/seat/v2", address, role: "driver", project: config.project, worktree, branch,
    ...(legacyAgent ? { agent: legacyAgent } : {}), ...(purpose ? { purpose } : {}),
  };
  task.assignee = address;
  task.governed_base = { coordinator: base.coordinator.address, branch: base.branch, commit: base.commit };
  let created = false;
  const mode = vcsMode(config);
  const repository = required(config.repository, "project repository");
  try {
    await mkdir(dirname(worktree), { recursive: true });
    await addWorkspace(mode, repository, worktree, branch, base.commit);
    created = true;
    const currentBranch = await branchCommit(mode, base.coordinator.worktree, coordinatorBase.branch);
    if (currentBranch !== coordinatorBase.commit) throw new Error(`Coordinator ${base.coordinator.address} advanced during driver provisioning.`);
    if (!baseArgument) {
      const current = await assertBranchReady(mode, base.coordinator.worktree, coordinatorBase.branch);
      if (current !== coordinatorBase.commit) throw new Error(`Coordinator ${base.coordinator.address} advanced during driver provisioning.`);
    }
    await atomicYaml(paths(root).seatFile(address), record);
    await atomicYaml(paths(root).taskFile(config.project, id), task);
  } catch (error) {
    if (created) await rollbackWorkspace(mode, repository, worktree, branch);
    await rm(paths(root).seat(address), { recursive: true, force: true });
    throw error;
  }
  console.log(`${address}  assigned ${id}  return ${base.branch}${baseArgument ? `  base ${base.commit}` : ""}`);
}

export async function spawn(root: string, projectName: string, roleName: string, name: string, args: string[]) {
  const config = await project(root, projectName);
  const role = required(config.roles[roleName], `role ${roleName}`);
  if (words(args, "--task")) {
    if (roleName !== "driver") throw new Error("--task is supported only for driver spawn.");
    return spawnTaskDriver(root, config, role, name, args);
  }
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
    if (!/^[a-z0-9_-]+$/.test(name)) throw new Error("Named coordinator must use one single stream name.");
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

export { availableModelCandidates, piExtensionPath, resolveModelCommand, type PiRuntimeLaunchDependencies } from "./pi-runtime-launch";

/** Delegates generic Pi/Herdr mechanics while seats retain the public launch API and bind authority. */
export async function launchPiRuntime(root: string, address: string, args: string[], dependencies: import("./pi-runtime-launch").PiRuntimeLaunchDependencies = {}) {
  const { launchPiRuntimeImplementation } = await import("./pi-runtime-launch");
  return launchPiRuntimeImplementation(root, address, args, bind, dependencies);
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
  if (typeof herdr === "string") console.log(`herdr: ${herdr} (unscoped; unverified)`);
  if (record.runtime?.application === "herdr") {
    const advisory = await readRuntimeState(root, resolved);
    const missing = [
      typeof herdr === "string" || !herdr ? "Herdr session" : undefined,
      !record.runtime.pi_session || !record.runtime.pi_session_path ? "Pi session/path" : undefined,
      !record.runtime.launch_receipt || !await exists(record.runtime.launch_receipt) ? "launch receipt" : undefined,
      !advisory || isRuntimeStateStale(advisory, 60_000) ? "advisory heartbeat" : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    console.log(`runtime verification: ${missing.length ? `unverified (${missing.join(", ")})` : "bounded metadata and fresh advisory heartbeat"}`);
  }
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
