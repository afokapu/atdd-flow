import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

type Fixture = {
  root: string;
  site: string;
  repository: string;
  integration: string;
  driver: string;
  integrationHead: string;
  mainHead: string;
};

async function invoke(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined },
    stdout: "pipe",
    stderr: "pipe",
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
  expect(result.exitCode).not.toBe(0);
  return result.output;
}

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim();
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "atdd-accountability-transfer-"));
  roots.push(root);
  const site = join(root, "desk");
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  await mkdir(repository);
  await git(repository, "init", "--initial-branch=main");
  await writeFile(join(repository, "README.md"), "fixture\n");
  await git(repository, "add", "README.md");
  await git(repository, "-c", "user.email=fixture@example.test", "-c", "user.name=Fixture", "commit", "-m", "initial");

  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  const projectFile = join(site, "work", "demo", "project.yaml");
  const project = Bun.YAML.parse(await readFile(projectFile, "utf8")) as Record<string, unknown>;
  project.repository = repository;
  project.worktree_root = worktrees;
  await Bun.write(projectFile, Bun.YAML.stringify(project));

  await run(site, "spawn", "demo", "main", "primary");
  await run(site, "spawn", "demo", "coordinator", "payments");
  const integration = join(worktrees, "payments");
  await writeFile(join(integration, "INTEGRATION.md"), "integration head\n");
  await git(integration, "add", "INTEGRATION.md");
  await git(integration, "-c", "user.email=fixture@example.test", "-c", "user.name=Fixture", "commit", "-m", "integration");
  const integrationHead = await git(integration, "rev-parse", "HEAD");
  const driver = join(worktrees, "transfer");
  await git(repository, "worktree", "add", "-b", "delivery/transfer", driver, "integration/payments");
  await run(site, "spawn", "demo", "driver", "transfer");
  const mainHead = await git(repository, "rev-parse", "main");
  return { root, site, repository, integration, driver, integrationHead, mainHead };
}

async function addActiveTask(fixture: Fixture, id: string, coordinator = "coordinator.payments@demo") {
  await run(fixture.site, "task", "add", "demo", id, "--title", "Transfer accountability", "--coordinator", coordinator,
    "--assignee", "driver.transfer@demo", "--done-when", "Keep delivery governed.");
  await run(fixture.site, "task", "start", "demo", id, "--by", "driver.transfer@demo");
}

async function task(fixture: Fixture, id: string) {
  return Bun.YAML.parse(await readFile(join(fixture.site, "work", "demo", "tasks", `${id}.yaml`), "utf8")) as Record<string, unknown>;
}

async function ownerAuthorization(fixture: Fixture, options: {
  id: string;
  recipient?: string;
  authorization?: Record<string, unknown>;
}) {
  const thread = "T-owner-authorized-topology-plan";
  await mkdir(join(fixture.site, "threads", thread), { recursive: true });
  await Bun.write(join(fixture.site, "threads", thread, "thread.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/thread/v1", id: thread, participants: ["operator@desk", "main@demo", "coordinator.payments@demo"], subject: "Authorized topology plan", state: "open",
  }));
  await Bun.write(join(fixture.site, "threads", thread, `${options.id}.yaml`), Bun.YAML.stringify({
    schema: "atdd-workflow/message/v1", id: options.id, from: "operator@desk", to: [options.recipient ?? "main@demo"], kind: "message", created_at: "2026-10-10T00:00:00.000Z", body: "Owner-authorized topology plan.",
    ...(options.authorization ? { authorization: options.authorization } : {}),
  }));
  return options.id;
}

function exactAuthorization(subject: Fixture, task: string, overrides: Record<string, unknown> = {}) {
  return {
    schema: "atdd-workflow/task-transfer-authorization/v1",
    project: "demo",
    task,
    from: "main@demo",
    to: "coordinator.payments@demo",
    reason: "Bounded stream",
    exact_head: { branch: "integration/payments", commit: subject.integrationHead },
    ...overrides,
  };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("RED: current task accountability cannot transfer without the governed CLI transition", async () => {
  const subject = await fixture();
  await addActiveTask(subject, "transfer");
  const record = await task(subject, "transfer");
  record.phase = "red";
  record.handoff = { state: "executing", evidence: "M-prior-phase-evidence", updated_at: "2026-10-10T00:00:00.000Z" };
  (record.done_when as Array<Record<string, string>>)[0].proof = "M-prior-review-evidence";
  await Bun.write(join(subject.site, "work", "demo", "tasks", "transfer.yaml"), Bun.YAML.stringify(record));

  expect(await run(subject.site, "--help")).toContain("task transfer <project> <task-id> --to <main-or-named-coordinator> --reason <text> --by <actor>");
  expect(await run(subject.site, "task", "transfer", "demo", "transfer", "--to", "main@demo", "--reason", "Main duplicate", "--by", "coordinator.payments@demo"))
    .toBe("transfer  coordinator transferred  coordinator.payments@demo -> main@demo");

  expect(await task(subject, "transfer")).toMatchObject({
    status: "in_progress",
    coordinator: "main@demo",
    governed_base: { coordinator: "main@demo", branch: "main", commit: subject.mainHead },
    phase: "red",
    handoff: { state: "executing", evidence: "M-prior-phase-evidence" },
    done_when: [{ proof: "M-prior-review-evidence" }],
    coordinator_transfers: [{
      from: "coordinator.payments@demo",
      to: "main@demo",
      reason: "Main duplicate",
      exact_head: { branch: "main", commit: subject.mainHead },
      effective_at: expect.any(String),
    }],
  });
}, 20_000);

test("RED: transfer provenance is append-only and manual coordinator rewriting is rejected", async () => {
  const subject = await fixture();
  await addActiveTask(subject, "manual");
  const before = await readFile(join(subject.site, "work", "demo", "tasks", "manual.yaml"), "utf8");
  await Bun.write(join(subject.site, "work", "demo", "tasks", "manual.yaml"), before.replace("coordinator: coordinator.payments@demo", "coordinator: main@demo"));

  expect(await fail(subject.site, "task", "handoff", "demo", "manual", "--by", "driver.transfer@demo", "--phase", "red", "--evidence", "M-manual"))
    .toContain("immutable transfer provenance");
  expect(await task(subject, "manual")).toMatchObject({
    coordinator: "main@demo",
    governed_base: { coordinator: "coordinator.payments@demo", branch: "integration/payments", commit: subject.integrationHead },
  });
}, 20_000);

test("RED: only the current coordinator or main with an operator authorization may transfer", async () => {
  const subject = await fixture();
  await addActiveTask(subject, "authorization", "main@demo");

  expect(await fail(subject.site, "task", "transfer", "demo", "authorization", "--to", "coordinator.payments@demo", "--reason", "Bounded stream", "--by", "driver.transfer@demo"))
    .toContain("Only main@demo or the current coordinator may transfer");
  expect(await fail(subject.site, "task", "transfer", "demo", "authorization", "--to", "coordinator.payments@demo", "--reason", "Bounded stream", "--by", "main@demo"))
    .toContain("owner-authorized topology plan");

  const inapplicable = await ownerAuthorization(subject, { id: "M-owner-inapplicable", recipient: "coordinator.payments@demo" });
  expect(await fail(subject.site, "task", "transfer", "demo", "authorization", "--to", "coordinator.payments@demo", "--reason", "Bounded stream", "--authorization", inapplicable, "--by", "main@demo"))
    .toContain(`not applicable to main@demo`);

  for (const [label, overrides] of [
    ["historical", undefined],
    ["wrong-task", { task: "other" }],
    ["wrong-from", { from: "coordinator.payments@demo" }],
    ["wrong-to", { to: "main@demo" }],
    ["wrong-reason", { reason: "Different reason" }],
    ["wrong-head", { exact_head: { branch: "integration/payments", commit: "0".repeat(40) } }],
  ] as const) {
    const id = `authorization-${label}`;
    await addActiveTask(subject, id, "main@demo");
    const reference = await ownerAuthorization(subject, { id: `M-owner-${label}`, authorization: overrides ? exactAuthorization(subject, id, overrides) : undefined });
    expect(await fail(subject.site, "task", "transfer", "demo", id, "--to", "coordinator.payments@demo", "--reason", "Bounded stream", "--authorization", reference, "--by", "main@demo"))
      .toContain("exact transfer authorization");
  }

  const authorization = await ownerAuthorization(subject, { id: "M-owner-exact", authorization: exactAuthorization(subject, "authorization") });
  expect(await run(subject.site, "task", "transfer", "demo", "authorization", "--to", "coordinator.payments@demo", "--reason", "Bounded stream", "--authorization", authorization, "--by", "main@demo"))
    .toBe("authorization  coordinator transferred  main@demo -> coordinator.payments@demo");
  expect(await task(subject, "authorization")).toMatchObject({
    coordinator: "coordinator.payments@demo",
    governed_base: { coordinator: "coordinator.payments@demo", branch: "integration/payments", commit: subject.integrationHead },
    coordinator_transfers: [{ authorization, from: "main@demo", to: "coordinator.payments@demo" }],
  });
}, 20_000);

test("GREEN: only operator creates a typed immutable transfer authorization", async () => {
  const subject = await fixture();
  const authorization = exactAuthorization(subject, "transfer");
  const thread = "T-owner-authorized-topology-plan";
  await mkdir(join(subject.site, "threads", thread), { recursive: true });
  await Bun.write(join(subject.site, "threads", thread, "thread.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/thread/v1", id: thread, participants: ["operator@desk", "main@demo", "coordinator.payments@demo"], subject: "Authorized topology plan", state: "open",
  }));
  const message = await run(subject.site, "post", thread, "--from", "operator@desk", "--to", "main@demo", "--label", "exact-transfer-authorization", "--body", "Exact owner authorization.", "--task-transfer-authorization", JSON.stringify(authorization));
  expect(await run(subject.site, "message", "read", message)).toContain("task-transfer-authorization/v1");
  expect(await fail(subject.site, "post", thread, "--from", "coordinator.payments@demo", "--to", "main@demo", "--body", "Not owner.", "--task-transfer-authorization", JSON.stringify(authorization)))
    .toContain("Only operator@desk");
}, 20_000);

test("RED: transfer never moves worktrees and duplicate, nested, or mismatched targets fail closed", async () => {
  const subject = await fixture();
  await addActiveTask(subject, "fail-closed");
  await writeFile(join(subject.driver, "DIRTY.md"), "must remain\n");
  const before = await readFile(join(subject.site, "work", "demo", "seats", "driver.transfer", "seat.yaml"), "utf8");

  await run(subject.site, "task", "transfer", "demo", "fail-closed", "--to", "main@demo", "--reason", "Main duplicate", "--by", "coordinator.payments@demo");
  expect(await readFile(join(subject.site, "work", "demo", "seats", "driver.transfer", "seat.yaml"), "utf8")).toBe(before);
  expect(await readFile(join(subject.driver, "DIRTY.md"), "utf8")).toBe("must remain\n");
  expect(await fail(subject.site, "task", "transfer", "demo", "fail-closed", "--to", "main@demo", "--reason", "Repeat", "--by", "main@demo"))
    .toContain("already accountable");

  const nested = join(subject.site, "work", "demo", "seats", "coordinator.nested.stream", "seat.yaml");
  await mkdir(join(nested, ".."), { recursive: true });
  await Bun.write(nested, Bun.YAML.stringify({ schema: "atdd-workflow/seat/v2", address: "coordinator.nested.stream@demo", role: "coordinator", project: "demo", worktree: subject.integration, branch: "integration/nested/stream" }));
  const authorization = await ownerAuthorization(subject, { id: "M-owner-nested", authorization: exactAuthorization(subject, "fail-closed", { to: "coordinator.nested.stream@demo", reason: "Nested", exact_head: { branch: "integration/nested/stream", commit: subject.integrationHead } }) });
  expect(await fail(subject.site, "task", "transfer", "demo", "fail-closed", "--to", "coordinator.nested.stream@demo", "--reason", "Nested", "--authorization", authorization, "--by", "main@demo"))
    .toMatch(/nested|integration lineage/i);
}, 20_000);

test("RED: transfer uses the driver worktree HEAD when the recorded branch was pruned and records the ref used", async () => {
  const subject = await fixture();
  await addActiveTask(subject, "pruned");
  await git(subject.driver, "checkout", "--detach");
  await git(subject.repository, "branch", "-D", "delivery/transfer");
  const head = await git(subject.driver, "rev-parse", "HEAD");

  expect(await run(subject.site, "task", "transfer", "demo", "pruned", "--to", "main@demo", "--reason", "Coordinator exited", "--by", "coordinator.payments@demo"))
    .toBe("pruned  coordinator transferred  coordinator.payments@demo -> main@demo");
  expect(await task(subject, "pruned")).toMatchObject({
    coordinator: "main@demo",
    governed_base: { coordinator: "main@demo", branch: "main", commit: subject.mainHead },
    coordinator_transfers: [{ to: "main@demo", lineage_ref: { ref: "HEAD", commit: head, reason: expect.stringContaining("delivery/transfer") } }],
  });
}, 20_000);

test("RED: transfer keeps using the recorded branch when it resolves, and fails closed naming a missing branch and worktree", async () => {
  const live = await fixture();
  await addActiveTask(live, "live");
  await run(live.site, "task", "transfer", "demo", "live", "--to", "main@demo", "--reason", "Duplicate", "--by", "coordinator.payments@demo");
  expect(((await task(live, "live")).coordinator_transfers as Array<Record<string, any>>)[0]!.lineage_ref).toMatchObject({ ref: "delivery/transfer" });

  const gone = await fixture();
  await addActiveTask(gone, "gone");
  await git(gone.driver, "checkout", "--detach");
  await git(gone.repository, "branch", "-D", "delivery/transfer");
  await git(gone.repository, "worktree", "remove", "--force", gone.driver);
  const output = await fail(gone.site, "task", "transfer", "demo", "gone", "--to", "main@demo", "--reason", "Coordinator exited", "--by", "coordinator.payments@demo");
  expect(output).toContain("delivery/transfer");
  expect(output).toContain(gone.driver);
  expect(output).not.toContain("Not a valid object name");
  expect((await task(gone, "gone")).coordinator).toBe("coordinator.payments@demo");
}, 30_000);
