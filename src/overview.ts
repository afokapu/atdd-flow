import { readdir } from "node:fs/promises";
import { canonicalAddress, desk, exists, paths, readYaml, type Checkpoint, type Seat } from "./core";
import { type Task, type TaskStatus } from "./tasks";
import { isRuntimeStateStale, readRuntimeState } from "./runtime-state";
import { type Message, type Thread } from "./threads";

type ListedTask = { project: string; id: string; task: Task; waiting: string[] };
type ListedSeat = { project: string; record: Seat; checkpoint?: Checkpoint };
type ListedThread = { record: Thread; messages: Message[]; pending: string[] };
type Attention = { project?: string; id: string; label: string; state: string; detail: string; command: string; priority: number };

const terminalWidth = () => Math.max(72, Math.min(process.stdout.columns || 100, 120));
const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");
const paint = (text: string, code: number) => useColor ? `\u001B[${code}m${text}\u001B[0m` : text;
const muted = (text: string) => paint(text, 2);
const strong = (text: string) => paint(text, 1);
const tone = (text: string, state: string) => paint(text, ({ BLOCKED: 31, RE_SEAT: 31, REVIEW: 33, WAITING: 33, ASSIGN: 36, VERIFY: 35, ACTIVE: 36, DONE: 32 } as Record<string, number>)[state] ?? 37);
const truncate = (value: string, width: number) => value.length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}…`;
const dot = " · ";

async function names(folder: string) {
  try { return (await readdir(folder)).sort(); }
  catch { return []; }
}

async function projectNames(root: string) {
  const candidates = await names(paths(root).work);
  return (await Promise.all(candidates.map(async (name) => ({ name, valid: await exists(paths(root).projectFile(name)) }))))
    .filter((entry) => entry.valid)
    .map((entry) => entry.name);
}

async function seats(root: string, project: string): Promise<ListedSeat[]> {
  const locals = await names(paths(root).seats(project));
  return (await Promise.all(locals.map(async (local) => {
    const address = `${local}@${project}`;
    const file = paths(root).seatFile(address);
    if (!await exists(file)) return undefined;
    const checkpointFile = paths(root).checkpointFile(address);
    return {
      project,
      record: await readYaml<Seat>(file),
      ...(await exists(checkpointFile) ? { checkpoint: await readYaml<Checkpoint>(checkpointFile) } : {}),
    };
  }))).filter((entry): entry is ListedSeat => Boolean(entry));
}

async function tasks(root: string, project: string): Promise<ListedTask[]> {
  const folder = paths(root).tasks(project);
  const entries = await Promise.all((await names(folder)).filter((file) => file.endsWith(".yaml") && !file.endsWith(".reviews.yaml")).map(async (file) => ({
    project,
    id: file.slice(0, -5),
    task: await readYaml<Task>(`${folder}/${file}`),
  })));
  const byId = new Map(entries.map((entry) => [entry.id, entry.task]));
  return entries.map((entry) => ({
    ...entry,
    waiting: (entry.task.depends_on ?? []).filter((dependency) => byId.get(dependency)?.status !== "done"),
  }));
}

async function threads(root: string): Promise<ListedThread[]> {
  const ids = await names(paths(root).threads);
  return (await Promise.all(ids.map(async (id) => {
    const threadFile = paths(root).threadFile(id);
    if (!await exists(threadFile)) return undefined;
    const record = await readYaml<Thread>(threadFile);
    const messages = await Promise.all((await names(paths(root).thread(id)))
      .filter((file) => file.startsWith("M-") && file.endsWith(".yaml"))
      .map((file) => readYaml<Message>(`${paths(root).thread(id)}/${file}`)));
    const pending = messages.flatMap((message) => {
      if (!message.expects_result) return [];
      const recipients = message.to === "all" ? record.participants.filter((address) => address !== message.from) : message.to;
      return recipients
        .filter((address) => !messages.some((reply) => reply.kind === "result" && reply.in_reply_to === message.id && reply.from === address))
        .map((address) => `${message.id}@${address}`);
    });
    return { record, messages, pending };
  }))).filter((entry): entry is ListedThread => Boolean(entry));
}

function rule(title: string, suffix = "") {
  const width = terminalWidth();
  const text = `  ${title}${suffix ? `  ${suffix}` : ""} `;
  console.log(`${muted("─".repeat(2))}${strong(text)}${muted("─".repeat(Math.max(2, width - text.length - 2)))}`);
}

function header(title: string, deskName: string, facts: string, application: string) {
  const width = terminalWidth();
  console.log(`${muted("╭─")} ${strong(title)} ${muted("─".repeat(Math.max(2, width - deskName.length - title.length - 9)))} ${strong(deskName)} ${muted("─╮")}`);
  console.log(`${muted("│")}  ${facts.padEnd(width - 4)}${muted("│")}`);
  console.log(`${muted("│")}  ${muted(`application: ${application}`.padEnd(width - 4))}${muted("│")}`);
  console.log(`${muted("╰")}${muted("─".repeat(width - 2))}${muted("╯")}`);
}

function bar(done: number, total: number, width = 16) {
  const filled = total ? Math.round((done / total) * width) : 0;
  return `${paint("█".repeat(filled), 36)}${muted("░".repeat(width - filled))}`;
}

function stateName(status: TaskStatus) {
  return ({ todo: "READY", in_progress: "ACTIVE", review: "REVIEW", done: "DONE" } as Record<TaskStatus, string>)[status];
}

function taskPhase(entry: ListedTask) {
  if (entry.task.blocker) return "BLOCKED";
  if (entry.waiting.length) return "WAITING";
  return stateName(entry.task.status);
}

function attentionForTask(entry: ListedTask, checkpointBySeat: Map<string, Checkpoint | undefined>): Attention | undefined {
  const { task } = entry;
  const inspect = `atdd-flow task open ${entry.project} ${entry.id}`;
  if (task.status === "done") return undefined;
  if (task.blocker) return {
    project: entry.project, id: entry.id, label: task.title, state: "BLOCKED", detail: task.blocker,
    command: inspect, priority: 0,
  };
  if (task.status === "review") return {
    project: entry.project, id: entry.id, label: task.title, state: "REVIEW",
    detail: `${task.done_when.filter((item) => item.proof).length}/${task.done_when.length} proof items supplied; coordinator action required.`,
    command: inspect, priority: 1,
  };
  if (entry.waiting.length) return {
    project: entry.project, id: entry.id, label: task.title, state: "WAITING",
    detail: `Waiting on ${entry.waiting.join(", ")}.`, command: inspect, priority: 2,
  };
  if (!task.assignee) return {
    project: entry.project, id: entry.id, label: task.title, state: "ASSIGN",
    detail: "Ready to start, but no driver owns it.", command: inspect, priority: 3,
  };
  const checkpoint = checkpointBySeat.get(task.assignee);
  if (task.status === "in_progress" && checkpoint?.status === "blocked") return {
    project: entry.project, id: entry.id, label: task.title, state: "RE_SEAT",
    detail: checkpoint.next_action || checkpoint.summary, command: `atdd-flow open ${task.assignee}`, priority: 1,
  };
  if (task.status === "in_progress" && checkpoint?.status === "unverified") return {
    project: entry.project, id: entry.id, label: task.title, state: "VERIFY",
    detail: "The assigned seat has not been reconciled with a current holder.", command: `atdd-flow open ${task.assignee}`, priority: 2,
  };
  return undefined;
}

function attentionForThread(entry: ListedThread): Attention[] {
  return entry.pending.map((pending) => ({
    id: entry.record.id, label: entry.record.subject, state: "WAITING", detail: `A result is still expected from ${pending.slice(pending.indexOf("@") + 1)}.`,
    command: `atdd-flow thread open ${entry.record.id}`, priority: 4,
  }));
}

function printAttention(items: Attention[]) {
  rule("ATTENTION", String(items.length));
  if (!items.length) return console.log(`  ${tone("✓", "DONE")} ${muted("Nothing needs a coordinator decision right now.")}`);
  const displayed = items.slice(0, 6);
  const width = terminalWidth();
  for (const item of displayed) {
    const heading = `${item.project ? `${item.project}${dot}` : ""}${item.id}`;
    const state = tone(item.state.replace("_", "-"), item.state);
    console.log(`  ${tone("!", item.state)} ${strong(truncate(heading, 33))}  ${muted("·")} ${state}`);
    console.log(`    ${truncate(item.label, width - 4)}`);
    console.log(`    ${muted(truncate(item.detail, width - 4))}`);
  }
  if (items.length > displayed.length) console.log(`  ${muted(`+ ${items.length - displayed.length} more items; run \`atdd-flow status --all\` for the full audit.`)}`);
}

function printProjects(projects: string[], allTasks: ListedTask[], allSeats: ListedSeat[]) {
  rule(projects.length === 1 ? "WORKSTREAM" : "WORKSTREAMS");
  const width = terminalWidth();
  for (const project of projects) {
    const tasks = allTasks.filter((entry) => entry.project === project);
    const seats = allSeats.filter((entry) => entry.project === project);
    const done = tasks.filter((entry) => entry.task.status === "done").length;
    const active = seats.filter((entry) => entry.checkpoint?.status === "active").length;
    const blocked = seats.filter((entry) => entry.checkpoint?.status === "blocked").length;
    const nameWidth = Math.min(22, Math.max(14, Math.floor(width / 4)));
    const counts = `${done}/${tasks.length} done${active ? `${dot}${active} active` : ""}${blocked ? `${dot}${blocked} blocked` : ""}`;
    console.log(`  ${strong(truncate(project, nameWidth).padEnd(nameWidth))} ${bar(done, tasks.length)}  ${counts}`);
  }
}

function printInFlight(allTasks: ListedTask[]) {
  const active = allTasks.filter((entry) => ["in_progress", "review"].includes(entry.task.status));
  rule("IN FLIGHT", String(active.length));
  if (!active.length) return console.log(`  ${muted("No task is currently in progress or awaiting review.")}`);
  for (const entry of active.slice(0, 5)) {
    const proof = `${entry.task.done_when.filter((item) => item.proof).length}/${entry.task.done_when.length} proof`;
    const suffix = ` · ${proof} · ${entry.task.assignee ?? "unassigned"}`;
    console.log(`  ${tone("●", stateName(entry.task.status))} ${strong(truncate(`${entry.project}/${entry.id}`, 42))}  ${tone(stateName(entry.task.status), stateName(entry.task.status))}`);
    console.log(`    ${truncate(entry.task.title, terminalWidth() - 4 - suffix.length)}${muted(suffix)}`);
  }
}

function readyTasks(allTasks: ListedTask[]) {
  return allTasks.filter((entry) => entry.task.status === "todo" && !entry.task.blocker && !entry.waiting.length && entry.task.assignee);
}

function printReady(allTasks: ListedTask[]) {
  const ready = readyTasks(allTasks);
  rule("READY QUEUE", String(ready.length));
  if (!ready.length) return console.log(`  ${muted("No assigned task is clear to start yet.")}`);
  for (const entry of ready.slice(0, 5)) {
    console.log(`  ${tone("→", "ACTIVE")} ${strong(truncate(`${entry.project}/${entry.id}`, 42))}  ${tone("READY", "ACTIVE")}`);
    console.log(`    ${truncate(entry.task.title, terminalWidth() - 4)} ${muted(`· ${entry.task.assignee}`)}`);
  }
}

function printNext(items: Attention[], allTasks: ListedTask[]) {
  const ready = readyTasks(allTasks);
  rule("NEXT");
  if (items.length) return void items.slice(0, 3).forEach((item, index) => console.log(`  ${strong(`${index + 1}.`)} ${item.command}`));
  if (ready.length) return console.log(`  ${strong("1.")} atdd-flow task open ${ready[0].project} ${ready[0].id}`);
  console.log(`  ${muted("The Desk is clear. Use `status --all` to inspect the full record.")}`);
}

function threadMatchesProject(entry: ListedThread, project: string) {
  return entry.record.task?.startsWith(`${project}/`) || entry.record.participants.some((address) => address.slice(address.lastIndexOf("@") + 1) === project);
}

async function selectedProjects(root: string, requested?: string) {
  const all = await projectNames(root);
  if (!requested) return all;
  if (!all.includes(requested)) throw new Error(`Project does not exist in this Desk: ${requested}`);
  return [requested];
}

async function dashboard(root: string, requestedProject?: string) {
  const [record, projectList, allThreads] = await Promise.all([desk(root), selectedProjects(root, requestedProject), threads(root)]);
  const threadList = requestedProject ? allThreads.filter((entry) => threadMatchesProject(entry, requestedProject)) : allThreads;
  const [allSeats, allTasks] = await Promise.all([
    Promise.all(projectList.map((project) => seats(root, project))).then((entries) => entries.flat()),
    Promise.all(projectList.map((project) => tasks(root, project))).then((entries) => entries.flat()),
  ]);
  const checkpointBySeat = new Map(allSeats.map((entry) => [entry.record.address, entry.checkpoint]));
  const attention = [
    ...allTasks.flatMap((entry) => {
      const item = attentionForTask(entry, checkpointBySeat);
      return item ? [item] : [];
    }),
    ...threadList.flatMap(attentionForThread),
  ].sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label));
  const openThreads = threadList.filter((entry) => entry.record.state === "open").length;
  const facts = `${projectList.length} workstreams${dot}${allSeats.length} seats${dot}${allTasks.length} tasks${dot}${openThreads} live threads`;
  const title = requestedProject ? `DESK / ${requestedProject}` : "DESK";
  header(title, record.desk, facts, record.application);
  console.log("");
  printAttention(attention);
  console.log("");
  printProjects(projectList, allTasks, allSeats);
  console.log("");
  printInFlight(allTasks);
  console.log("");
  printReady(allTasks);
  console.log("");
  printNext(attention, allTasks);
}

async function taskDashboard(root: string, projectName: string, taskId: string) {
  await selectedProjects(root, projectName);
  const entry = (await tasks(root, projectName)).find((item) => item.id === taskId);
  if (!entry) throw new Error(`Task does not exist in ${projectName}: ${taskId}`);
  const record = await desk(root);
  const threadList = (await threads(root)).filter((item) => item.record.task === `${projectName}/${taskId}`);
  const proof = `${entry.task.done_when.filter((item) => item.proof).length}/${entry.task.done_when.length} proof`;
  header(`TASK / ${projectName}/${taskId}`, record.desk, `${taskPhase(entry)}${dot}${proof}`, record.application);
  console.log(`\n  ${strong(entry.task.title)}`);
  rule("OWNERSHIP");
  console.log(`  coordinator  ${entry.task.coordinator}`);
  console.log(`  assignee     ${entry.task.assignee ?? muted("unassigned")}`);
  rule("DEPENDENCIES", String((entry.task.depends_on ?? []).length));
  if (!entry.task.depends_on?.length) console.log(`  ${muted("Independent; it may proceed in parallel.")}`);
  for (const dependency of entry.task.depends_on ?? []) console.log(`  ${entry.waiting.includes(dependency) ? tone("○", "WAITING") : tone("✓", "DONE")} ${dependency}${entry.waiting.includes(dependency) ? `  ${tone("WAITING", "WAITING")}` : ""}`);
  rule("DEFINITION OF DONE", proof);
  for (const [index, item] of entry.task.done_when.entries()) {
    const mark = item.proof ? tone("✓", "DONE") : muted("○");
    console.log(`  ${mark} ${index + 1}. ${item.text}${item.proof ? `\n      ${muted(item.proof)}` : ""}`);
  }
  rule("CONTEXT");
  console.log(`  source  ${entry.task.source ?? muted("none")}`);
  console.log(`  brief   ${entry.task.body ? truncate(entry.task.body.replace(/\s+/g, " "), terminalWidth() - 10) : muted("none")}`);
  if (entry.task.blocker) console.log(`  ${tone("blocker", "BLOCKED")} ${truncate(entry.task.blocker, terminalWidth() - 12)}`);
  rule("RELATED THREADS", String(threadList.length));
  if (!threadList.length) console.log(`  ${muted("No thread links directly to this task.")}`);
  for (const thread of threadList) console.log(`  ${thread.record.id}  ${thread.record.subject}${thread.pending.length ? `  ${tone(`${thread.pending.length} waiting`, "WAITING")}` : ""}`);
  const { behavioralReviewRequired, readBehavioralReviews } = await import("./reviews");
  const reviewRequired = await behavioralReviewRequired(root, entry.task);
  const reviewHistory = await readBehavioralReviews(root, projectName, taskId);
  const latestReview = reviewHistory?.attempts.at(-1);
  rule("FINAL BEHAVIORAL REVIEW", latestReview?.result?.decision ?? latestReview?.status?.toUpperCase() ?? (reviewRequired ? "REQUIRED" : "OPTIONAL"));
  if (!latestReview) console.log(`  ${muted(reviewRequired ? "No final behavioral review has been launched." : "No final behavioral review is required by current Workflow governance.")}`);
  if (latestReview) {
    console.log(`  ${latestReview.id}  ${latestReview.routing.classification}  ${latestReview.reviewer.model}  ${latestReview.status}`);
    if (latestReview.result) console.log(`  ${latestReview.result.decision}  ${truncate(latestReview.result.rationale, terminalWidth() - 12)}`);
  }

  rule("NEXT");
  let next: string;
  if (entry.task.blocker) next = "Resolve the recorded blocker before changing state.";
  else if (entry.waiting.length) next = "Complete the unmet dependencies first.";
  else if (entry.task.status === "review" && reviewRequired && !latestReview) next = `Coordinator: launch final review with \`atdd-flow behavioral-review launch ${projectName} ${taskId} --by ${entry.task.coordinator} --application <application> --placement <container>.\``;
  else if (entry.task.status === "review" && latestReview?.status === "pending") next = `Await reviewer ${latestReview.reviewer.address}; inspect with \`atdd-flow behavioral-review open ${projectName} ${taskId}.\``;
  else if (entry.task.status === "review" && latestReview?.result?.decision === "RETURN") next = `Coordinator: return the task with \`atdd-flow task return ${projectName} ${taskId} --by ${entry.task.coordinator}.\``;
  else if (entry.task.status === "review" && latestReview?.result?.decision === "ESCALATE") next = "Coordinator: resolve authoritative intent; keep the task in review or block it explicitly.";
  else if (entry.task.status === "review") next = `Coordinator: complete with \`atdd-flow task done ${projectName} ${taskId} --by ${entry.task.coordinator}.\``;
  else if (entry.task.assignee) next = `Driver: start with \`atdd-flow task start ${projectName} ${taskId} --by ${entry.task.assignee}.\``;
  else next = "Coordinator: assign a driver before this task can start.";
  console.log(`  ${next}`);
}

async function seatDashboard(root: string, address: string) {
  const record = await desk(root);
  const resolved = await canonicalAddress(root, address);
  const projectList = await projectNames(root);
  const allSeats = (await Promise.all(projectList.map((project) => seats(root, project)))).flat();
  const entry = allSeats.find((item) => item.record.address === resolved);
  if (!entry) throw new Error(`Seat does not exist in this Desk: ${address}`);
  const owned = (await tasks(root, entry.project)).filter((item) => item.task.assignee === resolved || item.task.coordinator === resolved);
  const threadList = (await threads(root)).filter((item) => item.record.participants.includes(resolved));
  const checkpoint = entry.checkpoint;
  header(`SEAT / ${resolved}`, record.desk, `${entry.record.role}${dot}${entry.record.runtime?.model ?? entry.record.agent ?? "dynamic"}${dot}${checkpoint?.status ?? "unverified"}`, record.application);
  console.log(`\n  ${entry.record.purpose ?? muted("No responsibility statement recorded.")}`);
  rule("CHECKPOINT", checkpoint?.status ?? "UNVERIFIED");
  if (!checkpoint) console.log(`  ${muted("No checkpoint has been written for this seat.")}`);
  if (checkpoint) {
    console.log(`  ${truncate(checkpoint.summary, terminalWidth() - 4)}`);
    console.log(`  ${muted(`next: ${truncate(checkpoint.next_action, terminalWidth() - 10)}`)}`);
  }
  rule("WORK");
  console.log(`  branch    ${entry.record.branch}`);
  console.log(`  worktree  ${entry.record.worktree}`);
  if (entry.record.retired) console.log(`  ${tone("retired", "DONE")} ${entry.record.retired.summary}`);
  rule("RUNTIME");
  const runtime = entry.record.runtime;
  if (!runtime) console.log(`  ${muted("No live application is currently attached.")}`);
  for (const [application, nativeAddress] of Object.entries(runtime?.addresses ?? {})) console.log(`  ${application}${application === runtime?.application ? " *" : "  "} ${nativeAddress}`);
  const advisory = await readRuntimeState(root, resolved);
  if (advisory) console.log(`  pi advisory  ${isRuntimeStateStale(advisory, 60_000) ? "stale" : "active"} · ${advisory.model} · pid ${advisory.pid} · heartbeat ${advisory.heartbeat_at}`);
  rule("RESPONSIBILITIES", String(owned.length));
  if (!owned.length) console.log(`  ${muted("No task currently names this seat.")}`);
  for (const task of owned.slice(0, 6)) console.log(`  ${tone("●", taskPhase(task))} ${task.id}  ${taskPhase(task)}${task.task.assignee === resolved ? "  owner" : "  coordinator"}`);
  rule("THREADS", String(threadList.length));
  if (!threadList.length) console.log(`  ${muted("No thread includes this seat.")}`);
  for (const thread of threadList.slice(0, 6)) console.log(`  ${thread.record.id}  ${truncate(thread.record.subject, terminalWidth() - 32)}${thread.pending.some((item) => item.endsWith(`@${resolved}`)) ? `  ${tone("REPLY", "WAITING")}` : ""}`);
  rule("NEXT");
  console.log(`  ${checkpoint?.next_action ?? "Attach a host or record a checkpoint before assigning new work."}`);
}

async function threadDashboard(root: string, threadId: string) {
  const record = await desk(root);
  const entry = (await threads(root)).find((item) => item.record.id === threadId);
  if (!entry) throw new Error(`Thread does not exist in this Desk: ${threadId}`);
  header(`THREAD / ${threadId}`, record.desk, `${entry.record.state}${dot}${entry.record.participants.length} participants${dot}${entry.pending.length} results waiting`, record.application);
  console.log(`\n  ${strong(entry.record.subject)}`);
  rule("PARTICIPANTS", String(entry.record.participants.length));
  for (const participant of entry.record.participants) console.log(`  ${participant}`);
  rule("LINK");
  console.log(`  task  ${entry.record.task ?? muted("none")}`);
  console.log(`  summary  ${entry.record.summary ?? muted("none")}`);
  rule("CONVERSATION", String(entry.messages.length));
  if (!entry.messages.length) console.log(`  ${muted("No messages have been posted yet.")}`);
  for (const message of entry.messages.slice(-8)) {
    const recipient = message.to === "all" ? "all" : message.to.join(", ");
    console.log(`  ${tone(message.kind.toUpperCase(), message.kind === "result" ? "DONE" : message.kind === "receipt" ? "ACTIVE" : "WAITING")}  ${message.from} → ${recipient}  ${muted(message.created_at.slice(0, 16).replace("T", " "))}`);
    console.log(`    ${truncate(message.body.replace(/\s+/g, " "), terminalWidth() - 4)}`);
  }
  rule("WAITING", String(entry.pending.length));
  if (!entry.pending.length) console.log(`  ${tone("✓", "DONE")} ${muted("No requested result is outstanding.")}`);
  for (const pending of entry.pending) console.log(`  ${tone("○", "WAITING")} ${pending}`);
  rule("NEXT");
  console.log(`  ${entry.pending.length ? "The named recipient(s) should post a result against the outstanding message." : "This thread has no outstanding result obligation."}`);
}

async function printSeats(root: string, projectName: string) {
  for (const entry of await seats(root, projectName)) {
    const { record, checkpoint } = entry;
    console.log(`${record.address}  ${record.role}  ${record.runtime?.model ?? record.agent ?? "dynamic"}  ${checkpoint?.status ?? "unverified"}${record.purpose ? `  ${record.purpose}` : ""}`);
  }
}

async function printTasks(root: string, projectName: string) {
  for (const { id, task, waiting } of await tasks(root, projectName)) {
    const proof = `${task.done_when.filter((item) => item.proof).length}/${task.done_when.length}`;
    console.log(`${projectName}/${id}  ${task.status}  proof:${proof}  ${task.assignee ?? "unassigned"}  ${task.title}${waiting.length ? `  waiting:${waiting.join(",")}` : ""}${task.blocker ? `  blocked:${task.blocker}` : ""}`);
  }
}

async function audit(root: string, requestedProject?: string) {
  const projects = await selectedProjects(root, requestedProject);
  console.log("SEATS");
  for (const project of projects) await printSeats(root, project);
  console.log("TASKS");
  for (const project of projects) await printTasks(root, project);
  console.log("THREADS");
  for (const entry of (requestedProject ? (await threads(root)).filter((item) => threadMatchesProject(item, requestedProject)) : await threads(root))) console.log(`${entry.record.id}  ${entry.record.state}  ${entry.record.subject}${entry.pending.length ? `  waiting:${entry.pending.join(",")}` : ""}`);
}

export async function status(root: string, args: string[] = []) {
  const all = args.includes("--all");
  const [scope, ...values] = args.filter((argument) => argument !== "--all");
  if (args.some((argument) => argument.startsWith("-") && argument !== "--all")) throw new Error("Use `atdd-flow status [project|task|seat|thread] ... [--all]`.");
  if (!scope) return all ? audit(root) : dashboard(root);
  if (scope === "project" && values.length === 1) return all ? audit(root, values[0]) : dashboard(root, values[0]);
  if (scope === "task" && values.length === 2) return taskDashboard(root, values[0], values[1]);
  if (scope === "seat" && values.length === 1) return seatDashboard(root, values[0]);
  if (scope === "thread" && values.length === 1) return threadDashboard(root, values[0]);
  throw new Error("Use `atdd-flow status [project <project>|task <project> <task-id>|seat <address>|thread <thread-id>] [--all]`.");
}
