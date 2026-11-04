// URN: test:atdd-flow:terminal-seat-retire-detached-git-review
// Acceptance: acc:flow:E040-UNIT-001
// Phase: UNIT
// Purpose: A detached Git review seat governed by a JJ-policy project retires on its actual VCS: the clean worktree at a commit reachable from
// main is accepted without a JJ repository or exported-bookmark requirement; dirty or unmerged reviews, real JJ worktrees, and authorization stay strict.
// Isolated fixtures only. Evidence (worktree and any branch) is retained.
import { afterEach, expect, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const test = (name: string, body: () => unknown | Promise<unknown>) => bunTest(name, body, 60_000);

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function spawnCli(cwd: string, environment: Record<string, string | undefined>, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

async function run(cwd: string, environment: Record<string, string | undefined>, ...args: string[]) {
  const result = await spawnCli(cwd, environment, args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}

/** A real repository with ATDD Bun linked-worktree policy and a Desk that spawns linked driver worktrees. */
async function desk(drivers: string[]) {
  const root = await mkdtemp(join(tmpdir(), "atdd-inactive-cleanup-"));
  roots.push(root);
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  const site = join(root, "site");
  const clean = { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, HERDR_SESSION: undefined, HERDR_PANE_ID: undefined };
  await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "test@example.test");
  await git(repository, "config", "user.name", "Test");
  await writeFile(join(repository, ".gitignore"), "node_modules/\n");
  await writeFile(join(repository, "atdd-bun.yaml"), "worktrees:\n  enabled: true\n  root: ../worktrees\n  primary_directory: repository\n  primary_branch: main\n  require_linked_worktree: true\n");
  await git(repository, "add", ".gitignore", "atdd-bun.yaml");
  await git(repository, "commit", "-m", "configure worktrees");
  // Retirement resolves ATDD Bun from the primary checkout, never the seat worktree.
  await mkdir(join(repository, "node_modules", ".bin"), { recursive: true });
  await symlink(join(import.meta.dir, "..", "node_modules", ".bin", "atdd-bun"), join(repository, "node_modules", ".bin", "atdd-bun"));
  await run(root, clean, "init", site);
  await run(site, clean, "project", "init", "demo");
  await writeFile(join(site, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
repository: ${repository}
worktree_root: ${worktrees}
roles:
  coordinator:
    address: coordinator@{project}
    branch: main
    agent: codex
    worktree: "{repository}"
  driver:
    address: driver.{name}@{project}
    branch: delivery/{name}
    base: main
    agent: codex
    worktree: "{worktree_root}/{name}"
`);
  const deskFile = join(site, "desk.yaml");
  await writeFile(deskFile, stringify({ ...parse(await readFile(deskFile, "utf8")), multiplexer: { close_inactive: true } }));
  await run(site, clean, "spawn", "demo", "coordinator", "main");
  for (const name of drivers) await run(site, clean, "spawn", "demo", "driver", name);
  return { root, site, repository, worktrees, clean, coordinator: "coordinator@demo" };
}

async function finishTask(site: string, environment: Record<string, string | undefined>, driver: string, id: string, ...doneFlags: string[]) {
  await run(site, environment, "task", "add", "demo", id, "--title", `Deliver ${id}`, "--coordinator", "coordinator@demo", "--assignee", driver, "--done-when", "Delivery branch is merged.");
  await run(site, environment, "task", "start", "demo", id, "--by", driver);
  await run(site, environment, "task", "prove", "demo", id, "--by", driver, "--item", "1", "--proof", "main already contains the delivery branch");
  await run(site, environment, "task", "review", "demo", id, "--by", driver);
  await run(site, environment, "task", "done", "demo", id, "--by", "coordinator@demo", ...doneFlags);
}


/** A finished review driver `rv` whose worktree is a detached Git checkout while the project (and primary) are governed by JJ. */
async function detachedReview(options: { reachable: boolean; dirty?: boolean; keepBranch?: boolean }) {
  const fixture = await desk(["rv"]);
  const worktree = join(fixture.worktrees, "rv");
  await finishTask(fixture.site, fixture.clean, "driver.rv@demo", "W-rv");
  if (!options.reachable) {
    await writeFile(join(worktree, "extra.txt"), "unmerged\n");
    await git(worktree, "add", "extra.txt");
    await git(worktree, "-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "unmerged review commit");
  }
  const tip = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "checkout", "--detach");
  if (!options.keepBranch) await git(fixture.repository, "branch", "-D", "delivery/rv");
  if (options.dirty) await writeFile(join(worktree, "scratch.txt"), "uncommitted\n");
  // The repository becomes a colocated JJ repository (Git HEAD detached) and the project policy becomes JJ.
  const jj = Bun.spawn(["jj", "git", "init", "--colocate"], { cwd: fixture.repository, stdout: "pipe", stderr: "pipe" });
  expect(await jj.exited, await new Response(jj.stderr).text()).toBe(0);
  const projectFile = join(fixture.site, "work", "demo", "project.yaml");
  await writeFile(projectFile, `vcs: jj\n${await readFile(projectFile, "utf8")}`);
  return { ...fixture, worktree, tip };
}

type Review = Awaited<ReturnType<typeof detachedReview>>;
const retire = (fixture: Review, by = fixture.coordinator) => spawnCli(fixture.site, fixture.clean, ["seat", "retire", "driver.rv@demo", "--by", by]);

async function expectRetired(fixture: Review) {
  const result = await retire(fixture);
  expect(result.code, result.stderr).toBe(0);
  expect(await run(fixture.site, fixture.clean, "open", "driver.rv@demo")).toContain("retired:");
  // Evidence is retained: the worktree stays at the reviewed commit.
  expect(await git(fixture.worktree, "rev-parse", "HEAD")).toBe(fixture.tip);
}

async function expectRefused(fixture: Review, match: RegExp, by = fixture.coordinator) {
  const result = await retire(fixture, by);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toMatch(match);
  expect(await run(fixture.site, fixture.clean, "open", "driver.rv@demo")).not.toContain("retired:");
  await stat(fixture.worktree);
}

test("RED: a clean detached Git review at a commit reachable from main retires under JJ policy; the worktree is retained", async () => {
  await expectRetired(await detachedReview({ reachable: true }));
});

test("RED: the same retires when the seat branch ref still exists", async () => {
  await expectRetired(await detachedReview({ reachable: true, keepBranch: true }));
});

test("guard: a dirty detached Git review is refused", async () => {
  await expectRefused(await detachedReview({ reachable: true, dirty: true }), /./);
});

test("guard: a detached Git review at a commit not reachable from main is refused", async () => {
  await expectRefused(await detachedReview({ reachable: false }), /./);
});

test("guard: retirement authorization is unchanged for detached Git reviews", async () => {
  await expectRefused(await detachedReview({ reachable: true }), /Only .* may retire/, "driver.other@demo");
});
