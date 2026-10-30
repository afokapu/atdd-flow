// URN: component:flow:e022:task-supersede-authorization:backend:integration
// Tested-By:
// - test:atdd-flow:coordinator-stale-task-supersede-authorization
// Runtime: bun
// Purpose: Owner-authorized supersession of a stale coordinator task.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicYaml, paths, readYaml, seat, yaml } from "./core";

/** The one exact tuple an operator@desk message may carry to authorize `task supersede` by main. */
export type SupersedeAuthorization = {
  schema: "atdd-workflow/task-supersede-authorization/v1";
  project: string;
  task: string;
  coordinator: string;
  action: "supersede";
  reason: string;
  task_sha256: string;
};

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

/** Locate the one operator@desk message `reference`, addressed to main in a thread main joined, and return its typed payload. */
export async function operatorAuthorizationPayload(root: string, reference: string, main: string): Promise<unknown> {
  type Found = { schema?: string; id?: string; from?: string; to?: "all" | string[]; authorization?: unknown };
  const folders = await readdir(paths(root).threads, { withFileTypes: true });
  const matches = (await Promise.all(folders.filter((entry) => entry.isDirectory() && entry.name.startsWith("T-"))
    .map(async (entry) => {
      try {
        const [thread, message] = await Promise.all([
          readYaml<{ schema?: string; participants?: string[] }>(paths(root).threadFile(entry.name)),
          readYaml<Found>(paths(root).message(entry.name, reference)),
        ]);
        return { thread, message };
      } catch { return undefined; }
    }))).filter((entry): entry is NonNullable<typeof entry> =>
      entry?.thread.schema === "atdd-workflow/thread/v1" && entry.thread.participants?.includes(main) === true
      && entry.message.schema === "atdd-workflow/message/v1" && entry.message.id === reference);
  if (matches.length !== 1 || matches[0]?.message.from !== "operator@desk") {
    throw new Error(`Authorization ${reference} is not an owner-authorized topology plan.`);
  }
  const message = matches[0].message;
  if (message.to !== "all" && !message.to?.includes(main)) throw new Error(`Authorization ${reference} is not applicable to ${main}.`);
  return message.authorization;
}

/** Create-only evidence: an existing file must hold exactly the same bytes. */
async function publishOrVerify(file: string, bytes: string) {
  try { await writeFile(file, bytes, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
  if (await readFile(file, "utf8") !== bytes) throw new Error("Task supersede archive collides with different immutable evidence.");
}

/** Archive the pre-mutation task bytes and the authorization by task hash, create-only. */
async function archiveEvidence(root: string, projectName: string, id: string, hash: string, taskBytes: string, evidence: Record<string, unknown>) {
  const folder = join(root, ".atdd-flow", "task-supersede-archive", projectName, id, hash);
  await mkdir(folder, { recursive: true });
  await publishOrVerify(join(folder, "task.yaml"), taskBytes);
  await publishOrVerify(join(folder, "authorization.yaml"), yaml.print(evidence));
}

/** Exact tuple equality: the same keys with the same values, and nothing more. */
function sameTuple(actual: unknown, expected: SupersedeAuthorization) {
  const record = actual && typeof actual === "object" ? actual as Record<string, unknown> : undefined;
  const keys = Object.keys(expected) as (keyof SupersedeAuthorization)[];
  return Boolean(record) && Object.keys(record!).length === keys.length && keys.every((key) => record![key] === expected[key]);
}

type Subject = { project: string; id: string; coordinator: string; reason: string; main: string; reference: string };

async function assertStaleCoordinatorTask(root: string, subject: Subject) {
  const owner = await seat(root, subject.coordinator).catch(() => undefined);
  if (owner?.role !== "coordinator" || owner.project !== subject.project) {
    throw new Error(`Task ${subject.id} is not owned by a named coordinator of ${subject.project}; the owner authorization applies only to coordinator tasks.`);
  }
  const { launchEligibleTasks } = await import("./pi-runtime-launch");
  if ((await launchEligibleTasks(root, owner, subject.coordinator)).length) {
    throw new Error(`${subject.coordinator} has a launch-eligible task and can supersede task ${subject.id} itself.`);
  }
}

/**
 * Validate every exact owner-authorization and staleness condition, then archive the evidence. Nothing is written until
 * all checks pass; the caller records the terminal disposition afterwards. Returns the authorization reference.
 */
export async function authorizeSupersede(root: string, subject: Subject): Promise<string> {
  const taskBytes = await readFile(paths(root).taskFile(subject.project, subject.id), "utf8");
  const expected: SupersedeAuthorization = {
    schema: "atdd-workflow/task-supersede-authorization/v1", project: subject.project, task: subject.id,
    coordinator: subject.coordinator, action: "supersede", reason: subject.reason, task_sha256: sha256(taskBytes),
  };
  const authorization = await operatorAuthorizationPayload(root, subject.reference, subject.main);
  if (!sameTuple(authorization, expected)) throw new Error(`Authorization ${subject.reference} is not an exact supersede authorization.`);
  await assertStaleCoordinatorTask(root, subject);
  await archiveEvidence(root, subject.project, subject.id, expected.task_sha256, taskBytes, { id: subject.reference, from: "operator@desk", authorization: expected });
  return subject.reference;
}

/** Parse `post --task-supersede-authorization`: operator@desk only, one exact task-supersede-authorization/v1 tuple. */
export function parseSupersedeAuthorization(encoded: string | undefined, from: string): SupersedeAuthorization | undefined {
  if (!encoded) return undefined;
  if (from !== "operator@desk") throw new Error("Only operator@desk may create a task supersede authorization.");
  let value: Partial<SupersedeAuthorization> | undefined;
  try { value = JSON.parse(encoded); } catch { throw new Error("--task-supersede-authorization must be valid JSON."); }
  const fields = [value?.project, value?.task, value?.coordinator, value?.reason, value?.task_sha256];
  if (value?.schema !== "atdd-workflow/task-supersede-authorization/v1" || value.action !== "supersede"
    || !fields.every((entry) => typeof entry === "string" && entry.length) || !/^[a-f0-9]{64}$/i.test(value.task_sha256!)) {
    throw new Error("--task-supersede-authorization must contain one exact task-supersede-authorization/v1 tuple.");
  }
  return value as SupersedeAuthorization;
}
