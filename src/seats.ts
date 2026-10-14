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
import { isExactMainSeat, readHandoverReplacement, replacementMatchesRuntime } from "./handover";

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

const configureUsage = "Use `atdd-flow project configure <project> [--repository <primary-checkout>] [--worktree-root <directory>]`.";

/**
 * The supported way to declare an existing project's primary checkout and linked-worktree root.
 * Everything is validated before one atomic write; only those two project fields change.
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
    if (!["--repository", "--worktree-root"].includes(flag) || values.has(flag) || !value || value.startsWith("--")) throw new Error(configureUsage);
    values.set(flag, value);
  }
  if (!values.size) throw new Error(configureUsage);
  const repository = values.get("--repository"), worktreeRoot = values.get("--worktree-root");
  if (repository) {
    const path = resolve(repository);
    const real = (value: string) => { try { return realpathSync(value); } catch { return value; } };
    const top = existsSync(path) ? Bun.spawnSync(["git", "-C", path, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" }) : undefined;
    if (!top || top.exitCode !== 0 || real(top.stdout.toString().trim()) !== real(path)) throw new Error(`${path} is not the top level of a Git repository.`);
    config.repository = path;
  }
  if (worktreeRoot) config.worktree_root = resolve(worktreeRoot);
  await atomicYaml(paths(root).projectFile(name), config);
  for (const entry of await misplacedSeats(root, name)) console.log(`unprojected  ${entry.address}: ${entry.reason}`);
  console.log(`${name}  configured`);
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

async function noBranch(config: Project, branch: string) {
  const probe = Bun.spawn(["git", "-C", required(config.repository, "project repository"), "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (await probe.exited === 0) throw new Error(`Driver branch ${branch} already exists; refusing to reuse it.`);
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
  const repository = required(config.repository, "project repository");
  const branchHead = await runOutput(["git", "-C", repository, "rev-parse", branch]);
  if (!requireCleanCheckout) return { coordinator, branch, commit: branchHead };
  if (await runOutput(["git", "-C", coordinator.worktree, "status", "--porcelain"])) {
    throw new Error(`Coordinator ${coordinator.address} worktree is dirty.`);
  }
  const checkedOut = await runOutput(["git", "-C", coordinator.worktree, "branch", "--show-current"]);
  if (checkedOut !== branch) throw new Error(`Coordinator ${coordinator.address} is not checked out at ${branch}.`);
  const head = await runOutput(["git", "-C", coordinator.worktree, "rev-parse", "HEAD"]);
  if (head !== branchHead) throw new Error(`Coordinator ${coordinator.address} head is stale relative to ${branch}.`);
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
    try { await runOutput(["git", "-C", required(config.repository, "project repository"), "cat-file", "-e", `${baseArgument}^{commit}`]); }
    catch { throw new Error(`Explicit base ${baseArgument} does not exist locally in the configured repository.`); }
    try { await run(["git", "-C", required(config.repository, "project repository"), "merge-base", "--is-ancestor", coordinatorBase.commit, baseArgument], true); }
    catch { throw new Error(`Explicit base ${baseArgument} does not descend ${coordinatorBase.branch}.`); }
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
  try {
    await mkdir(dirname(worktree), { recursive: true });
    await run(["git", "-C", required(config.repository, "project repository"), "worktree", "add", "-b", branch, worktree, base.commit], true);
    created = true;
    const currentBranch = await runOutput(["git", "-C", required(config.repository, "project repository"), "rev-parse", coordinatorBase.branch]);
    if (currentBranch !== coordinatorBase.commit) throw new Error(`Coordinator ${base.coordinator.address} advanced during driver provisioning.`);
    if (!baseArgument) {
      const current = await runOutput(["git", "-C", base.coordinator.worktree, "rev-parse", "HEAD"]);
      if (current !== coordinatorBase.commit) throw new Error(`Coordinator ${base.coordinator.address} advanced during driver provisioning.`);
    }
    await atomicYaml(paths(root).seatFile(address), record);
    await atomicYaml(paths(root).taskFile(config.project, id), task);
  } catch (error) {
    if (created) {
      await run(["git", "-C", required(config.repository, "project repository"), "worktree", "remove", "--force", worktree], true).catch(() => undefined);
      await run(["git", "-C", required(config.repository, "project repository"), "branch", "-D", branch], true).catch(() => undefined);
    }
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

async function isExactNamedCoordinator(root: string, record: Seat, address: string) {
  if (record.address !== address || record.role !== "coordinator") return false;
  const config = await project(root, record.project);
  const role = config.roles.coordinator;
  const suffix = `@${config.project}`;
  const local = record.address.endsWith(suffix) ? record.address.slice(0, -suffix.length) : "";
  const match = local.match(/^coordinator\.([a-z0-9_-]+)$/);
  if (!config.repository || role?.address !== "coordinator.{name}@{project}" || role.branch !== "integration/{name}" || !role.worktree || !match) return false;
  const stream = match[1]!;
  const expectedWorktree = resolve(fill(role.worktree, {
    project: config.project, name: stream, worktree_root: config.worktree_root ?? "", repository: config.repository,
  }));
  if (record.branch !== `integration/${stream}` || resolve(record.worktree) !== expectedWorktree || expectedWorktree === resolve(config.repository)) return false;

  try {
    const peers = await Promise.all((await readdir(paths(root).seats(config.project))).map(async (name) => {
      try { return await readYaml<Seat>(join(paths(root).seats(config.project), name, "seat.yaml")); }
      catch { return undefined; }
    }));
    return !peers.some((peer) => peer && peer.address !== record.address && peer.role === "coordinator"
      && (peer.branch === record.branch || resolve(peer.worktree) === expectedWorktree));
  } catch { return false; }
}

async function launchEligibleTasks(root: string, record: Seat, address: string) {
  const [coordinator, main] = await Promise.all([isExactNamedCoordinator(root, record, address), isExactMainSeat(root, record, address)]);
  const tasks = await seatTasks(root, record.project, record.address);
  const eligible = await Promise.all(tasks.map(async (entry) => {
    const accountable = record.role === "driver" ? entry.task.assignee === record.address
      : coordinator ? entry.task.coordinator === record.address
      : main && entry.task.coordinator === record.address && entry.task.assignee === record.address;
    if (!accountable || entry.task.blocker) return undefined;
    if (entry.task.status === "in_progress" && !main) return entry;
    if (entry.task.status !== "todo") return undefined;
    const dependencies = await Promise.all((entry.task.depends_on ?? []).map(async (id) => {
      try { return terminal(await readYaml<{ status: Task["status"] }>(paths(root).taskFile(record.project, id))); }
      catch { return false; }
    }));
    return dependencies.every(Boolean) ? entry : undefined;
  }));
  return eligible.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
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

async function immutableSessionBackup(root: string, sessionPath: string, piSession: string) {
  const content = await readFile(sessionPath);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const backup = join(root, ".atdd-flow", "runtime-launch", "backups", `${encodeURIComponent(piSession)}-${crypto.randomUUID()}.jsonl`);
  await mkdir(dirname(backup), { recursive: true });
  await writeFile(backup, content, { flag: "wx" });
  return { backup, sha256 };
}

/** A deliberately narrow Pi+Herdr launch using only installed CLI commands on an existing shell pane. */
export async function launchPiRuntime(root: string, address: string, args: string[], dependencies: PiRuntimeLaunchDependencies = {}) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  const config = await desk(root);
  const requestedPane = words(args, "--pane");
  const herdrSession = required(words(args, "--herdr-session"), "--herdr-session");
  const resume = args.includes("--resume");
  const dryRun = args.includes("--dry-run");
  const adoptedSessionPath = words(args, "--adopt-session");
  const sourceHerdrSession = words(args, "--source-herdr-session");
  const sourcePane = words(args, "--source-pane");
  const authorization = words(args, "--authorization");
  const adoptionFields = [adoptedSessionPath, sourceHerdrSession, sourcePane, authorization];
  const adopting = adoptionFields.some(Boolean);
  const allowed = ["--herdr-session", herdrSession, "--resume", "--dry-run", ...(requestedPane ? ["--pane", requestedPane] : []),
    ...(adoptedSessionPath ? ["--adopt-session", adoptedSessionPath] : []), ...(sourceHerdrSession ? ["--source-herdr-session", sourceHerdrSession] : []),
    ...(sourcePane ? ["--source-pane", sourcePane] : []), ...(authorization ? ["--authorization", authorization] : [])];
  if (args.some((argument) => !allowed.includes(argument))) throw new Error("Use `pi runtime launch <seat> [--pane <asserted-pane>] --herdr-session <session> [--resume] [--dry-run] [--adopt-session <exact-jsonl> --source-herdr-session <session> --source-pane <pane> --authorization <owner-reference>]`.");
  if (adopting && (resume || !adoptionFields.every(Boolean))) throw new Error("Exact-session adoption requires --adopt-session, --source-herdr-session, --source-pane, and --authorization without --resume.");
  const existingHerdr = record.runtime?.addresses.herdr;
  const existingPane = typeof existingHerdr === "object" ? existingHerdr.pane : undefined;
  const existingSession = typeof existingHerdr === "object" ? existingHerdr.session : undefined;
  if (resume && ((requestedPane && requestedPane !== existingPane) || herdrSession !== existingSession)) {
    throw new Error("Resume cannot relocate a Pi session across a Herdr session or pane; use explicit exact-session adoption.");
  }
  const [active, main] = await Promise.all([launchEligibleTasks(root, record, resolved), isExactMainSeat(root, record, resolved)]);
  if (!active.length) throw new Error(`${resolved} has no launch-eligible task; refusing runtime launch.`);
  const replacement = main ? await readHandoverReplacement(root, resolved).catch(() => {
    throw new Error(`${resolved} requires one validated Path-A replacement request; refusing runtime launch.`);
  }) : undefined;
  if (replacement && !replacementMatchesRuntime(record.runtime, replacement)) throw new Error("Path-A replacement source tuple no longer matches the recorded runtime.");
  const selection = await chooseLaunchModel(root, config, record, required(await modelPortfolio(root), "models.yaml for Pi runtime launch"), dependencies.select);
  const model = resolveModelCommand(config, selection.candidate);
  if (basename(model.agent) !== "pi") throw new Error(`Pi runtime launch requires a Pi candidate, received ${selection.candidate.id}.`);
  const command = dependencies.command ?? runOutput;
  const piSession = adopting ? sessionIdFromPiJsonlPath(required(adoptedSessionPath, "an exact adopted Pi session path")) : resume ? record.runtime?.pi_session : (dependencies.sessionId ?? (() => crypto.randomUUID()))();
  if (!piSession) throw new Error("Resume requires the exact Pi session stored on the seat.");
  const canonicalAdoptedSessionPath = adopting ? resolve(required(adoptedSessionPath, "an exact adopted Pi session path")) : undefined;
  const authorizationRecord = adopting
    ? await resolveExactSessionAdoptionAuthorization(root, required(authorization, "an immutable operator authorization record"), {
      seat: resolved, pi_session: piSession, pi_session_path: required(canonicalAdoptedSessionPath, "an exact adopted Pi session path"),
      source: { herdr_session: required(sourceHerdrSession, "a source Herdr session"), pane: required(sourcePane, "a source pane") },
      target: { herdr_session: herdrSession, pane: required(requestedPane, "--pane for exact-session adoption"), cwd: resolve(record.worktree) },
    })
    : undefined;
  const projection = await projectHerdrSeat(root, resolved, herdrSession, command);
  if (resume && projection.pane !== existingPane) throw new Error("Resume cannot relocate a Pi session across a Herdr session or pane; use explicit exact-session adoption.");
  if (requestedPane && requestedPane !== projection.pane) throw new Error("The asserted --pane does not match the seat-scoped Herdr projection.");
  const pane = projection.pane;
  if (replacement && (replacement.target.herdr_session !== herdrSession || replacement.target.pane !== pane || replacement.target.cwd !== resolve(record.worktree))) {
    throw new Error("Path-A replacement request does not match the exact released target tuple.");
  }
  const [paneRaw, processRaw] = await Promise.all([command(herdr(herdrSession, "pane", "get", pane)), command(herdr(herdrSession, "pane", "process-info", "--pane", pane))]);
  const currentPane = paneReport(JSON.parse(paneRaw));
  const currentProcess = processReport(JSON.parse(processRaw));
  if (currentPane.pane !== pane) throw new Error("Herdr reported a different pane; refusing runtime launch.");
  if (currentPane.agent || piProcess(currentProcess.processes)) throw new Error(resume ? "Resume requires the prior Pi to have exited and been released." : "New launch requires an available shell pane.");
  if (resume) {
    const prior = record.runtime?.launch_receipt;
    if (!prior) throw new Error("Resume requires an existing Flow launch receipt.");
    try {
      const receipt = await readYaml<{ seat?: string; pi_session?: string; pi_session_path?: string; herdr_session?: string; pane?: string }>(prior);
      if (receipt.seat !== resolved || receipt.pi_session !== piSession || receipt.pi_session_path !== record.runtime?.pi_session_path || receipt.herdr_session !== herdrSession || receipt.pane !== pane) throw new Error("receipt does not match seat/session/path/pane");
    } catch (error) { throw new Error(`Resume requires a valid Flow launch receipt: ${(error as Error).message}`); }
  }
  const priorSessionPath = adopting ? required(canonicalAdoptedSessionPath, "an exact adopted Pi session path") : resume ? required(record.runtime?.pi_session_path, "a previously verified Pi session path") : undefined;
  if (adopting) {
    const [sourcePaneRaw, sourceProcessRaw] = await Promise.all([
      command(herdr(required(sourceHerdrSession, "a source Herdr session"), "pane", "get", required(sourcePane, "a source pane"))),
      command(herdr(required(sourceHerdrSession, "a source Herdr session"), "pane", "process-info", "--pane", required(sourcePane, "a source pane"))),
    ]);
    const sourceReport = paneReport(JSON.parse(sourcePaneRaw));
    const sourceProcess = processReport(JSON.parse(sourceProcessRaw));
    if (sourceReport.pane !== sourcePane || sourceReport.agent || piProcess(sourceProcess.processes)) {
      throw new Error("Exact-session adoption requires proof that the source Pi has exited and been released.");
    }
  }
  const request: HerdrRequest = { session: herdrSession, pane, seat: resolved, root, piSession, ...(priorSessionPath ? { sessionPath: priorSessionPath } : {}), resume: resume || adopting, args: [...model.args, "--extension", piExtensionPath()] };
  const plan = { candidate: selection.candidate.id, piSession, pane, herdrSession, receipt: receiptPath(root, piSession), command: startCommand(request), ...(dryRun ? { dryRun: true } : {}) };
  if (dryRun) return plan;
  // The source snapshot is a pre-migration prerequisite: never start a target
  // Pi when its immutable recovery copy cannot be created.
  const relocation = adopting ? await immutableSessionBackup(root, required(canonicalAdoptedSessionPath, "an exact adopted Pi session path"), piSession) : undefined;
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
  if ((resume || adopting) && sessionPath !== priorSessionPath) throw new Error("Herdr did not verify the exact requested Pi session path; seat binding was not changed.");
  if (agent.name !== agentName(resolved) || agent.pane !== pane || ![agent.status, verifiedPane.status].every((status) => status === "idle" || status === "done") || verifiedPane.pane !== pane || !verifiedProcess) throw new Error("Herdr did not verify the replacement Pi process; seat binding was not changed.");
  const receipt = plan.receipt;
  const receiptRecord = {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: resolved, tasks: active.map((entry) => entry.id), candidate: selection.candidate.id,
    selection: selection.fallback ? { result: "fallback", reason: selection.fallback } : { result: "selected", confidence: selection.selection.confidence, ...(selection.selection.available && selection.selection.model ? { model: selection.selection.model } : {}) },
    pi_session: piSession, pi_session_path: sessionPath, herdr_session: herdrSession, pane,
    ...(replacement ? { handover_replacement: { request: replacement, successor_session: piSession } } : {}),
    ...(relocation ? { relocation: { source_herdr_session: sourceHerdrSession, source_pane: sourcePane, authorization: authorizationRecord, backup: relocation.backup, backup_sha256: relocation.sha256 } } : {}),
    created_at: dependencies.at?.() ?? now(),
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
