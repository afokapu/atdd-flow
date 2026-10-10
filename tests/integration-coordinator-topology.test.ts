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
