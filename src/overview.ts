import { readdir } from "node:fs/promises";
import { desk, exists, paths, readYaml, type Checkpoint, type Seat } from "./core";
import { type Task, type TaskStatus } from "./tasks";
import { type Message, type Thread } from "./threads";

type ListedTask = { project: string; id: string; task: Task; waiting: string[] };
type ListedSeat = { project: string; record: Seat; checkpoint?: Checkpoint };
type ListedThread = { record: Thread; pending: string[] };
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
  const entries = await Promise.all((await names(folder)).filter((file) => file.endsWith(".yaml")).map(async (file) => ({
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
    const all = await Promise.all((await names(paths(root).thread(id)))
      .filter((file) => file.startsWith("M-") && file.endsWith(".yaml"))
      .map((file) => readYaml<Message>(`${paths(root).thread(id)}/${file}`)));
    const pending = all.flatMap((message) => {
      if (!message.expects_result) return [];
      const recipients = message.to === "all" ? record.participants.filter((address) => address !== message.from) : message.to;
      return recipients
        .filter((address) => !all.some((reply) => reply.kind === "result" && reply.in_reply_to === message.id && reply.from === address))
        .map((address) => `${message.id}@${address}`);
    });
    return { record, pending };
  }))).filter((entry): entry is ListedThread => Boolean(entry));
}

function rule(title: string, suffix = "") {
  const width = terminalWidth();
  const text = `  ${title}${suffix ? `  ${suffix}` : ""} `;
  console.log(`${muted("─".repeat(2))}${strong(text)}${muted("─".repeat(Math.max(2, width - text.length - 2)))}`);
}

function bar(done: number, total: number, width = 16) {
  const filled = total ? Math.round((done / total) * width) : 0;
  return `${paint("█".repeat(filled), 36)}${muted("░".repeat(width - filled))}`;
}

function stateName(status: TaskStatus) {
  return ({ todo: "READY", in_progress: "ACTIVE", review: "REVIEW", done: "DONE" } as Record<TaskStatus, string>)[status];
}

function attentionForTask(entry: ListedTask, checkpointBySeat: Map<string, Checkpoint | undefined>): Attention | undefined {
  const { task } = entry;
  const inspect = `atdd-workflow task open ${entry.project} ${entry.id}`;
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
    detail: checkpoint.next_action || checkpoint.summary, command: `atdd-workflow open ${task.assignee}`, priority: 1,
  };
  if (task.status === "in_progress" && checkpoint?.status === "unverified") return {
    project: entry.project, id: entry.id, label: task.title, state: "VERIFY",
    detail: "The assigned seat has not been reconciled with a current holder.", command: `atdd-workflow open ${task.assignee}`, priority: 2,
  };
  return undefined;
}

function attentionForThread(entry: ListedThread): Attention[] {
  return entry.pending.map((pending) => ({
    id: entry.record.id, label: entry.record.subject, state: "WAITING", detail: `A result is still expected from ${pending.slice(pending.indexOf("@") + 1)}.`,
    command: `atdd-workflow thread open ${entry.record.id}`, priority: 4,
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
  if (items.length > displayed.length) console.log(`  ${muted(`+ ${items.length - displayed.length} more items; run \`atdd-workflow status --all\` for the full audit.`)}`);
}

function printProjects(projects: string[], allTasks: ListedTask[], allSeats: ListedSeat[]) {
  rule("WORKSTREAMS");
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
  if (ready.length) return console.log(`  ${strong("1.")} atdd-workflow task open ${ready[0].project} ${ready[0].id}`);
  console.log(`  ${muted("The Desk is clear. Use `status --all` to inspect the full record.")}`);
}

async function dashboard(root: string) {
  const [record, projectList, threadList] = await Promise.all([desk(root), projectNames(root), threads(root)]);
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
  const width = terminalWidth();
  console.log(`${muted("╭─")} ${strong("DESK")} ${muted("─".repeat(Math.max(2, width - record.desk.length - 12)))} ${strong(record.desk)} ${muted("─╮")}`);
  console.log(`${muted("│")}  ${facts.padEnd(width - 4)}${muted("│")}`);
  console.log(`${muted("│")}  ${muted(`application: ${record.application}`.padEnd(width - 4))}${muted("│")}`);
  console.log(`${muted("╰")}${muted("─".repeat(width - 2))}${muted("╯")}`);
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

async function printSeats(root: string, projectName: string) {
  for (const entry of await seats(root, projectName)) {
    const { record, checkpoint } = entry;
    console.log(`${record.address}  ${record.role}  ${record.agent}  ${checkpoint?.status ?? "unverified"}${record.purpose ? `  ${record.purpose}` : ""}`);
  }
}

async function printTasks(root: string, projectName: string) {
  for (const { id, task, waiting } of await tasks(root, projectName)) {
    const proof = `${task.done_when.filter((item) => item.proof).length}/${task.done_when.length}`;
    console.log(`${projectName}/${id}  ${task.status}  proof:${proof}  ${task.assignee ?? "unassigned"}  ${task.title}${waiting.length ? `  waiting:${waiting.join(",")}` : ""}${task.blocker ? `  blocked:${task.blocker}` : ""}`);
  }
}

async function audit(root: string) {
  const projects = await projectNames(root);
  console.log("SEATS");
  for (const project of projects) await printSeats(root, project);
  console.log("TASKS");
  for (const project of projects) await printTasks(root, project);
  console.log("THREADS");
  for (const entry of await threads(root)) console.log(`${entry.record.id}  ${entry.record.state}  ${entry.record.subject}${entry.pending.length ? `  waiting:${entry.pending.join(",")}` : ""}`);
}

export async function status(root: string, args: string[] = []) {
  if (args.includes("--all")) return audit(root);
  if (args.length) throw new Error("Use `atdd-workflow status` or `atdd-workflow status --all`.");
  return dashboard(root);
}
