// URN: test:atdd-flow:coordinator-stale-task-supersede-authorization
// Acceptance: acc:flow:E022-UNIT-001
// Phase: UNIT
// Purpose: main may supersede, and only supersede, a stale task owned by a named coordinator that cannot launch, and only with an
// exact operator@desk authorization that binds project, task, coordinator, action, reason and the pre-mutation task-file SHA-256.
// Fixtures only: the decision-os and resolver-os task ids are reproduced in temporary Desks; no live task is touched.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const reason = "Stale coordinator task superseded by owner decision";

type Subject = { root: string; site: string; project: string; coordinator: string; main: string };

async function invoke(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd, env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { output: `${stdout}${stderr}`.trim(), exitCode };
}

async function run(cwd: string, ...args: string[]) {
  const result = await invoke(cwd, ...args);
  expect(result.exitCode, result.output).toBe(0);
  return result.output;
}

async function fail(cwd: string, ...args: string[]) {
  const result = await invoke(cwd, ...args);
  expect(result.exitCode, result.output).not.toBe(0);
  return result.output;
}

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim();
}

/** A temporary Desk with a primary main and one named coordinator, mirroring the live decision-os / resolver-os topology. */
async function fixture(project: string, stream: string): Promise<Subject> {
  const root = await mkdtemp(join(tmpdir(), "atdd-stale-supersede-"));
  roots.push(root);
  const site = join(root, "desk"), repository = join(root, "repository"), worktrees = join(root, "worktrees");
  await mkdir(repository);
  await git(repository, "init", "--initial-branch=main");
  await writeFile(join(repository, "README.md"), "fixture\n");
  await git(repository, "add", "README.md");
  await git(repository, "-c", "user.email=fixture@example.test", "-c", "user.name=Fixture", "commit", "-m", "initial");
  await run(root, "init", site);
  await run(site, "project", "init", project);
  const projectFile = join(site, "work", project, "project.yaml");
  const record = Bun.YAML.parse(await readFile(projectFile, "utf8")) as Record<string, unknown>;
  record.repository = repository;
  record.worktree_root = worktrees;
  await Bun.write(projectFile, Bun.YAML.stringify(record));
  await run(site, "spawn", project, "main", "primary");
  await run(site, "spawn", project, "coordinator", stream);
  return { root, site, project, coordinator: `coordinator.${stream}@${project}`, main: `main@${project}` };
}

const taskFile = (subject: Subject, id: string) => join(subject.site, "work", subject.project, "tasks", `${id}.yaml`);
const readTask = async (subject: Subject, id: string) => Bun.YAML.parse(await readFile(taskFile(subject, id), "utf8")) as Record<string, any>;
const archiveFolder = (subject: Subject, id: string, hash: string) => join(subject.site, ".atdd-flow", "task-supersede-archive", subject.project, id, hash);

/** A stale coordinator-owned task: the coordinator accountable for it is blocked, so it cannot launch. */
async function stale(subject: Subject, id: string, coordinator = subject.coordinator) {
  await run(subject.site, "task", "add", subject.project, id, "--title", `Stale ${id}`, "--coordinator", coordinator, "--assignee", coordinator, "--done-when", "Never delivered.");
  await run(subject.site, "task", "block", subject.project, id, "--by", coordinator, "--reason", "Superseded by a later decision.");
  return sha256(await readFile(taskFile(subject, id), "utf8"));
}

function exactAuthorization(subject: Subject, task: string, hash: string, overrides: Record<string, unknown> = {}) {
  return {
    schema: "atdd-workflow/task-supersede-authorization/v1", project: subject.project, task, coordinator: subject.coordinator,
    action: "supersede", reason, task_sha256: hash, ...overrides,
  };
}

/** A durable owner message, written the way an operator post would persist it. */
async function ownerMessage(subject: Subject, id: string, options: { from?: string; to?: string[]; authorization?: Record<string, unknown> } = {}) {
  const thread = `T-${id}`;
  await mkdir(join(subject.site, "threads", thread), { recursive: true });
  await Bun.write(join(subject.site, "threads", thread, "thread.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/thread/v1", id: thread, participants: ["operator@desk", subject.main, subject.coordinator], subject: "Owner stale task decision", state: "open",
  }));
  await Bun.write(join(subject.site, "threads", thread, `${id}.yaml`), Bun.YAML.stringify({
    schema: "atdd-workflow/message/v1", id, from: options.from ?? "operator@desk", to: options.to ?? [subject.main], kind: "message",
    created_at: "2026-10-29T23:00:00.000Z", body: "Owner decision.", ...(options.authorization ? { authorization: options.authorization } : {}),
  }));
  return id;
}

const supersede = (subject: Subject, id: string, authorization?: string, by = subject.main) =>
  fail(subject.site, "task", "supersede", subject.project, id, "--by", by, "--reason", reason, ...(authorization ? ["--authorization", authorization] : []));

/** A refusal must leave the task bytes and the archive untouched. */
async function refusedUnchanged(subject: Subject, id: string, hash: string, args: string[], match?: string) {
  const before = await readFile(taskFile(subject, id), "utf8");
  const output = await fail(subject.site, ...args);
  if (match) expect(output).toContain(match);
  expect(await readFile(taskFile(subject, id), "utf8")).toBe(before);
  await expect(readFile(join(archiveFolder(subject, id, hash), "task.yaml"), "utf8")).rejects.toThrow();
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const fixtures = [
  ["decision-os", "c1", ["c1-revert-demos-relocation", "c1-occurrence-id-retained-row-reader"]],
  ["resolver-os", "toolkit", ["atdd-bun-consumer-upgrade", "atdd-bun-consumer-upgrade-replacement", "toolkit-prerequisite-upgrade"]],
] as const;

for (const [project, stream, ids] of fixtures) {
  test(`RED: main supersedes the stale ${project} coordinator tasks with an exact owner authorization and immutable archived evidence`, async () => {
    const subject = await fixture(project, stream);
    for (const id of ids) {
      const hash = await stale(subject, id);
      const before = await readFile(taskFile(subject, id), "utf8");
      const authorization = await ownerMessage(subject, `M-owner-${id}`, { authorization: exactAuthorization(subject, id, hash) });
      expect(await run(subject.site, "task", "supersede", project, id, "--by", subject.main, "--reason", reason, "--authorization", authorization))
        .toBe(`${id}  superseded`);
      const after = await readTask(subject, id);
      expect(after).toMatchObject({
        status: "superseded", coordinator: subject.coordinator, assignee: subject.coordinator,
        disposition: { kind: "superseded", by: subject.main, reason, authorization },
      });
      expect(after.coordinator_transfers).toBeUndefined();
      const archive = archiveFolder(subject, id, hash);
      expect(await readFile(join(archive, "task.yaml"), "utf8")).toBe(before);
      const archived = Bun.YAML.parse(await readFile(join(archive, "authorization.yaml"), "utf8")) as Record<string, any>;
      expect(archived).toMatchObject({ id: authorization, from: "operator@desk", authorization: exactAuthorization(subject, id, hash) });
      // The same authorization cannot supersede again.
      await supersede(subject, id, authorization);
    }
  }, 30_000);
}

test("an operator may post a typed supersede authorization; nobody else may, and the tuple must be exact", async () => {
  const subject = await fixture("decision-os", "c1");
  const hash = await stale(subject, "c1-revert-demos-relocation");
  const thread = "T-owner-stale-decision";
  await mkdir(join(subject.site, "threads", thread), { recursive: true });
  await Bun.write(join(subject.site, "threads", thread, "thread.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/thread/v1", id: thread, participants: ["operator@desk", subject.main, subject.coordinator], subject: "Owner stale decision", state: "open",
  }));
  const authorization = JSON.stringify(exactAuthorization(subject, "c1-revert-demos-relocation", hash));
  const message = await run(subject.site, "post", thread, "--from", "operator@desk", "--to", subject.main, "--label", "exact-supersede-authorization", "--body", "Exact owner authorization.", "--task-supersede-authorization", authorization);
  expect(await run(subject.site, "message", "read", message)).toContain("task-supersede-authorization/v1");
  expect(await fail(subject.site, "post", thread, "--from", subject.main, "--to", subject.coordinator, "--body", "Not owner.", "--task-supersede-authorization", authorization)).toContain("Only operator@desk");
  expect(await fail(subject.site, "post", thread, "--from", "operator@desk", "--to", subject.main, "--body", "Partial.", "--task-supersede-authorization", JSON.stringify({ schema: "atdd-workflow/task-supersede-authorization/v1" })))
    .toContain("exact task-supersede-authorization/v1");
  expect(await run(subject.site, "task", "supersede", "decision-os", "c1-revert-demos-relocation", "--by", subject.main, "--reason", reason, "--authorization", message))
    .toBe("c1-revert-demos-relocation  superseded");
}, 30_000);

test("main without an exact owner authorization cannot supersede a coordinator's task; drivers and the authorized shape stay narrow", async () => {
  const subject = await fixture("decision-os", "c1");
  const id = "c1-revert-demos-relocation", hash = await stale(subject, id);
  const base = ["task", "supersede", "decision-os", id, "--by", subject.main, "--reason", reason];
  await refusedUnchanged(subject, id, hash, base, `Only ${subject.coordinator} may supersede`);
  await refusedUnchanged(subject, id, hash, [...base, "--authorization", "M-does-not-exist"], "owner-authorized");
  await ownerMessage(subject, "M-not-operator", { from: subject.coordinator, authorization: exactAuthorization(subject, id, hash) });
  await refusedUnchanged(subject, id, hash, [...base, "--authorization", "M-not-operator"], "owner-authorized");
  await ownerMessage(subject, "M-other-recipient", { to: [subject.coordinator], authorization: exactAuthorization(subject, id, hash) });
  await refusedUnchanged(subject, id, hash, [...base, "--authorization", "M-other-recipient"], "not applicable to");
  await ownerMessage(subject, "M-historical");
  await refusedUnchanged(subject, id, hash, [...base, "--authorization", "M-historical"], "exact supersede authorization");
  // The authorization never widens who may act: only main may use it, never a driver or the operator.
  await ownerMessage(subject, "M-exact", { authorization: exactAuthorization(subject, id, hash) });
  await refusedUnchanged(subject, id, hash, ["task", "supersede", "decision-os", id, "--by", "operator@desk", "--reason", reason, "--authorization", "M-exact"], "Only");
}, 30_000);

test("every mismatched authorization field, including a changed task file, is refused before any write", async () => {
  const subject = await fixture("decision-os", "c1");
  const id = "c1-revert-demos-relocation", hash = await stale(subject, id);
  await stale(subject, "c1-other");
  const base = ["task", "supersede", "decision-os", id, "--by", subject.main, "--reason", reason];
  const variants: [string, Record<string, unknown>][] = [
    ["schema", { schema: "atdd-workflow/task-transfer-authorization/v1" }],
    ["project", { project: "resolver-os" }],
    ["task", { task: "c1-other" }],
    ["coordinator", { coordinator: "coordinator.other@decision-os" }],
    ["action", { action: "reject" }],
    ["reason", { reason: "A different reason" }],
    ["hash", { task_sha256: "0".repeat(64) }],
  ];
  for (const [label, overrides] of variants) {
    await ownerMessage(subject, `M-wrong-${label}`, { authorization: exactAuthorization(subject, id, hash, overrides) });
    await refusedUnchanged(subject, id, hash, [...base, "--authorization", `M-wrong-${label}`], "exact supersede authorization");
  }
  // Evidence drift: the task changed after the owner bound its hash.
  await ownerMessage(subject, "M-drift", { authorization: exactAuthorization(subject, id, hash) });
  await run(subject.site, "task", "amend", "decision-os", id, "--by", subject.coordinator, "--title", "Changed after authorization");
  await refusedUnchanged(subject, id, hash, [...base, "--authorization", "M-drift"], "exact supersede authorization");
}, 40_000);

test("a coordinator with a launch-eligible task, a non-stale task, or a terminal task is refused", async () => {
  const subject = await fixture("decision-os", "c1");
  const id = "c1-revert-demos-relocation", hash = await stale(subject, id);
  await ownerMessage(subject, "M-exact", { authorization: exactAuthorization(subject, id, hash) });
  const args = ["task", "supersede", "decision-os", id, "--by", subject.main, "--reason", reason, "--authorization", "M-exact"];

  // The coordinator can still launch on a ready task of its own, so it can supersede for itself.
  await run(subject.site, "task", "add", "decision-os", "c1-ready", "--title", "Ready", "--coordinator", subject.coordinator, "--assignee", subject.coordinator, "--done-when", "Deliver.");
  await refusedUnchanged(subject, id, hash, args, "launch-eligible");
  await run(subject.site, "task", "block", "decision-os", "c1-ready", "--by", subject.coordinator, "--reason", "Stale as well.");

  // A terminal task is never rewritten, even with an authorization bound to its current bytes.
  await stale(subject, "c1-done");
  const doneTask = await readTask(subject, "c1-done");
  doneTask.status = "done";
  delete doneTask.blocker;
  await Bun.write(taskFile(subject, "c1-done"), Bun.YAML.stringify(doneTask));
  const done = sha256(await readFile(taskFile(subject, "c1-done"), "utf8"));
  await ownerMessage(subject, "M-done", { authorization: exactAuthorization(subject, "c1-done", done) });
  await refusedUnchanged(subject, "c1-done", done, ["task", "supersede", "decision-os", "c1-done", "--by", subject.main, "--reason", reason, "--authorization", "M-done"]);

  // A task that can still run is not stale.
  await run(subject.site, "task", "add", "decision-os", "c1-live", "--title", "Live", "--coordinator", subject.coordinator, "--assignee", subject.coordinator, "--done-when", "Deliver.");
  const live = sha256(await readFile(taskFile(subject, "c1-live"), "utf8"));
  await ownerMessage(subject, "M-live", { authorization: exactAuthorization(subject, "c1-live", live) });
  await refusedUnchanged(subject, "c1-live", live, ["task", "supersede", "decision-os", "c1-live", "--by", subject.main, "--reason", reason, "--authorization", "M-live"], "launch-eligible");
}, 60_000);

test("the exception authorizes only supersede: reject, defer, block, unblock and transfer by main stay refused", async () => {
  const subject = await fixture("decision-os", "c1");
  const id = "c1-revert-demos-relocation", hash = await stale(subject, id);
  await ownerMessage(subject, "M-exact", { authorization: exactAuthorization(subject, id, hash) });
  const before = await readFile(taskFile(subject, id), "utf8");
  await refusedUnchanged(subject, id, hash, ["task", "reject", "decision-os", id, "--by", subject.main, "--reason", reason, "--authorization", "M-exact"], `Only ${subject.coordinator} may reject`);
  await refusedUnchanged(subject, id, hash, ["task", "defer", "decision-os", id, "--by", subject.main, "--reason", reason, "--owner", subject.main, "--trigger", "later", "--review-at", "2027-01-01T00:00:00Z", "--authorization", "M-exact"], `Only ${subject.coordinator} may defer`);
  await refusedUnchanged(subject, id, hash, ["task", "block", "decision-os", id, "--by", subject.main, "--reason", "again", "--authorization", "M-exact"], "Only the assignee or coordinator");
  await refusedUnchanged(subject, id, hash, ["task", "unblock", "decision-os", id, "--by", subject.main, "--authorization", "M-exact"], `Only ${subject.coordinator} may unblock`);
  await refusedUnchanged(subject, id, hash, ["task", "transfer", "decision-os", id, "--to", subject.main, "--reason", reason, "--by", subject.main, "--authorization", "M-exact"]);
  expect(await readFile(taskFile(subject, id), "utf8")).toBe(before);
}, 40_000);

test("an archive that collides with different bytes is refused and the task is left unchanged", async () => {
  const subject = await fixture("decision-os", "c1");
  const id = "c1-revert-demos-relocation", hash = await stale(subject, id);
  await ownerMessage(subject, "M-exact", { authorization: exactAuthorization(subject, id, hash) });
  const archive = archiveFolder(subject, id, hash);
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, "task.yaml"), "different immutable bytes\n");
  const before = await readFile(taskFile(subject, id), "utf8");
  expect(await fail(subject.site, "task", "supersede", "decision-os", id, "--by", subject.main, "--reason", reason, "--authorization", "M-exact"))
    .toContain("collides with different immutable evidence");
  expect(await readFile(taskFile(subject, id), "utf8")).toBe(before);
  expect(await readFile(join(archive, "task.yaml"), "utf8")).toBe("different immutable bytes\n");
}, 30_000);

test("the coordinator's own supersede keeps working unchanged without any authorization or archive", async () => {
  const subject = await fixture("decision-os", "c1");
  const id = "c1-revert-demos-relocation", hash = await stale(subject, id);
  expect(await run(subject.site, "task", "supersede", "decision-os", id, "--by", subject.coordinator, "--reason", reason)).toBe(`${id}  superseded`);
  expect(await readTask(subject, id)).toMatchObject({ status: "superseded", disposition: { kind: "superseded", by: subject.coordinator, reason } });
  await expect(readFile(join(archiveFolder(subject, id, hash), "task.yaml"), "utf8")).rejects.toThrow();
}, 30_000);
