import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

async function execute(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

async function run(cwd: string, ...args: string[]) {
  const result = await execute(cwd, args);
  expect(result.code, result.output).toBe(0);
  return result.output.trim();
}

async function fail(cwd: string, ...args: string[]) {
  const result = await execute(cwd, args);
  expect(result.code).not.toBe(0);
  return result.output;
}

async function fixture() {
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("RED: add and assign accept every live same-project role without changing seat resources", async () => {
  const { site, main, coordinator, named, mismatched, driver } = await fixture();
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
  const { site, coordinator, driver, retired, foreign } = await fixture();
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
  const { site, coordinator, driver } = await fixture();
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
