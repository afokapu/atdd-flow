import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectHerdrSeat } from "../src/multiplexer";
import { nextDirective } from "../src/tasks";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}

async function fail(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).not.toBe(0);
  return `${stdout}${stderr}`;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("RED: defaults make main primary and named coordinators bounded integration worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-integration-topology-"));
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
  const project = Bun.YAML.parse(await Bun.file(projectFile).text()) as Record<string, unknown>;
  project.repository = repository;
  project.worktree_root = worktrees;
  await Bun.write(projectFile, Bun.YAML.stringify(project));

  expect(await run(site, "spawn", "demo", "main", "primary")).toBe("main@demo");
  expect(await run(site, "spawn", "demo", "coordinator", "payments")).toBe("coordinator.payments@demo");
  const coordinator = await Bun.file(join(site, "work", "demo", "seats", "coordinator.payments", "seat.yaml")).text();
  expect(coordinator).toContain("branch: integration/payments");
  expect(coordinator).toContain(`worktree: ${worktrees}/payments`);
  expect(await run(site, "open", "coordinator.payments@demo")).toContain("atdd-workflow.workflow.lifecycle.convention.yaml");

  await Bun.write(join(site, "work", "demo", "seats", "coordinator.payments", "seat.yaml"), coordinator.replace("branch: integration/payments", "branch: main"));
  await expect(projectHerdrSeat(site, "coordinator.payments@demo", "fake", async () => {
    throw new Error("projection must reject invalid topology before calling Herdr");
  })).rejects.toThrow("must use one linked integration/<stream> worktree and branch");
}, 20_000);

test("RED: legacy unscoped Herdr records report unverified without inferring another session", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-unscoped-herdr-"));
  roots.push(root);
  const site = join(root, "desk");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "driver", "legacy", "--worktree", join(root, "legacy"));
  // A scalar legacy locator might name a pane that exists in some other Herdr
  // session. It contains no session, Pi identity/path, receipt, or heartbeat,
  // so reporting must not infer/attach/resume it.
  await run(site, "bind", "driver.legacy@demo", "--application", "herdr", "--address", "w-other:p1");
  const opened = await run(site, "open", "driver.legacy@demo");
  expect(opened).toContain("herdr: w-other:p1 (unscoped; unverified)");
  expect(opened).toContain("runtime verification: unverified");
  expect(opened).toContain("Herdr session");
  expect(opened).toContain("Pi session/path");
  expect(opened).toContain("launch receipt");
  expect(opened).toContain("advisory heartbeat");
}, 20_000);

test("assigned drivers record provable task-coordinator base evidence without gating assignment", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-integration-governed-base-"));
  roots.push(root);
  const site = join(root, "desk");
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  const driver = join(worktrees, "stream-driver");
  await mkdir(repository);
  await git(repository, "init", "--initial-branch=main");
  await writeFile(join(repository, "README.md"), "fixture\n");
  await git(repository, "add", "README.md");
  await git(repository, "-c", "user.email=fixture@example.test", "-c", "user.name=Fixture", "commit", "-m", "initial");

  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  const projectFile = join(site, "work", "demo", "project.yaml");
  const project = Bun.YAML.parse(await Bun.file(projectFile).text()) as Record<string, unknown>;
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
  await git(repository, "worktree", "add", "-b", "delivery/stream-driver", driver, "integration/payments");
  await run(site, "spawn", "demo", "driver", "stream-driver");

  await run(site, "task", "add", "demo", "stream", "--title", "Stream delivery", "--coordinator", "coordinator.payments@demo", "--assignee", "driver.stream-driver@demo", "--done-when", "Deliver from the stream base.");
  const task = await Bun.file(join(site, "work", "demo", "tasks", "stream.yaml")).text();
  expect(task).toContain("governed_base:");
  expect(task).toContain("coordinator: coordinator.payments@demo");
  expect(task).toContain("branch: integration/payments");
  expect(task).toContain(`commit: ${integrationHead}`);

  const mismatch = join(worktrees, "mismatch-driver");
  await git(repository, "worktree", "add", "-b", "delivery/mismatch-driver", mismatch, "main");
  await run(site, "spawn", "demo", "driver", "mismatch-driver");
  // Assignment is accountability only: a mismatched base is never fabricated as lineage evidence.
  await run(site, "task", "add", "demo", "mismatch", "--title", "Mismatch", "--coordinator", "coordinator.payments@demo", "--assignee", "driver.mismatch-driver@demo", "--done-when", "Records accountability only.");
  expect(await Bun.file(join(site, "work", "demo", "tasks", "mismatch.yaml")).text()).not.toContain("governed_base:");
  expect(await fail(site, "spawn", "demo", "coordinator", "nested.stream")).toContain("single stream");
}, 20_000);

test("RED: task-aware driver spawn must atomically derive from its exact task coordinator", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-task-aware-driver-spawn-"));
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
  const project = Bun.YAML.parse(await Bun.file(projectFile).text()) as Record<string, unknown>;
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

  await run(site, "spawn", "demo", "driver", "ordinary");
  expect(await git(join(worktrees, "ordinary"), "rev-parse", "HEAD")).toBe(await git(repository, "rev-parse", "main"));
  expect(await git(join(worktrees, "ordinary"), "rev-parse", "HEAD")).not.toBe(integrationHead);

  await run(site, "task", "add", "demo", "child", "--title", "Child", "--coordinator", "coordinator.payments@demo", "--done-when", "Deliver from the exact stream head.");
  expect(await run(site, "spawn", "demo", "driver", "child", "--task", "child")).toBe("driver.child@demo  assigned child  return integration/payments");
  const childWorktree = join(worktrees, "child");
  expect(await git(childWorktree, "merge-base", "HEAD", "integration/payments")).toBe(integrationHead);
  const child = await Bun.file(join(site, "work", "demo", "tasks", "child.yaml")).text();
  expect(child).toContain("assignee: driver.child@demo");
  expect(child).toContain("governed_base:");
  expect(child).toContain("branch: integration/payments");
  expect(child).toContain(`commit: ${integrationHead}`);

  await git(repository, "branch", "delivery/existing", "main");
  await run(site, "task", "add", "demo", "existing", "--title", "Existing", "--coordinator", "coordinator.payments@demo", "--done-when", "Must fail closed.");
  expect(await fail(site, "spawn", "demo", "driver", "existing", "--task", "existing")).toContain("already exists; refusing to reuse it");
  const existing = await Bun.file(join(site, "work", "demo", "tasks", "existing.yaml")).text();
  expect(existing).not.toContain("assignee:");
  expect(await Bun.file(join(worktrees, "existing")).exists()).toBe(false);

  await writeFile(join(integration, "dirty.txt"), "dirty\n");
  await run(site, "task", "add", "demo", "dirty", "--title", "Dirty", "--coordinator", "coordinator.payments@demo", "--done-when", "Must fail closed.");
  expect(await fail(site, "spawn", "demo", "driver", "dirty", "--task", "dirty")).toContain("worktree is dirty");
  expect((await Bun.file(join(site, "work", "demo", "tasks", "dirty.yaml")).text())).not.toContain("assignee:");
}, 20_000);

async function roleNeutralFixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-role-neutral-"));
  roots.push(root);
  const site = join(root, "desk");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "project", "init", "other");
  await mkdir(join(root, "main"));
  await mkdir(join(root, "coord"));
  await mkdir(join(root, "driver"));
  await mkdir(join(root, "retired"));
  await mkdir(join(root, "foreign"));
  await run(site, "spawn", "demo", "main", "primary", "--worktree", join(root, "main"));
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", join(root, "coord"));
  await run(site, "spawn", "demo", "driver", "worker", "--worktree", join(root, "driver"));
  await run(site, "spawn", "demo", "driver", "retired", "--worktree", join(root, "retired"));
  await run(site, "spawn", "other", "driver", "foreign", "--worktree", join(root, "foreign"));
  // A configured repository activates the current role/topology gate; the
  // replacement role-neutral path must not inspect or move it.
  const projectFile = join(site, "work", "demo", "project.yaml");
  const project = Bun.YAML.parse(await Bun.file(projectFile).text()) as Record<string, unknown>;
  project.repository = join(root, "repository");
  await Bun.write(projectFile, Bun.YAML.stringify(project));
  const retiredFile = join(site, "work", "demo", "seats", "driver.retired", "seat.yaml");
  const retired = Bun.YAML.parse(await Bun.file(retiredFile).text()) as Record<string, unknown>;
  retired.retired = { task: "demo/history", completed_at: "2026-10-10T00:00:00.000Z", summary: "historic" };
  await Bun.write(retiredFile, Bun.YAML.stringify(retired));
  // Hand-written seats keep the fixture independent of repository topology.
  const generic = Bun.YAML.parse(await Bun.file(join(site, "work", "demo", "seats", "coordinator", "seat.yaml")).text()) as Record<string, unknown>;
  for (const [name, branch] of [["ops", "integration/ops"], ["bad", "main"]] as const) {
    const folder = join(site, "work", "demo", "seats", `coordinator.${name}`);
    await mkdir(folder, { recursive: true });
    await Bun.write(join(folder, "seat.yaml"), Bun.YAML.stringify({ ...generic, address: `coordinator.${name}@demo`, branch, worktree: join(root, "coord") }));
  }
  return {
    site,
    named: "coordinator.ops@demo",
    mismatched: "coordinator.bad@demo",
    main: "main@demo",
    coordinator: "coordinator@demo",
    driver: "driver.worker@demo",
    retired: "driver.retired@demo",
    foreign: "driver.foreign@other",
  };
}

function taskFile(site: string, id: string) {
  return join(site, "work", "demo", "tasks", `${id}.yaml`);
}

async function taskText(site: string, id: string) {
  return Bun.file(taskFile(site, id)).text();
}

test("RED: add and assign accept every live same-project role without changing seat resources", async () => {
  const { site, main, coordinator, named, mismatched, driver } = await roleNeutralFixture();
  const coordinatorSeat = await Bun.file(join(site, "work", "demo", "seats", "coordinator.ops", "seat.yaml")).text();

  await run(site, "task", "add", "demo", "main-owned", "--title", "Main work", "--coordinator", coordinator, "--assignee", main, "--done-when", "Recorded.");
  await run(site, "task", "add", "demo", "coordinator-owned", "--title", "Coordinator work", "--coordinator", coordinator, "--assignee", named, "--done-when", "Recorded.");
  await run(site, "task", "add", "demo", "generic-owned", "--title", "Generic coordinator work", "--coordinator", coordinator, "--assignee", coordinator, "--done-when", "Recorded.");
  await run(site, "task", "add", "demo", "mismatched-owned", "--title", "Mismatched coordinator work", "--coordinator", coordinator, "--assignee", mismatched, "--done-when", "Recorded.");
  await run(site, "task", "add", "demo", "unassigned", "--title", "Driver work", "--coordinator", coordinator, "--done-when", "Recorded.");
  await run(site, "task", "assign", "demo", "unassigned", "--assignee", driver, "--by", coordinator);

  expect(await taskText(site, "main-owned")).toContain(`assignee: ${main}`);
  expect(await taskText(site, "coordinator-owned")).toContain(`assignee: ${named}`);
  expect(await taskText(site, "generic-owned")).toContain(`assignee: ${coordinator}`);
  expect(await taskText(site, "mismatched-owned")).toContain(`assignee: ${mismatched}`);
  expect(await taskText(site, "unassigned")).toContain(`assignee: ${driver}`);
  expect(await Bun.file(join(site, "work", "demo", "seats", "coordinator.ops", "seat.yaml")).text()).toBe(coordinatorSeat);
});

test("RED: invalid assignment paths fail closed without partial task creation", async () => {
  const { site, coordinator, driver, retired, foreign } = await roleNeutralFixture();
  const options = ["--title", "Bounded work", "--coordinator", coordinator, "--done-when", "Recorded."];

  await fail(site, "task", "add", "demo", "unknown", ...options, "--assignee", "driver.missing@demo");
  expect(await Bun.file(taskFile(site, "unknown")).exists()).toBe(false);
  await fail(site, "task", "add", "demo", "foreign", ...options, "--assignee", foreign);
  expect(await Bun.file(taskFile(site, "foreign")).exists()).toBe(false);
  await fail(site, "task", "add", "demo", "retired", ...options, "--assignee", retired);
  expect(await Bun.file(taskFile(site, "retired")).exists()).toBe(false);

  await run(site, "task", "add", "demo", "duplicate", ...options, "--assignee", driver);
  const before = await taskText(site, "duplicate");
  await fail(site, "task", "add", "demo", "duplicate", "--title", "Replacement", "--coordinator", coordinator, "--done-when", "Must fail.");
  expect(await taskText(site, "duplicate")).toBe(before);

  await run(site, "task", "add", "demo", "assign-once", ...options);
  const unassigned = await taskText(site, "assign-once");
  await fail(site, "task", "assign", "demo", "assign-once", "--assignee", foreign, "--by", coordinator);
  expect(await taskText(site, "assign-once")).toBe(unassigned);
  await run(site, "task", "assign", "demo", "assign-once", "--assignee", driver, "--by", coordinator);
  const assigned = await taskText(site, "assign-once");
  await fail(site, "task", "assign", "demo", "assign-once", "--assignee", coordinator, "--by", coordinator);
  expect(await taskText(site, "assign-once")).toBe(assigned);
});

test("RED: terminal dispositions are coordinator-authored and defer is bounded", async () => {
  const { site, coordinator, driver } = await roleNeutralFixture();
  const options = ["--title", "Disposition candidate", "--coordinator", coordinator, "--done-when", "Recorded."];

  await run(site, "task", "add", "demo", "superseded", ...options);
  await fail(site, "task", "supersede", "demo", "superseded", "--by", driver, "--reason", "No authority.");
  await run(site, "task", "supersede", "demo", "superseded", "--by", coordinator, "--reason", "Replaced.");
  const terminal = await taskText(site, "superseded");
  expect(terminal).toContain("status: superseded");
  await fail(site, "task", "amend", "demo", "superseded", "--title", "Mutated");
  expect(await taskText(site, "superseded")).toBe(terminal);

  await run(site, "task", "add", "demo", "deferred", ...options);
  await fail(site, "task", "defer", "demo", "deferred", "--by", coordinator, "--reason", "Wait.");
  await run(site, "task", "defer", "demo", "deferred", "--by", coordinator, "--reason", "Wait for release.", "--owner", coordinator, "--trigger", "Release complete", "--review-at", "2026-11-01T00:00:00.000Z");
  expect(await taskText(site, "deferred")).toContain("review_at: 2026-11-01T00:00:00.000Z");
});

test("terminal dispositions leave no directive, routing, overview attention, or stale deferral", async () => {
  const { site, main, driver } = await roleNeutralFixture();
  const options = ["--coordinator", main, "--assignee", driver, "--done-when", "Recorded."];
  await run(site, "task", "add", "demo", "closing", "--title", "Closing work", ...options);
  await run(site, "task", "start", "demo", "closing", "--by", driver);
  const thread = await run(site, "thread", "start", "--with", `${main},${driver}`, "--subject", "Routing");
  await run(site, "post", thread, "--from", driver, "--to", main, "--body", "Live task may route to its coordinator.");
  expect(await nextDirective(site, driver)).toMatchObject({ role: "assignee", lifecycle: "PLAN" });
  expect(await nextDirective(site, main)).toBeUndefined();
  expect(await run(site, "status", "project", "demo")).toContain("demo/closing");

  await run(site, "task", "supersede", "demo", "closing", "--by", main, "--reason", "Replaced.");
  expect(await nextDirective(site, driver)).toBeUndefined();
  expect(await nextDirective(site, main)).toBeUndefined();
  expect(await fail(site, "post", thread, "--from", driver, "--to", main, "--body", "Terminal task grants no route.")).toContain("may message only a coordinator");
  const overview = await run(site, "status", "project", "demo");
  expect(overview).not.toContain("demo/closing");
  expect(overview).toContain("closed without delivery");
  expect(await run(site, "status", "task", "demo", "closing")).toContain("Closed by terminal disposition (superseded)");

  await run(site, "task", "add", "demo", "held", "--title", "Held work", "--coordinator", main, "--done-when", "Recorded.");
  await run(site, "task", "defer", "demo", "held", "--by", main, "--reason", "Wait.", "--owner", main, "--trigger", "Release", "--review-at", "2026-11-01T00:00:00.000Z");
  expect(await taskText(site, "held")).toContain("deferred:");
  await run(site, "task", "unblock", "demo", "held", "--by", main);
  const released = await taskText(site, "held");
  expect(released).not.toContain("deferred:");
  expect(released).not.toContain("blocker:");
});
