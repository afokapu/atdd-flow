import { readdir } from "node:fs/promises";
import {
  atomicYaml, canonicalAddress, paths, project, readYaml, required, seat, taskId, values, words,
} from "./core";

export type TaskStatus = "todo" | "in_progress" | "review" | "done";
export type DoneWhen = { text: string; proof?: string };
export type Task = {
  schema: "atdd-seat/task/v1";
  title: string;
  status: TaskStatus;
  coordinator: string;
  assignee?: string;
  body?: string;
  source?: string;
  depends_on?: string[];
  blocker?: string;
  done_when: DoneWhen[];
};

type ListedTask = { id: string; task: Task };

const transitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress"],
  in_progress: ["review"],
  review: ["in_progress", "done"],
  done: [],
};

async function readTask(root: string, projectName: string, id: string) {
  const record = await readYaml<Task>(paths(root).taskFile(projectName, id));
  if (record.schema !== "atdd-seat/task/v1") throw new Error(`Unsupported task schema: ${id}`);
  return record;
}

async function allTasks(root: string, projectName: string): Promise<ListedTask[]> {
  const folder = paths(root).tasks(projectName);
  let files: string[];
  try { files = await readdir(folder); }
  catch { return []; }
  return Promise.all(files.filter((file) => file.endsWith(".yaml")).sort().map(async (file) => ({ id: file.slice(0, -5), task: await readTask(root, projectName, file.slice(0, -5)) })));
}

async function ready(root: string, projectName: string, task: Task) {
  const dependencies = await Promise.all((task.depends_on ?? []).map(async (id) => ({ id, task: await readTask(root, projectName, id) })));
  return dependencies.filter((entry) => entry.task.status !== "done").map((entry) => entry.id);
}

function allProofs(task: Task) {
  return task.done_when.every((entry) => Boolean(entry.proof));
}

async function writeTask(root: string, projectName: string, id: string, task: Task) {
  await atomicYaml(paths(root).taskFile(projectName, id), task);
}

export async function add(root: string, projectName: string, id: string, args: string[]) {
  await project(root, projectName);
  const coordinator = await canonicalAddress(root, required(words(args, "--coordinator"), "--coordinator"));
  const assigneeValue = words(args, "--assignee");
  const assignee = assigneeValue ? await canonicalAddress(root, assigneeValue) : undefined;
  await seat(root, coordinator);
  if (assignee) await seat(root, assignee);
  const doneWhen = values(args, "--done-when").map((text) => ({ text }));
  if (!doneWhen.length) throw new Error("A task needs at least one --done-when criterion.");
  const dependsOn = words(args, "--depends-on")?.split(",").filter(Boolean).map(taskId);
  const task: Task = {
    schema: "atdd-seat/task/v1",
    title: required(words(args, "--title"), "--title"),
    status: "todo",
    coordinator,
    ...(assignee ? { assignee } : {}),
    ...(words(args, "--body") ? { body: words(args, "--body") } : {}),
    ...(words(args, "--source") ? { source: words(args, "--source") } : {}),
    ...(dependsOn?.length ? { depends_on: dependsOn } : {}),
    done_when: doneWhen,
  };
  await writeTask(root, projectName, taskId(id), task);
  console.log(id);
}

async function transition(root: string, projectName: string, id: string, next: TaskStatus, by: string) {
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
    if (!allProofs(task)) throw new Error(`Task ${id} is missing proof for: ${task.done_when.filter((entry) => !entry.proof).map((entry) => entry.text).join("; ")}`);
  }
  if (next === "done") {
    if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may complete task ${id}.`);
    if (!allProofs(task)) throw new Error(`Task ${id} is missing completion proof.`);
  }
  task.status = next;
  if (next !== "in_progress") delete task.blocker;
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
  return transition(root, projectName, taskId(id), "done", required(words(args, "--by"), "--by"));
}

export async function returnToWork(root: string, projectName: string, id: string, args: string[]) {
  return transition(root, projectName, taskId(id), "in_progress", required(words(args, "--by"), "--by"));
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
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.assignee && actor !== task.coordinator) throw new Error(`Only the assignee or coordinator may block task ${id}.`);
  if (task.status === "done") throw new Error(`Completed task ${id} cannot be blocked.`);
  task.blocker = required(words(args, "--reason"), "--reason");
  await writeTask(root, projectName, id, task);
  console.log(`${id}  blocked`);
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
