import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type Checkpoint, type Seat, atomicYaml, canonicalAddress, exists, now, paths, project, readYaml, required, runOutput, seat, taskId, values, words,
} from "./core";
import { terminalMergeProof } from "./retire-merge-proof";
import { operatorAuthorizationPayload } from "./task-supersede-authorization";
import { branchCommit, currentCommit, isAncestor, vcsMode, type VcsMode } from "./vcs";

export type TaskStatus = "todo" | "in_progress" | "review" | "done" | "superseded" | "rejected";
/** An optional, descriptive implementation phase; task status remains the lifecycle authority. */
export type TaskPhase = "plan" | "red" | "green" | "refactor";
export type HandoffState = "executing" | "awaiting_coordinator" | "awaiting_assignee";
/** A mutable projection of an immutable evidence message/reference, not a second task lifecycle. */
/** `submitted_phase` is absent on legacy records; it lets a same-phase accept be told apart from a never-submitted phase. */
export type TaskHandoff = {
  state: HandoffState; evidence: string; updated_at: string; submitted_phase?: TaskPhase;
  plan?: { source: string; revision: string; acceptances: string[]; worktree?: string; ratification?: string; delegation?: string };
  plan_review?: { by: string; evidence: string; at: string; ratification: string };
  /** A PLAN return is a durable, actionable review disposition. */
  return_reason?: string;
};
export type DoneWhen = { text: string; proof?: string };
export type GovernedBase = { coordinator: string; branch: string; commit: string };
export type LineageRef = { ref: string; commit: string; reason?: string };
/** An append-only accountability decision; prior coordinator evidence remains untouched. */
export type CoordinatorTransfer = {
  from: string;
  to: string;
  reason: string;
  /** Required when main executes the transfer; references an operator@desk message. */
  authorization?: string;
  exact_head: { branch: string; commit: string };
  /** The driver ref used for the lineage check; HEAD means the recorded branch no longer resolved. */
  lineage_ref?: LineageRef;
  effective_at: string;
};
export type TerminalDisposition = { kind: "superseded" | "rejected"; by: string; at: string; reason: string; authorization?: string };
export type DeferredDisposition = { by: string; at: string; reason: string; owner: string; trigger: string; review_at: string };
export type DispatchAlert = { key: string; message: string; observed_at: string };
/** Persisted evidence for an immediate assignment; each field is written only by its own typed command. */
export type ImmediateDispatch = {
  thread: string;
  message: string;
  priority: string;
  mutation_boundary: string;
  assignee: string;
  status: "dispatched";
  acknowledgement?: { dispatch: string; by: string; acknowledged_at: string };
  start?: { by: string; transitioned_at: string };
  alerts?: { missing_acknowledgement?: DispatchAlert; missing_start?: DispatchAlert };
};
export type Task = {
  schema: "atdd-workflow/task/v1";
  title: string;
  status: TaskStatus;
  coordinator: string;
  assignee?: string;
  body?: string;
  source?: string;
  depends_on?: string[];
  blocker?: string;
  /** Absent on legacy tasks. Newly created tasks enter PLAN before implementation. */
  phase?: TaskPhase;
  /** A new-task marker: legacy imported v1 tasks remain readable without retrospective gates. */
  plan_required?: true;
  /** Absent on legacy tasks; evidence remains an opaque immutable message/reference. */
  handoff?: TaskHandoff;
  /** Legacy topology evidence is preserved but is not created for role-neutral assignments. */
  governed_base?: GovernedBase;
  /** Absent on legacy tasks; later entries never rewrite earlier coordinator evidence. */
  coordinator_transfers?: CoordinatorTransfer[];
  /** Immutable terminal coordinator decision. */
  disposition?: TerminalDisposition;
  /** Bounded hold with an accountable owner, trigger, and review point. */
  deferred?: DeferredDisposition;
  /** Absent unless assigned with `--immediate`. */
  immediate_dispatch?: ImmediateDispatch;
  done_when: DoneWhen[];
};

export type ListedTask = { id: string; task: Task };
export const terminal = (task: Pick<Task, "status">) => task.status === "done" || task.status === "superseded" || task.status === "rejected";

const transitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress"],
  in_progress: ["review"],
  review: ["in_progress", "done"],
  done: [],
  superseded: [],
  rejected: [],
};

function assertCoordinatorIntegrity(task: Task, id: string) {
  const transfers = task.coordinator_transfers;
  if (transfers && !Array.isArray(transfers)) throw new Error(`Task ${id} has invalid immutable transfer provenance.`);
  const latest = transfers?.at(-1);
  if (latest) {
    if (!latest.from || !latest.to || !latest.reason || !latest.effective_at || !latest.exact_head?.branch || !latest.exact_head.commit) {
      throw new Error(`Task ${id} has invalid immutable transfer provenance.`);
    }
    if (task.coordinator !== latest.to || !task.governed_base
      || task.governed_base.coordinator !== latest.to
      || task.governed_base.branch !== latest.exact_head.branch
      || task.governed_base.commit !== latest.exact_head.commit) {
      throw new Error(`Task ${id} coordinator is not backed by immutable transfer provenance.`);
    }
  } else if (task.governed_base && task.governed_base.coordinator !== task.coordinator) {
    throw new Error(`Task ${id} coordinator is not backed by immutable transfer provenance.`);
  }
}

async function readTask(root: string, projectName: string, id: string) {
  const record = await readYaml<Task>(paths(root).taskFile(projectName, id));
  if (record.schema !== "atdd-workflow/task/v1") throw new Error(`Unsupported task schema: ${id}`);
  assertCoordinatorIntegrity(record, id);
  return record;
}

async function allTasks(root: string, projectName: string): Promise<ListedTask[]> {
  const folder = paths(root).tasks(projectName);
  let files: string[];
  try { files = await readdir(folder); }
  catch { return []; }
  return Promise.all(files.filter((file) => file.endsWith(".yaml") && !file.endsWith(".reviews.yaml")).sort().map(async (file) => ({ id: file.slice(0, -5), task: await readTask(root, projectName, file.slice(0, -5)) })));
}

export async function seatTasks(root: string, projectName: string, address: string): Promise<ListedTask[]> {
  return (await allTasks(root, projectName)).filter((entry) =>
    entry.task.assignee === address || entry.task.coordinator === address
  );
}

async function ready(root: string, projectName: string, task: Task) {
  const dependencies = await Promise.all((task.depends_on ?? []).map(async (id) => ({ id, task: await readTask(root, projectName, id) })));
  return dependencies.filter((entry) => !terminal(entry.task)).map((entry) => entry.id);
}

function allProofs(task: Task) {
  return task.done_when.every((entry) => Boolean(entry.proof));
}

async function writeTask(root: string, projectName: string, id: string, task: Task) {
  await atomicYaml(paths(root).taskFile(projectName, id), task);
}

/** Records the exact parent head for new bounded topology without rewriting legacy tasks. */
async function governedBase(root: string, projectName: string, coordinatorAddress: string, assignee?: string): Promise<GovernedBase | undefined> {
  return (await governedLineage(root, projectName, coordinatorAddress, assignee))?.base;
}

/** The recorded branch when it resolves; otherwise the driver worktree HEAD; otherwise fail closed. */
async function driverLineageRef(mode: VcsMode, driver: Seat): Promise<LineageRef> {
  try { return { ref: driver.branch, commit: await branchCommit(mode, driver.worktree, driver.branch) }; }
  catch {
    if (!await exists(driver.worktree)) {
      throw new Error(`Driver ${driver.address} branch ${driver.branch} no longer resolves and its worktree ${driver.worktree} is missing; cannot verify lineage.`);
    }
    try {
      const commit = await currentCommit(mode, driver.worktree);
      return { ref: mode === "git" ? "HEAD" : "@", commit, reason: `recorded branch ${driver.branch} no longer resolves; used worktree ${mode === "git" ? "HEAD" : "@"}` };
    } catch {
      throw new Error(`Driver ${driver.address} branch ${driver.branch} no longer resolves and worktree ${driver.worktree} has no valid current revision.`);
    }
  }
}

async function governedLineage(root: string, projectName: string, coordinatorAddress: string, assignee?: string): Promise<{ base: GovernedBase; lineage: LineageRef } | undefined> {
  if (!assignee) return undefined;
  const config = await project(root, projectName);
  if (!config.repository) return undefined;
  const coordinator = await seat(root, coordinatorAddress);
  const driver = await seat(root, assignee);
  if (driver.role !== "driver") throw new Error(`${assignee} is not a driver seat.`);
  const primary = resolve(config.repository);
  let branch: string;
  if (coordinator.role === "main") {
    if (coordinator.address !== `main@${config.project}` || coordinator.branch !== "main" || resolve(coordinator.worktree) !== primary) {
      throw new Error(`Main coordinator ${coordinator.address} has mismatched primary lineage.`);
    }
    branch = "main";
  } else if (coordinator.role === "coordinator") {
    const configured = config.roles.coordinator;
    // Existing coordinator role templates and coordinator@project records
    // predate bounded integration lineage and remain readable unchanged.
    if (configured?.address !== "coordinator.{name}@{project}" || configured.branch !== "integration/{name}" || coordinator.address === `coordinator@${config.project}`) return undefined;
    const suffix = `@${config.project}`;
    const local = coordinator.address.endsWith(suffix) ? coordinator.address.slice(0, -suffix.length) : "";
    const match = local.match(/^coordinator\.([a-z0-9_-]+)$/);
    if (!match || coordinator.branch !== `integration/${match[1]}` || resolve(coordinator.worktree) === primary) {
      throw new Error(`Coordinator ${coordinator.address} has mismatched or nested integration lineage.`);
    }
    branch = coordinator.branch;
  } else {
    throw new Error(`Task coordinator ${coordinator.address} must be main or a named coordinator.`);
  }
  const mode = vcsMode(config);
  const commit = await branchCommit(mode, coordinator.worktree, branch);
  const lineage = await driverLineageRef(mode, driver);
  if (!await isAncestor(driver.worktree, commit, lineage.commit)) throw new Error(`Driver ${driver.address} is not based on the exact coordinator head ${commit}.`);
  return { base: { coordinator: coordinator.address, branch, commit }, lineage };
}

/**
 * Assignment is accountability only: any existing, non-retired seat of the same project is eligible
 * regardless of role. Validation happens before any task write, so a rejection leaves no partial record.
 */
async function eligibleAssignee(root: string, projectName: string, address: string) {
  const candidate = await seat(root, address);
  if (candidate.project !== projectName) throw new Error(`Task assignee ${candidate.address} does not belong to project ${projectName}.`);
  if (candidate.retired) throw new Error(`Task assignee ${candidate.address} is retired.`);
  return candidate;
}

/** Legacy topology evidence is recorded only when it is exactly provable; it never gates assignment. */
async function evidenceBase(root: string, projectName: string, coordinator: string, assignee: Seat): Promise<GovernedBase | undefined> {
  if (assignee.role !== "driver") return undefined;
  try { return await governedBase(root, projectName, coordinator, assignee.address); }
  catch { return undefined; }
}

async function retireAssignee(root: string, projectName: string, id: string, task: Task) {
  return retireDriver(root, projectName, required(task.assignee, `an assignee for task ${id}`), id);
}

/**
 * Retires an idle driver: every other assigned task must be done, ATDD Bun removes the clean and
 * merged worktree, the seat records retirement and a checkpoint, then its workspace may close.
 */
/** Resolves symlinks through the nearest existing ancestor so an absent path compares with Git's paths. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch { return dirname(absolute) === absolute ? absolute : join(await canonicalPath(dirname(absolute)), basename(absolute)); }
}

/**
 * A recorded worktree that is absent from disk and from the repository's `git worktree list` has
 * nothing left to finish. Any other state, including a registered-but-missing path, fails closed.
 */
async function absentUnregisteredWorktree(root: string, projectName: string, owner: Seat) {
  if (await exists(owner.worktree)) return undefined;
  const repository = required((await project(root, projectName)).repository, `a repository for project ${projectName}`);
  const target = await canonicalPath(owner.worktree);
  const listed = (await runOutput(["git", "-C", repository, "worktree", "list", "--porcelain"])).split("\n")
    .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
  for (const path of listed) {
    if (await canonicalPath(path) === target) throw new Error(`Worktree ${owner.worktree} is missing but still registered with Git; prune or restore it before retiring ${owner.address}.`);
  }
  return `Worktree ${owner.worktree} is absent and unregistered; retired without worktree finish; branch ${owner.branch} retained.`;
}

/**
 * Resolves the ATDD Bun that retires a seat: the primary checkout's local copy, then the primary
 * checkout's package source when it is ATDD Bun itself, then PATH. A seat worktree copy is never used:
 * a finished branch may pin an older toolkit that refuses the seat being retired.
 */
async function retirementBun(root: string, projectName: string) {
  const primary = resolve(required((await project(root, projectName)).repository, `a repository for project ${projectName}`));
  const local = join(primary, "node_modules", ".bin", "atdd-bun");
  if (await exists(local)) return [local];
  const source = join(primary, "src", "cli.ts");
  try {
    if ((await Bun.file(join(primary, "package.json")).json()).name === "@afokapu/atdd-bun" && await exists(source)) return [process.execPath, source];
  } catch { /* no readable package manifest; fall through to PATH */ }
  // Absolute so command execution never substitutes the seat worktree's local copy.
  return [required(Bun.which("atdd-bun") ?? undefined, "atdd-bun in the primary checkout node_modules/.bin or on PATH")];
}

/**
 * The VCS a worktree actually uses. Project policy decides new work, but a detached Git review checkout under a JJ project has no JJ
 * workspace, so finishing it as JJ would demand a JJ repo and exported bookmark it cannot have. A JJ workspace keeps the policy.
 */
async function worktreeVcs(worktree: string, policy: "git" | "jj") {
  if (policy === "git" || !await exists(worktree)) return policy;
  try { return await realpath(await runOutput(["jj", "root"], worktree)) === await realpath(worktree) ? "jj" as const : "git" as const; }
  catch { return "git" as const; }
}

/**
 * ATDD Bun removes a clean merged worktree and its branch. When it refuses (a squash-merged or post-JJ branch it cannot prove
 * merged), retirement proceeds only on independent merge proof; the worktree and branch are then retained and the refusal stands otherwise.
 */
async function finishOrProveMerged(root: string, projectName: string, owner: Seat) {
  const config = await project(root, projectName);
  const mode = await worktreeVcs(owner.worktree, vcsMode(config));
  try {
    return await runOutput([...await retirementBun(root, projectName), "worktree", "finish", "--delete-branch", "--vcs", mode], owner.worktree);
  } catch (error) {
    const proof = config.repository && await exists(owner.worktree) ? await terminalMergeProof(config.repository, owner, mode, config.roles.main?.branch) : undefined;
    if (!proof) throw error;
    return `Worktree finish refused (${(error as Error).message}); merge proof: ${proof}; worktree ${owner.worktree} and branch ${owner.branch} retained.`;
  }
}

async function retireDriver(root: string, projectName: string, assignee: string, id: string, allowAbsentWorktree = false, allowPrimaryCheckout = false) {
  const unfinished = (await allTasks(root, projectName))
    .filter((entry) => entry.id !== id && (entry.task.assignee === assignee || entry.task.coordinator === assignee) && !terminal(entry.task))
    .map((entry) => entry.id);
  if (unfinished.length) throw new Error(`Cannot retire ${assignee}; it still owns unfinished tasks: ${unfinished.join(", ")}.`);

  const owner = await seat(root, assignee);
  if (owner.retired) throw new Error(`Seat ${assignee} is already retired.`);
  try {
    const primary = (await project(root, projectName)).repository;
    const primaryCheckout = allowPrimaryCheckout && primary && await canonicalPath(owner.worktree) === await canonicalPath(primary);
    const summary = (primaryCheckout ? `Primary checkout ${owner.worktree} retained; retired without worktree finish.` : undefined)
      ?? (allowAbsentWorktree ? await absentUnregisteredWorktree(root, projectName, owner) : undefined)
      ?? await finishOrProveMerged(root, projectName, owner);
    owner.retired = { task: `${projectName}/${id}`, completed_at: now(), summary };
    await atomicYaml(paths(root).seatFile(assignee), owner);
    const checkpoint: Checkpoint = {
      schema: "atdd-workflow/checkpoint/v1", seat: assignee, status: "complete", updated_at: now(),
      summary: `Retired after ${projectName}/${id}: ${summary}`,
      next_action: "No active worktree remains; spawn a new seat before assigning new work.",
      references: [`task:${projectName}/${id}`],
    };
    await atomicYaml(paths(root).checkpointFile(assignee), checkpoint);
  } catch (error) {
    const checkpoint: Checkpoint = {
      schema: "atdd-workflow/checkpoint/v1", seat: assignee, status: "blocked", updated_at: now(),
      summary: `Housekeeping after ${projectName}/${id} failed: ${(error as Error).message}`,
      next_action: "Inspect the worktree and rerun task completion only after resolving the cleanup failure.",
      references: [`task:${projectName}/${id}`],
    };
    await atomicYaml(paths(root).checkpointFile(assignee), checkpoint);
    throw error;
  }
  const { closeRetiredDriverWorkspace } = await import("./multiplexer");
  await closeRetiredDriverWorkspace(root, owner);
}

/** Only main retires a coordinator; a driver may also be retired by the coordinator of every task assigned to it. */
async function assertRetireAuthority(root: string, owner: Seat, actor: string, owned: ListedTask[]) {
  const main = `main@${owner.project}`;
  if (owner.role === "coordinator") {
    if (actor !== main) throw new Error(`Only ${main} may retire coordinator ${owner.address}.`);
  } else if (actor !== main && owned.some((entry) => entry.task.coordinator !== actor)) {
    throw new Error(`Only ${main} or the coordinator of every task assigned to ${owner.address} may retire it.`);
  }
}

/**
 * Retires a driver whose assigned tasks are all terminal (done, superseded, or rejected), or, for main only, a coordinator
 * (never main) whose coordinated and assigned tasks are all terminal. A non-main coordinator on the
 * primary checkout retires its record without invoking worktree finish.
 */
export async function retireSeat(root: string, address: string, args: string[]) {
  const resolved = await canonicalAddress(root, address);
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  const owner = await seat(root, resolved);
  const coordinator = owner.role === "coordinator";
  if (owner.role !== "driver" && !coordinator) throw new Error(`Only driver or coordinator seats can be retired; ${resolved} is ${owner.role}.`);
  if (owner.retired) throw new Error(`Seat ${resolved} is already retired.`);
  const owned = (await allTasks(root, owner.project))
    .filter((entry) => entry.task.assignee === resolved || (coordinator && entry.task.coordinator === resolved));
  if (!owned.length) throw new Error(`Cannot retire ${resolved}; it has no ${coordinator ? "coordinated or " : ""}assigned tasks.`);
  const unfinished = owned.filter((entry) => !terminal(entry.task)).map((entry) => entry.id);
  if (unfinished.length) throw new Error(`Cannot retire ${resolved}; it still owns unfinished tasks: ${unfinished.join(", ")}.`);
  await assertRetireAuthority(root, owner, actor, owned);
  await retireDriver(root, owner.project, resolved, owned.at(-1)!.id, true, coordinator && resolved !== `main@${owner.project}`);
  console.log(`${resolved}  retired`);
}

export async function add(root: string, projectName: string, id: string, args: string[]) {
  const normalizedId = taskId(id);
  await project(root, projectName);
  if (await exists(paths(root).taskFile(projectName, normalizedId))) throw new Error(`Task ${normalizedId} already exists and cannot be replaced.`);
  const coordinator = await canonicalAddress(root, required(words(args, "--coordinator"), "--coordinator"));
  const assigneeValue = words(args, "--assignee");
  const assignee = assigneeValue ? await canonicalAddress(root, assigneeValue) : undefined;
  await seat(root, coordinator);
  const base = assignee ? await evidenceBase(root, projectName, coordinator, await eligibleAssignee(root, projectName, assignee)) : undefined;
  // External tracker adapters provide the display status only at intake. A To Do
  // event opts the new task into governed PLAN; later display labels never
  // mutate Flow's durable phase. Unrecognized entry states cannot skip PLAN.
  const trackerStatus = words(args, "--tracking-status");
  if (trackerStatus && trackerStatus.replace(/[\s_-]/g, "").toLowerCase() !== "todo")
    throw new Error("Tracked task intake must begin at To Do; external status cannot bypass Flow PLAN.");
  const governedIntake = args.includes("--plan-required") || Boolean(trackerStatus);
  const doneWhen = values(args, "--done-when").map((text) => ({ text }));
  if (!doneWhen.length) throw new Error("A task needs at least one --done-when criterion.");
  const dependsOn = words(args, "--depends-on")?.split(",").filter(Boolean).map(taskId);
  const task: Task = {
    schema: "atdd-workflow/task/v1",
    title: required(words(args, "--title"), "--title"),
    status: "todo",
    // Existing Flow task CLI remains compatible; external tracker adapters
    // deliberately opt into strict engineering transitions at To Do intake.
    ...(governedIntake ? { phase: "plan" as const, plan_required: true as const } : {}),
    coordinator,
    ...(assignee ? { assignee } : {}),
    ...(base ? { governed_base: base } : {}),
    ...(words(args, "--body") ? { body: words(args, "--body") } : {}),
    ...(words(args, "--source") ? { source: words(args, "--source") } : {}),
    ...(dependsOn?.length ? { depends_on: dependsOn } : {}),
    done_when: doneWhen,
  };
  await writeTask(root, projectName, normalizedId, task);
  console.log(normalizedId);
}

export async function assign(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may assign task ${id}.`);
  if (task.status !== "todo") throw new Error(`Task ${id} can only be assigned while todo.`);
  if (task.assignee) throw new Error(`Task ${id} is already assigned to ${task.assignee}.`);
  const assignee = await canonicalAddress(root, required(words(args, "--assignee"), "--assignee"));
  const target = await eligibleAssignee(root, projectName, assignee);
  const base = await evidenceBase(root, projectName, task.coordinator, target);
  const immediate = args.includes("--immediate") ? await dispatchImmediately(root, projectName, id, task, target, args) : undefined;
  task.assignee = assignee;
  if (base) task.governed_base = base;
  if (immediate) task.immediate_dispatch = immediate;
  await writeTask(root, projectName, id, task);
  console.log(`${id}  assigned  ${assignee}${immediate ? "  dispatched" : ""}`);
}

/** The assignee's todo -> in_progress transition is the only writer of start evidence. */
function recordDispatchStart(task: Task, next: TaskStatus, actor: string) {
  if (next === "in_progress" && task.status === "todo" && task.immediate_dispatch) {
    task.immediate_dispatch.start = { by: actor, transitioned_at: now() };
  }
}

async function quietly<T>(run: () => Promise<T>) {
  const log = console.log;
  console.log = () => {};
  try { return await run(); }
  finally { console.log = log; }
}

/**
 * Fails closed before any write when the assignee has no native queue, then persists one task-linked
 * dispatch through the existing native mail path. The task write that claims "dispatched" happens last.
 */
async function dispatchImmediately(root: string, projectName: string, id: string, task: Task, target: Seat, args: string[]): Promise<ImmediateDispatch> {
  const priority = required(words(args, "--priority"), "--priority");
  const boundary = required(words(args, "--mutation-boundary"), "--mutation-boundary");
  const threads = await import("./threads");
  if (!threads.hasNativeQueue(target)) throw new Error(`Assignee ${target.address} has no native queue; immediate assignment needs a native Flow inbox.`);
  const thread = await quietly(() => threads.startThread(root, [
    "--with", `${task.coordinator},${target.address}`, "--subject", `Immediate assignment ${projectName}/${id}`, "--task", `${projectName}/${id}`,
  ]));
  const body = [
    `Immediate assignment: ${projectName}/${id}`, `Priority: ${priority}`, `Mutation boundary: ${boundary}`,
    `Acknowledge (typed, not prose): atdd-flow task acknowledge ${projectName} ${id} --dispatch <this message id> --by ${target.address}`,
    `Start: atdd-flow task start ${projectName} ${id} --by ${target.address}`,
  ].join("\n");
  const message = await quietly(() => threads.post(root, thread, ["--from", task.coordinator, "--to", target.address, "--label", "dispatch", "--expects-result", "--body", body]));
  return { thread, message, priority, mutation_boundary: boundary, assignee: target.address, status: "dispatched" };
}

/** Binds an acknowledgement to the exact stored dispatch and assignee; it never changes task status. */
export async function acknowledge(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  const dispatch = required(words(args, "--dispatch"), "--dispatch");
  const stored = task.immediate_dispatch;
  if (!stored) throw new Error(`Task ${id} has no immediate dispatch.`);
  if (dispatch !== stored.message) throw new Error(`${dispatch} is not the dispatch for task ${id}.`);
  if (actor !== stored.assignee || actor !== task.assignee) throw new Error(`Only ${stored.assignee} may acknowledge task ${id}.`);
  if (terminal(task)) throw new Error(`Task ${id} is already ${task.status}.`);
  if (!stored.acknowledgement) {
    stored.acknowledgement = { dispatch, by: actor, acknowledged_at: now() };
    await writeTask(root, projectName, id, task);
  }
  console.log(`${id}  acknowledged  ${actor}`);
}

function missingSignal(task: Task): "missing_acknowledgement" | "missing_start" | undefined {
  const stored = task.immediate_dispatch;
  if (!stored || terminal(task)) return undefined;
  if (!stored.acknowledgement) return "missing_acknowledgement";
  return task.status === "todo" ? "missing_start" : undefined;
}

/** On demand and bounded: posts at most one alert per missing state, then returns the stored one. */
export async function observeAssignment(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may observe the assignment of task ${id}.`);
  const stored = task.immediate_dispatch;
  if (!stored) throw new Error(`Task ${id} has no immediate dispatch.`);
  const state = missingSignal(task);
  if (!state) { console.log(`${id}  no missing signal`); return; }
  const existing = stored.alerts?.[state];
  if (existing) { console.log(`${id}  ${state}  ${existing.message}`); return; }
  const action = state === "missing_acknowledgement"
    ? `atdd-flow task acknowledge ${projectName} ${id} --dispatch ${stored.message} --by ${stored.assignee}`
    : `atdd-flow task start ${projectName} ${id} --by ${stored.assignee}`;
  const { post } = await import("./threads");
  const message = await quietly(() => post(root, stored.thread, ["--from", task.coordinator, "--to", stored.assignee, "--label", state, "--expects-result", "--body",
    `Alert ${state} for ${projectName}/${id} (dispatch ${stored.message}). Run: ${action}`]));
  stored.alerts = { ...stored.alerts, [state]: { key: `${stored.message}/${state}`, message, observed_at: now() } };
  await writeTask(root, projectName, id, task);
  console.log(`${id}  ${state}  ${message}`);
}

type TransferAuthorization = {
  schema: "atdd-workflow/task-transfer-authorization/v1";
  project: string;
  task: string;
  from: string;
  to: string;
  reason: string;
  exact_head: { branch: string; commit: string };
};

async function operatorAuthorization(root: string, reference: string, main: string, expected: TransferAuthorization) {
  const authorization = await operatorAuthorizationPayload(root, reference, main) as TransferAuthorization | undefined;
  if (!authorization || authorization.schema !== expected.schema
    || authorization.project !== expected.project || authorization.task !== expected.task
    || authorization.from !== expected.from || authorization.to !== expected.to
    || authorization.reason !== expected.reason
    || authorization.exact_head?.branch !== expected.exact_head.branch
    || authorization.exact_head.commit !== expected.exact_head.commit) {
    throw new Error(`Authorization ${reference} is not an exact transfer authorization.`);
  }
}

/**
 * Changes only the current task accountability projection. The record is
 * append-only and validates the target's existing topology; it never creates,
 * moves, cleans, or binds a seat/worktree.
 */
export async function transfer(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const config = await project(root, projectName);
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  const target = await canonicalAddress(root, required(words(args, "--to"), "--to"));
  const main = `main@${config.project}`;
  if (target === task.coordinator) throw new Error(`Task ${id} is already accountable to ${target}.`);
  if (actor !== main && actor !== task.coordinator) throw new Error(`Only ${main} or the current coordinator may transfer task ${id}.`);

  // governedBase confirms main/named-coordinator identity, exact branch head,
  // and the driver's descendant relationship before accountability changes.
  const governed = await governedLineage(root, projectName, target, task.assignee);
  const base = governed?.base;
  if (!governed || !base) throw new Error(`Task ${id} needs an assigned driver and governed repository before transfer.`);
  const authorization = actor === main ? required(words(args, "--authorization"), "an owner-authorized topology plan") : undefined;
  if (authorization) await operatorAuthorization(root, authorization, main, {
    schema: "atdd-workflow/task-transfer-authorization/v1",
    project: config.project,
    task: id,
    from: task.coordinator,
    to: target,
    reason: required(words(args, "--reason"), "--reason"),
    exact_head: { branch: base.branch, commit: base.commit },
  });
  const transfer: CoordinatorTransfer = {
    from: task.coordinator,
    to: target,
    reason: required(words(args, "--reason"), "--reason"),
    ...(authorization ? { authorization } : {}),
    exact_head: { branch: base.branch, commit: base.commit },
    lineage_ref: governed.lineage,
    effective_at: now(),
  };
  task.coordinator = target;
  task.governed_base = base;
  task.coordinator_transfers = [...(task.coordinator_transfers ?? []), transfer];
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  coordinator transferred  ${transfer.from} -> ${transfer.to}`);
}

export async function amend(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  if (task.disposition) throw new Error(`Task ${id} has a terminal disposition and cannot be amended.`);
  const title = words(args, "--title");
  const body = words(args, "--body");
  const source = words(args, "--source");
  const dependencies = words(args, "--depends-on");
  if (!title && !body && !source && !dependencies) {
    throw new Error("Provide --title, --body, --source, or --depends-on.");
  }
  if (title) task.title = title;
  if (body) task.body = body;
  if (source) task.source = source;
  if (dependencies) task.depends_on = dependencies.split(",").filter(Boolean).map(taskId);
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  amended`);
}

/**
 * Records an already-completed task during a migration. Unlike `done`, this
 * does not invent an assignee or a live lifecycle transition: the supplied
 * evidence is the sole basis for the historical completion record.
 */
export async function importCompleted(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  if (task.disposition) throw new Error(`Task ${id} has a terminal disposition and cannot be imported.`);
  const proofs = values(args, "--proof");
  if (!proofs.length) throw new Error("An imported completion needs at least one --proof reference.");

  const criteria = values(args, "--done-when");
  const texts = criteria.length ? criteria : task.done_when.map((entry) => entry.text);
  if (texts.length !== proofs.length) {
    throw new Error("Provide one --proof for every existing or supplied --done-when criterion.");
  }
  const doneWhen = texts.map((text, index) => ({ text, proof: proofs[index] }));

  const source = words(args, "--source");
  if (source) task.source = source;
  task.status = "done";
  task.done_when = doneWhen;
  delete task.blocker;
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  imported done`);
}

async function transition(root: string, projectName: string, id: string, next: TaskStatus, by: string, retire = false) {
  const task = await readTask(root, projectName, id);
  const actor = await canonicalAddress(root, by);
  if (!transitions[task.status].includes(next)) throw new Error(`Task ${id} cannot move from ${task.status} to ${next}.`);
  if (next === "in_progress" && task.status === "todo") {
    if (!task.assignee) throw new Error(`Task ${id} has no assignee.`);
    if (actor !== task.assignee) throw new Error(`Only ${task.assignee} may start task ${id}.`);
    const waiting = await ready(root, projectName, task);
    if (waiting.length) throw new Error(`Task ${id} is waiting on: ${waiting.join(", ")}.`);
  }
  if (next === "in_progress" && task.status === "review" && actor !== task.coordinator) {
    throw new Error(`Only ${task.coordinator} may return task ${id} to work.`);
  }
  if (next === "review") {
    if (!task.assignee || actor !== task.assignee) throw new Error(`Only ${task.assignee ?? "the assignee"} may submit task ${id} for review.`);
    if (task.plan_required && (task.phase !== "refactor" ||
      task.handoff?.submitted_phase !== "refactor" || task.handoff.state !== "awaiting_assignee" ||
      !task.handoff.plan_review))
      throw new Error(`Task ${id} requires accepted PLAN, RED, GREEN and REFACTOR handoffs before review.`);
    if (!allProofs(task)) throw new Error(`Task ${id} is missing proof for: ${task.done_when.filter((entry) => !entry.proof).map((entry) => entry.text).join("; ")}`);
  }
  if (next === "done") {
    if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may complete task ${id}.`);
    if (!allProofs(task)) throw new Error(`Task ${id} is missing completion proof.`);
    const { assertParentMayComplete } = await import("./ephemeral-resources");
    await assertParentMayComplete(root, { project: projectName, task: id });
    const { assertAcceptedBehavioralReview } = await import("./reviews");
    await assertAcceptedBehavioralReview(root, projectName, id, task);
    if (retire) await retireAssignee(root, projectName, id, task);
  }
  recordDispatchStart(task, next, actor);
  task.status = next;
  if (next !== "in_progress") { delete task.blocker; delete task.deferred; }
  await writeTask(root, projectName, id, task);
  console.log(`${id}  ${next}`);
}

export async function start(root: string, projectName: string, id: string, args: string[]) {
  return transition(root, projectName, taskId(id), "in_progress", required(words(args, "--by"), "--by"));
}

export async function review(root: string, projectName: string, id: string, args: string[]) {
  return transition(root, projectName, taskId(id), "review", required(words(args, "--by"), "--by"));
}

export async function done(root: string, projectName: string, id: string, args: string[]) {
  return transition(root, projectName, taskId(id), "done", required(words(args, "--by"), "--by"), args.includes("--retire-assignee"));
}

export async function returnToWork(root: string, projectName: string, id: string, args: string[]) {
  return transition(root, projectName, taskId(id), "in_progress", required(words(args, "--by"), "--by"));
}

const phases: TaskPhase[] = ["plan", "red", "green", "refactor"];
const handoffOutcomes = ["accept", "return"] as const;

type HandoffOutcome = typeof handoffOutcomes[number];

function phase(value: string | undefined): TaskPhase {
  const selected = required(value, "--phase");
  if (!phases.includes(selected as TaskPhase)) throw new Error(`--phase must be one of: ${phases.join(", ")}.`);
  return selected as TaskPhase;
}

function handoffOutcome(value: string | undefined): HandoffOutcome {
  const selected = required(value, "--outcome");
  if (!(handoffOutcomes as readonly string[]).includes(selected)) throw new Error("--outcome must be accept or return.");
  return selected as HandoffOutcome;
}

/** PLAN evidence is bound to one committed repository artifact and declared
 * acceptances; a dirty working-tree draft cannot impersonate that revision. */
async function verifiedPlan(root: string, projectName: string, id: string, task: Task, args: string[]) {
  const source = required(words(args, "--plan-source"), "--plan-source");
  const revision = required(words(args, "--plan-revision"), "--plan-revision");
  const acceptances = values(args, "--acceptance");
  const ratification = words(args, "--operator-ratification");
  const delegation = words(args, "--coach-delegation");
  if (Boolean(ratification) === Boolean(delegation))
    throw new Error("PLAN requires exactly one --operator-ratification or --coach-delegation owner authorization.");
  if (!/^plan\/[A-Za-z0-9._/-]+\.(?:yaml|yml|md)$/.test(source) ||
      source.split("/").includes("..") || source.split("/").includes("."))
    throw new Error("PLAN source must be a canonical repository-relative plan artifact.");
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("PLAN revision must be an exact 40-character Git commit.");
  if (!acceptances.length || new Set(acceptances).size !== acceptances.length ||
      acceptances.some(x => !/^acc:[A-Za-z0-9:_-]+$/.test(x)))
    throw new Error("PLAN requires distinct declared acc: acceptance URNs.");
  if (!/^M-[A-Za-z0-9._-]+$/.test((ratification ?? delegation)!))
    throw new Error("PLAN requires an exact operator@desk authorization message ID.");
  const assignee = await seat(root, required(task.assignee, "a PLAN assignee"));
  const config = await project(root, projectName);
  const actual = await currentCommit(vcsMode(config), assignee.worktree);
  if (actual !== revision)
    throw new Error("PLAN source revision does not match the driver's current commit.");
  const item = (await runOutput(["git", "-C", assignee.worktree, "ls-tree", revision, "--", source])).trim();
  if (!/^(100644|100755) blob [a-f0-9]{40}\t/.test(item))
    throw new Error("PLAN source is not a regular committed plan artifact at the supplied revision.");
  const dirty = (await runOutput(["git", "-C", assignee.worktree, "status", "--porcelain", "--", source])).trim();
  if (dirty) throw new Error("PLAN source contains uncommitted changes; commit or restore the submitted artifact.");
  // A substring is not an acceptance declaration (acc:FOO must not match acc:FOOBAR).
  // Evaluate the submitted blob, not an unrelated plan/ file or the mutable worktree.
  const contents = await runOutput(["git", "-C", assignee.worktree, "show", revision + ":" + source]);
  for (const urn of acceptances) {
    // URNs are restricted to regex-literal-safe [A-Za-z0-9:_-] at input.
    const exact = new RegExp("(^|[^A-Za-z0-9:_-])" + urn + "($|[^A-Za-z0-9:_-])", "m");
    if (!exact.test(contents))
      throw new Error(`Acceptance ${urn} is not declared in submitted plan source ${source}.`);
  }
  const plan = { source, revision, acceptances, worktree: await realpath(assignee.worktree),
    ...(ratification ? { ratification } : { delegation: delegation! }) };
  // Refuse forged or stale approvals at submission, not only once the Coach
  // tries to advance the task. No unratified PLAN reaches a review inbox.
  await verifyPlanRatification(root, projectName, id, task, plan);
  return plan;
}

/** The Coach reviews but cannot replace the operator's authoring authority.
 * The operator's typed message must bind the identical PLAN tuple. */
async function verifyPlanRatification(root: string, projectName: string, id: string,
  task: Task, plan: NonNullable<TaskHandoff["plan"]>) {
  const { operatorAuthorizationPayload } = await import("./task-supersede-authorization");
  const reference = plan.delegation ?? plan.ratification;
  if (!reference || Boolean(plan.delegation) === Boolean(plan.ratification))
    throw new Error("PLAN requires precisely one owner authorization mode.");
  const actual = await operatorAuthorizationPayload(root, reference, `main@${projectName}`);
  const expected = plan.delegation ? {
    schema: "atdd-workflow/plan-coach-delegation/v1", project: projectName, task: id,
    coordinator: task.coordinator, assignee: task.assignee, action: "delegate-plan-review",
    title: task.title, criteria: task.done_when.map(item => item.text),
  } : {
    schema: "atdd-workflow/plan-ratification/v1", project: projectName, task: id,
    coordinator: task.coordinator, assignee: task.assignee, action: "ratify",
    source: plan.source, revision: plan.revision, acceptances: plan.acceptances,
  };
  if (!actual || typeof actual !== "object" || Array.isArray(actual) ||
      !isDeepStrictEqual(actual, expected))
    throw new Error("PLAN ratification is not an exact operator@desk approval of this scoped plan.");
}

/** Reject a stale authoring revision before giving the driver RED guidance. */
async function verifyPlanCurrent(root: string, projectName: string, task: Task,
  plan: NonNullable<TaskHandoff["plan"]>) {
  const owner = await seat(root, required(task.assignee, "a PLAN assignee"));
  const config = await project(root, projectName);
  if (!plan.worktree || await realpath(owner.worktree) !== plan.worktree)
    throw new Error("PLAN driver worktree changed after handoff; resubmit from the originally assigned worktree.");
  if (await currentCommit(vcsMode(config), owner.worktree) !== plan.revision)
    throw new Error("PLAN changed after submission; resubmit at the current revision.");
  if ((await runOutput(["git", "-C", owner.worktree, "status", "--porcelain", "--", plan.source])).trim())
    throw new Error("PLAN artifact has uncommitted changes after submission; restore or resubmit.");
}

/** Review evidence must be a durable message posted by the accountable Coach
 * in the task's own thread, not just an arbitrary string supplied at the CLI. */
async function verifyCoachPlanReview(root: string, projectName: string, id: string,
  task: Task, reference: string, revision: string, acceptances: string[]) {
  if (!/^M-[A-Za-z0-9._-]+$/.test(reference))
    throw new Error("Coach PLAN review requires one canonical M- message reference.");
  const { readdir } = await import("node:fs/promises");
  const dirs = await readdir(paths(root).threads, { withFileTypes: true });
  const candidates = await Promise.all(dirs.filter(x => x.isDirectory() && x.name.startsWith("T-"))
    .map(async x => {
      try {
        const [thread, message] = await Promise.all([
          readYaml<{task?:string;participants?:string[]}>(paths(root).threadFile(x.name)),
          readYaml<{schema?:string;id?:string;from?:string;to?:"all"|string[];body?:string;created_at?:string}>(paths(root).message(x.name, reference)),
        ]);
        return { thread, message };
      } catch { return undefined; }
    }));
  const matches = candidates.filter(x => x?.thread.task === `${projectName}/${id}` &&
    x.message.schema === "atdd-workflow/message/v1" && x.message.id === reference &&
    x.message.from === task.coordinator && x.thread.participants?.includes(task.assignee ?? "") &&
    (x.message.to === "all" || x.message.to?.includes(task.assignee ?? "") === true) &&
    typeof x.message.created_at === "string" &&
    !Number.isNaN(Date.parse(x.message.created_at)) &&
    Date.parse(x.message.created_at) >= Date.parse(task.handoff?.updated_at ?? "") &&
    x.message.body?.startsWith("PLAN APPROVE " + revision + "\n") &&
    x.message.body.slice(("PLAN APPROVE " + revision + "\n").length).trim().length >= 10 &&
    acceptances.every(urn => x.message.body?.includes(urn)));
  if (matches.length !== 1)
    throw new Error("Coach PLAN review requires a task-linked message naming the exact plan revision.");
}

/** PLAN failures still reach the accountable Coach, but never advance task
 * state. Notification failure cannot turn invalid evidence into acceptance. */
async function reportPlanBlocker(root: string, projectName: string, id: string,
  task: Task, actor: string, reason: string): Promise<void> {
  const { threadsForSeat, startThread, post } = await import("./threads");
  const thread = (await threadsForSeat(root, actor).catch(() => []))
    .find(({record}) => record.task === `${projectName}/${id}` &&
      record.participants.includes(task.coordinator));
  const threadId = thread?.threadId ?? await startThread(root, [
    "--with", actor + "," + task.coordinator,
    "--subject", "PLAN evidence blocker " + id,
    "--task", projectName + "/" + id,
  ]);
  await post(root, threadId, [
    "--from", actor, "--to", task.coordinator,
    "--body", "PLAN BLOCKED " + projectName + "/" + id + ": " + reason +
      "\\nNext action: correct the scoped plan/evidence or escalate missing intent and authority; do not accept PLAN to RED.",
  ]);
}

/**
 * The assignee records work as ready for a coordinator decision. The evidence
 * value is deliberately opaque: it links an immutable message/reference but
 * never parses message prose or changes the task lifecycle.
 */
export async function submitHandoff(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (!task.assignee || actor !== task.assignee) throw new Error(`Only ${task.assignee ?? "the assignee"} may submit a handoff for task ${id}.`);
  if (task.status !== "in_progress") throw new Error(`Task ${id} must be in_progress before a handoff is submitted.`);
  if (task.handoff?.state === "awaiting_coordinator") throw new Error(`Task ${id} is already awaiting coordinator handoff response.`);
  const evidence = required(words(args, "--evidence"), "--evidence");
  const submitted = phase(words(args, "--phase"));
  if (task.plan_required && submitted !== task.phase)
    throw new Error(`Task ${id} is in ${task.phase?.toUpperCase()}, not ${submitted.toUpperCase()}; phase skipping is forbidden.`);
  let plan = task.handoff?.plan;
  if (task.plan_required && submitted === "plan") {
    try { plan = await verifiedPlan(root, projectName, id, task, args); }
    catch (e) {
      try { await reportPlanBlocker(root, projectName, id, task, actor, String(e)); }
      catch { /* A notification is never evidence and cannot override refusal. */ }
      throw e;
    }
  }
  task.phase = submitted;
  task.handoff = {
    state: "awaiting_coordinator", evidence, updated_at: now(), submitted_phase: submitted,
    ...(plan ? { plan } : {}),
    ...(task.handoff?.plan_review ? { plan_review: task.handoff.plan_review } : {}),
  };
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  handoff awaiting_coordinator`);
}

/**
 * The coordinator accepts a handoff for the assignee's next phase or returns
 * it to active execution. This only updates the optional projection.
 */
export async function respondToHandoff(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may respond to task ${id} handoff.`);
  if (task.status !== "in_progress") throw new Error(`Task ${id} must be in_progress before a handoff is answered.`);
  if (task.handoff?.state !== "awaiting_coordinator") throw new Error(`Task ${id} is not awaiting coordinator handoff response.`);
  const outcome = handoffOutcome(words(args, "--outcome"));
  const requested = phase(words(args, "--phase"));
  const submitted = phase(task.handoff.submitted_phase ?? task.phase ?? "plan");
  if (task.plan_required && task.phase !== submitted)
    throw new Error("PLAN handoff phase does not match the authoritative task phase.");
  const next = phaseOrder[phaseOrder.indexOf(submitted) + 1] ?? submitted;
  let planReview: TaskHandoff["plan_review"];
  let returnReason: string | undefined;
  if (task.plan_required) {
    if (outcome === "return" && submitted === "plan") {
      returnReason = required(words(args, "--reason"),
        "a scoped PLAN return reason and next action (--reason)");
      if (returnReason.trim().length < 10)
        throw new Error("PLAN return must explain the missing evidence or escalation action.");
    }
    if (outcome === "accept" && requested !== next)
      throw new Error(`Accepting ${submitted.toUpperCase()} must advance to ${next.toUpperCase()}.`);
    if (outcome === "return" && requested !== submitted)
      throw new Error(`Returning ${submitted.toUpperCase()} must retain that phase.`);
    if (outcome === "accept" && submitted === "plan") {
      const plan = task.handoff.plan;
      if (!plan) throw new Error("PLAN is missing a committed plan and its acceptance references.");
      const proof = required(words(args, "--plan-review"), "Coach PLAN review evidence (--plan-review)");
      await verifyPlanCurrent(root, projectName, task, plan);
      await verifyPlanRatification(root, projectName, id, task, plan);
      await verifyCoachPlanReview(root, projectName, id, task, proof, plan.revision, plan.acceptances);
      planReview = { by: actor, evidence: proof, at: now(), ratification: (plan.delegation ?? plan.ratification)! };
    }
  }
  task.phase = requested;
  task.handoff = {
    ...task.handoff,
    ...(planReview ? { plan_review: planReview } : {}),
    ...(returnReason ? { return_reason: returnReason } : {}),
    state: outcome === "accept" ? "awaiting_assignee" : "executing",
    updated_at: now(),
  };
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  handoff ${task.handoff.state}`);
}

export async function prove(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (!task.assignee || actor !== task.assignee) throw new Error(`Only ${task.assignee ?? "the assignee"} may add proof to task ${id}.`);
  if (task.status !== "in_progress") throw new Error(`Task ${id} must be in_progress before proof is added.`);
  const item = Number(required(words(args, "--item"), "--item"));
  if (!Number.isInteger(item) || item < 1 || item > task.done_when.length) throw new Error(`--item must be between 1 and ${task.done_when.length}.`);
  task.done_when[item - 1].proof = required(words(args, "--proof"), "--proof");
  await writeTask(root, projectName, id, task);
  console.log(`${id}  proof ${item}`);
}

export async function block(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  if (task.disposition) throw new Error(`Task ${id} has a terminal disposition and cannot be blocked.`);
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.assignee && actor !== task.coordinator) throw new Error(`Only the assignee or coordinator may block task ${id}.`);
  if (task.status === "done") throw new Error(`Completed task ${id} cannot be blocked.`);
  task.blocker = required(words(args, "--reason"), "--reason");
  await writeTask(root, projectName, id, task);
  console.log(`${id}  blocked`);
}

/**
 * Records a terminal coordinator decision (superseded or rejected). Only the task coordinator may
 * decide, a completed or already-disposed task is never rewritten, and the decision keeps its
 * author, time, and reason as immutable audit history.
 */
export async function disposition(root: string, projectName: string, id: string, kind: TerminalDisposition["kind"], args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  const owner = kind === "superseded" && actor === `main@${projectName}` && actor !== task.coordinator && Boolean(words(args, "--authorization"));
  if (actor !== task.coordinator && !owner) throw new Error(`Only ${task.coordinator} may ${kind} task ${id}.`);
  if (task.disposition || task.status === "done") throw new Error(`Task ${id} already has terminal history and cannot be ${kind}.`);
  const reason = required(words(args, "--reason"), "--reason");
  const reference = owner ? words(args, "--authorization") : undefined;
  const authorization = reference ? await (await import("./task-supersede-authorization")).authorizeSupersede(root, { project: projectName, id, coordinator: task.coordinator, reason, main: actor, reference }) : undefined;
  task.status = kind;
  task.disposition = { kind, by: actor, at: now(), reason, ...(authorization ? { authorization } : {}) };
  delete task.blocker;
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  ${kind}`);
}

/**
 * Holds a task behind a bounded deferral. The accountable owner, the trigger, and an ISO-8601 review
 * point are mandatory, so a deferral can never become an indefinite open blocker; unblocking clears it.
 */
export async function defer(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may defer task ${id}.`);
  if (task.disposition || task.status === "done") throw new Error(`Task ${id} has terminal history and cannot be deferred.`);
  const ownerValue = words(args, "--owner");
  const trigger = words(args, "--trigger");
  const reviewAt = words(args, "--review-at");
  if (!ownerValue || !trigger || !reviewAt) throw new Error("A defer needs --owner, --trigger, and --review-at.");
  if (Number.isNaN(Date.parse(reviewAt))) throw new Error("--review-at must be an ISO-8601 timestamp.");
  const owner = await canonicalAddress(root, ownerValue);
  if ((await seat(root, owner)).project !== projectName) throw new Error(`Deferred owner ${owner} does not belong to project ${projectName}.`);
  const reason = required(words(args, "--reason"), "--reason");
  task.deferred = { by: actor, at: now(), reason, owner, trigger, review_at: reviewAt };
  task.blocker = `Deferred until ${reviewAt}: ${reason}`;
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  deferred`);
}

export async function unblock(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may unblock task ${id}.`);
  if (task.status !== "todo" && task.status !== "in_progress") throw new Error(`Task ${id} can only be unblocked while todo or in_progress.`);
  if (!task.blocker) throw new Error(`Task ${id} has no blocker to clear.`);
  const waiting = await ready(root, projectName, task);
  if (waiting.length) throw new Error(`Task ${id} is waiting on: ${waiting.join(", ")}.`);
  const { assertDependentsMayUnblock } = await import("./ephemeral-resources");
  await assertDependentsMayUnblock(root, { project: projectName, task: id });
  delete task.blocker;
  delete task.deferred;
  await writeTask(root, projectName, id, task);
  console.log(`${id}  unblocked`);
}

export async function list(root: string, projectName: string, args: string[]) {
  const coordinator = words(args, "--coordinator") ? await canonicalAddress(root, required(words(args, "--coordinator"), "--coordinator")) : undefined;
  const assignee = words(args, "--assignee") ? await canonicalAddress(root, required(words(args, "--assignee"), "--assignee")) : undefined;
  for (const entry of await allTasks(root, projectName)) {
    if (coordinator && entry.task.coordinator !== coordinator || assignee && entry.task.assignee !== assignee) continue;
    const waiting = entry.task.status === "todo" ? await ready(root, projectName, entry.task) : [];
    const proof = `${entry.task.done_when.filter((item) => item.proof).length}/${entry.task.done_when.length}`;
    console.log(`${entry.id}  ${entry.task.status}  proof:${proof}  ${entry.task.title}${waiting.length ? `  waiting:${waiting.join(",")}` : ""}${entry.task.blocker ? `  blocked:${entry.task.blocker}` : ""}`);
  }
}

export async function open(root: string, projectName: string, id: string) {
  console.log(Bun.YAML.stringify(await readTask(root, projectName, taskId(id))));
}

export type TaskDirective = {
  project: string;
  task: string;
  lifecycle: "TODO" | "PLAN" | "RED" | "GREEN" | "REFACTOR" | "REVIEW" | "BLOCKED";
  role: "assignee" | "coordinator";
  action: string;
  command?: string;
};

const phaseActions: Record<TaskPhase, string> = {
  plan: "Prepare and submit PLAN handoff",
  red: "Commit focused test-only RED handoff",
  green: "Implement the accepted GREEN scope",
  refactor: "Refactor only after GREEN acceptance, then submit the REFACTOR handoff",
};

const phaseOrder: TaskPhase[] = ["plan", "red", "green", "refactor"];

const phaseCommand = (projectName: string, id: string, address: string, current: TaskPhase) =>
  `atdd-flow task handoff ${projectName} ${id} --by ${address} --phase ${current} --evidence <message-or-reference>` +
    (current === "plan" ? " --plan-source <plan/path.yaml> --plan-revision <commit> --acceptance <acc:urn> (--operator-ratification <M-owner> | --coach-delegation <M-owner-scope>)" : "");

/** An assignee whose submitted phase was accepted without naming a later phase is directed forward, never to resubmit. */
function acceptedDirective(base: Pick<TaskDirective, "project" | "task" | "role">, id: string, address: string, current: TaskPhase): TaskDirective {
  const next = phaseOrder[phaseOrder.indexOf(current) + 1];
  if (!next) {
    return {
      ...base, lifecycle: "REVIEW", action: "REFACTOR accepted; record a proof for every done_when item, then submit the task for review.",
      command: `atdd-flow task review ${base.project} ${id} --by ${address}`,
    };
  }
  return {
    ...base, lifecycle: next.toUpperCase() as TaskDirective["lifecycle"], action: `${current.toUpperCase()} accepted; ${phaseActions[next]}.`,
    command: phaseCommand(base.project, id, address, next),
  };
}

async function assigneeDirective(root: string, projectName: string, id: string, task: Task, address: string): Promise<TaskDirective> {
  const as = { project: projectName, task: id, role: "assignee" as const };
  if (task.status === "review") return { ...as, lifecycle: "REVIEW", action: "Await coordinator review; do not continue implementation." };
  if (task.status === "todo") {
    const waiting = await ready(root, projectName, task);
    return waiting.length
      ? { ...as, lifecycle: "TODO", action: `Wait; dependencies are unfinished: ${waiting.join(", ")}.` }
      : { ...as, lifecycle: "TODO", action: "Start assigned ready task.", command: `atdd-flow task start ${projectName} ${id} --by ${address}` };
  }
  const current = task.phase ?? "plan";
  const lifecycle = current.toUpperCase() as TaskDirective["lifecycle"];
  if (task.handoff?.state === "awaiting_coordinator") return { ...as, lifecycle, action: `Await coordinator response to the ${lifecycle} handoff; do not continue to the next phase.` };
  if (task.handoff?.state === "awaiting_assignee" && task.handoff.submitted_phase === current) return acceptedDirective(as, id, address, current);
  if (task.plan_required && task.handoff?.state === "executing" && task.handoff.return_reason)
    return { ...as, lifecycle, action: `PLAN returned: ${task.handoff.return_reason} Revise and resubmit the same scoped plan.`,
      command: phaseCommand(projectName, id, address, current) };
  return { ...as, lifecycle, action: `${phaseActions[current]}.`, command: phaseCommand(projectName, id, address, current) };
}

function coordinatorDirective(projectName: string, id: string, task: Task, address: string): TaskDirective | undefined {
  const as = { project: projectName, task: id, role: "coordinator" as const };
  if (task.blocker) return { ...as, lifecycle: "BLOCKED", action: `Resolve the blocker (${task.blocker}) and then unblock the task.`, command: `atdd-flow task unblock ${projectName} ${id} --by ${address}` };
  if (task.status === "review") return { ...as, lifecycle: "REVIEW", action: "Review the submitted task; complete it or return it to work.", command: `atdd-flow task open ${projectName} ${id}` };
  if (task.status === "in_progress" && task.handoff?.state === "awaiting_coordinator") {
    const current = task.phase ?? "plan";
    const plan = task.handoff.plan;
    const suffix = current === "plan" && task.plan_required
      ? ` Inspect committed ${plan?.source ?? "UNKNOWN"}@${plan?.revision ?? "UNKNOWN"},` +
        " verify the accepted criteria and operator ratification. On acceptance provide --plan-review <M-coach>; on return give --reason <missing-evidence-or-escalation-action>."
      : "";
    return { ...as, lifecycle: current.toUpperCase() as TaskDirective["lifecycle"],
      action: `Accept or return the ${current.toUpperCase()} handoff.${suffix}`,
      command: `atdd-flow task respond ${projectName} ${id} --by ${address} --outcome <accept|return> --phase <plan|red|green|refactor>` +
        (current === "plan" && task.plan_required ? " (--plan-review <M-coach> | --reason <return-or-escalation-action>)" : "") };
  }
  return undefined;
}

/**
 * Pure projection of an existing task record; it creates no durable state. Terminal and deferred tasks
 * yield nothing for any role, a blocked assignee is told nothing, and only the coordinator hears of a blocker.
 */
async function directiveFor(root: string, projectName: string, id: string, task: Task, address: string): Promise<TaskDirective | undefined> {
  if (terminal(task) || task.deferred) return undefined;
  if (task.assignee === address && !task.blocker) return assigneeDirective(root, projectName, id, task, address);
  return task.coordinator === address ? coordinatorDirective(projectName, id, task, address) : undefined;
}

const directiveRank = (directive: TaskDirective, task: Task) =>
  directive.lifecycle === "BLOCKED" ? 3 : task.status === "todo" ? 2 : task.status === "review" ? 1 : 0;

/**
 * Derives the one next required action for an address from authoritative task
 * records. Mail is intentionally not an input, and nothing is persisted.
 */
export async function nextDirective(root: string, address: string): Promise<TaskDirective | undefined> {
  const owner = await readYaml<Seat>(paths(root).seatFile(address));
  if (owner.retired) return undefined;
  const entries = await seatTasks(root, owner.project, address);
  const candidates: { directive: TaskDirective; task: Task }[] = [];
  for (const entry of entries) {
    const directive = await directiveFor(root, owner.project, entry.id, entry.task, address);
    if (directive) candidates.push({ directive, task: entry.task });
  }
  const best = (role: "assignee" | "coordinator") => {
    return candidates.filter((entry) => entry.directive.role === role)
      .sort((left, right) => directiveRank(left.directive, left.task) - directiveRank(right.directive, right.task))[0];
  };
  return (best("assignee") ?? best("coordinator"))?.directive;
}

/** Compact wake text; task state is named as the authority over any mail. */
export function directiveNotice(address: string, directive: TaskDirective) {
  return `SYSTEM: authoritative next action for ${address} on ${directive.project}/${directive.task} [${directive.lifecycle}] from task state: ${directive.action}${directive.command ? ` Command: ${directive.command}.` : ""} Task state outranks mail; mail is notification only.`;
}
