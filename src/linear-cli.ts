// URN: component:linear-mirror:outbound:LinearCli:backend:application
// Tested-By:
//   - test:linear-mirror:outbound:E001-LINEAR-001-one-way-mirror-fails-closed
// Runtime: bun
// Purpose: Command handler for `atdd-flow linear mirror` dry-run and gated apply
//
// Reads Flow records only to project them outward; nothing here writes Flow.
import { has, paths, readYaml, required, words, yaml } from "./core";
import { linearGraphql } from "./linear-graphql";
import { authorizeLiveProjection, mirrorMessage, mirrorTask, readMirrorConfig, type MirrorConfig } from "./linear-mirror";
import type { Task } from "./tasks";
import type { Message } from "./threads";

const usage = "Use `atdd-flow linear mirror authorize|task|message ...`.";
const emit = (value: unknown) => process.stdout.write(`${yaml.print(value)}\n`);

type Run = { root: string; config: MirrorConfig; project: string; task: string; apply: boolean; authorization?: string };

/** Projects one Flow task outward; the dry run is the default and needs no credential. */
async function prepare(run: Run) {
  const linear = linearGraphql(run.apply ? required(process.env.LINEAR_API_KEY, "LINEAR_API_KEY") : "dry-run");
  const task = await readYaml<Task>(paths(run.root).taskFile(run.project, run.task));
  const source = { canonical_id: `flow:task:${run.project}/${run.task}`, project: run.project, task_id: run.task, title: task.title, status: task.status, ...(task.body ? { body: task.body } : {}) };
  const options = { apply: run.apply, ...(run.authorization ? { authorization: run.authorization } : {}) };
  return { linear, source, options };
}

/** Handles `linear mirror authorize|task|message`. */
export async function linearCommand(root: string, rest: string[]) {
  if (rest[0] !== "mirror") throw new Error(usage);
  if (rest[1] === "authorize") {
    const tail = rest.slice(2);
    const config = await readMirrorConfig(required(words(tail, "--config"), "--config"));
    return emit(await authorizeLiveProjection(root, config, { id: required(words(tail, "--id"), "--id"), by: required(words(tail, "--by"), "--by") }));
  }
  if (!["task", "message"].includes(rest[1] ?? "")) throw new Error(usage);
  const kind = rest[1];
  const tail = rest.slice(kind === "task" ? 4 : 6);
  const apply = has(tail, "--apply");
  const authorization = words(tail, "--authorization");
  if (apply && !authorization) throw new Error("Live Linear writes require an immutable operator@desk authorization id.");
  const run: Run = {
    root, config: await readMirrorConfig(required(words(tail, "--config"), "--config")), apply,
    project: required(rest[2], "project"), task: required(rest[3], "task id"), ...(authorization ? { authorization } : {}),
  };
  const { linear, source, options } = await prepare(run);
  if (kind === "task") return emit(await mirrorTask(root, run.config, source, linear, options));
  const threadId = required(rest[4], "thread id");
  const messageId = required(rest[5], "message id");
  const message = await readYaml<Message>(paths(root).message(threadId, messageId));
  const projection = { canonical_id: `flow:message:${threadId}/${messageId}`, task_canonical_id: source.canonical_id, project: run.project, task_id: run.task, thread_id: threadId, message_id: messageId, body: message.body };
  return emit(await mirrorMessage(root, run.config, projection, linear, options));
}
