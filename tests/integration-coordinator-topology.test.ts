import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectHerdrSeat } from "../src/multiplexer";

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

test("role-neutral assignment preserves seat topology but does not impose task branch lineage", async () => {
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
  await git(repository, "worktree", "add", "-b", "delivery/stream-driver", driver, "integration/payments");
  await run(site, "spawn", "demo", "driver", "stream-driver");

  await run(site, "task", "add", "demo", "stream", "--title", "Stream delivery", "--coordinator", "coordinator.payments@demo", "--assignee", "driver.stream-driver@demo", "--done-when", "Deliver from the stream base.");
  const task = await Bun.file(join(site, "work", "demo", "tasks", "stream.yaml")).text();
  expect(task).not.toContain("governed_base:");
  expect(task).toContain("assignee: driver.stream-driver@demo");

  const mismatch = join(worktrees, "mismatch-driver");
  await git(repository, "worktree", "add", "-b", "delivery/mismatch-driver", mismatch, "main");
  await run(site, "spawn", "demo", "driver", "mismatch-driver");
  await run(site, "task", "add", "demo", "mismatch", "--title", "Mismatch", "--coordinator", "coordinator.payments@demo", "--assignee", "driver.mismatch-driver@demo", "--done-when", "Records accountability only.");
  expect(await Bun.file(join(site, "work", "demo", "tasks", "mismatch.yaml")).text()).toContain("assignee: driver.mismatch-driver@demo");
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
