import { readdir } from "node:fs/promises";
import { exists, paths, readYaml, type Checkpoint, type Seat } from "./core";
import { type Task } from "./tasks";
import { status as threadStatus } from "./threads";

async function names(folder: string) {
  try { return (await readdir(folder)).sort(); }
  catch { return []; }
}

async function projects(root: string) {
  const candidates = await names(paths(root).work);
  return (await Promise.all(candidates.map(async (name) => ({ name, valid: await exists(paths(root).projectFile(name)) }))))
    .filter((entry) => entry.valid)
    .map((entry) => entry.name);
}

async function printSeats(root: string, projectName: string) {
  for (const local of await names(paths(root).seats(projectName))) {
    const address = `${local}@${projectName}`;
    const file = paths(root).seatFile(address);
    if (!await exists(file)) continue;
    const record = await readYaml<Seat>(file);
    const checkpointFile = paths(root).checkpointFile(address);
    const checkpoint = await exists(checkpointFile) ? await readYaml<Checkpoint>(checkpointFile) : undefined;
    console.log(`${record.address}  ${record.role}  ${record.agent}  ${checkpoint?.status ?? "unverified"}${record.purpose ? `  ${record.purpose}` : ""}`);
  }
}

async function printTasks(root: string, projectName: string) {
  const folder = paths(root).tasks(projectName);
  const files = (await names(folder)).filter((file) => file.endsWith(".yaml"));
  const entries = await Promise.all(files.map(async (file) => ({
    id: file.slice(0, -5), task: await readYaml<Task>(`${folder}/${file}`),
  })));
  const byId = new Map(entries.map((entry) => [entry.id, entry.task]));
  for (const { id, task } of entries) {
    const waiting = (task.depends_on ?? []).filter((dependency) => byId.get(dependency)?.status !== "done");
    const proof = `${task.done_when.filter((item) => item.proof).length}/${task.done_when.length}`;
    console.log(`${projectName}/${id}  ${task.status}  proof:${proof}  ${task.assignee ?? "unassigned"}  ${task.title}${waiting.length ? `  waiting:${waiting.join(",")}` : ""}${task.blocker ? `  blocked:${task.blocker}` : ""}`);
  }
}

export async function status(root: string) {
  const projectNames = await projects(root);
  console.log("SEATS");
  for (const projectName of projectNames) await printSeats(root, projectName);
  console.log("TASKS");
  for (const projectName of projectNames) await printTasks(root, projectName);
  console.log("THREADS");
  await threadStatus(root);
}
