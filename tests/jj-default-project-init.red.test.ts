// URN: test:atdd-flow:jj-default-project-init
// Acceptance: acc:flow:E026-UNIT-001
// Phase: UNIT
// Layer: integration
// Purpose: A new project defaults to Jujutsu end to end; Git is an explicit opt-out and legacy records stay Git.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vcsMode } from "../src/vcs";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ATDD_")));

async function exec(cwd: string, command: string, ...args: string[]) {
  const child = Bun.spawn([command, ...args], { cwd, env: isolatedEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: `${stdout}${stderr}`.trim() };
}
const ok = async (cwd: string, command: string, ...args: string[]) => { const r = await exec(cwd, command, ...args); expect(r.code, r.out).toBe(0); return r.out; };
const flow = (cwd: string, ...args: string[]) => ok(cwd, process.execPath, cli, ...args);
const refused = async (cwd: string, ...args: string[]) => { const r = await exec(cwd, process.execPath, cli, ...args); expect(r.code, r.out).not.toBe(0); return r.out; };

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(colocate: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atdd-flow-jj-default-")));
  roots.push(root);
  const desk = join(root, "desk"), repository = join(root, "repository"), worktrees = join(root, "worktrees");
  await mkdir(repository);
  await ok(repository, "git", "init", "--initial-branch=main");
  await ok(repository, "git", "config", "user.email", "fixture@example.test");
  await ok(repository, "git", "config", "user.name", "Fixture");
  await writeFile(join(repository, "README.md"), "initial\n");
  await ok(repository, "git", "add", "README.md");
  await ok(repository, "git", "commit", "-m", "initial");
  if (colocate) await ok(repository, "jj", "git", "init", "--colocate");
  await flow(root, "init", desk);
  return { root, desk, repository, worktrees, projectFile: (name: string) => join(desk, "work", name, "project.yaml") };
}

test("RED: project init records vcs jj by default", async () => {
  const { desk, projectFile } = await fixture(false);
  await flow(desk, "project", "init", "demo");
  expect(await readFile(projectFile("demo"), "utf8")).toContain("vcs: jj");
});

test("Git is an explicit per-project opt-out", async () => {
  const { desk, repository, worktrees, projectFile } = await fixture(false);
  await flow(desk, "project", "init", "legacy", "--vcs", "git");
  expect(await readFile(projectFile("legacy"), "utf8")).toContain("vcs: git");
  await flow(desk, "project", "configure", "legacy", "--repository", repository, "--worktree-root", worktrees);
  expect(await flow(desk, "spawn", "legacy", "main", "primary")).toBe("main@legacy");
});

test("an unknown VCS value or a stray argument is refused", async () => {
  const { desk } = await fixture(false);
  expect(await refused(desk, "project", "init", "demo", "--vcs", "hg")).toContain("project init");
  expect(await refused(desk, "project", "init", "demo", "--other")).toContain("project init");
});

test("a Git-only checkout on a default project is refused with the JJ diagnostic and the opt-out", async () => {
  const { desk, repository, worktrees } = await fixture(false);
  await flow(desk, "project", "init", "demo");
  const message = await refused(desk, "project", "configure", "demo", "--repository", repository, "--worktree-root", worktrees);
  expect(message).toContain("Jujutsu");
  expect(message).toContain("--vcs git");
});

test("a default project provisions main, coordinator and driver through JJ without any VCS flag", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository, worktrees } = await fixture(true);
  await flow(desk, "project", "init", "demo");
  await flow(desk, "project", "configure", "demo", "--repository", repository, "--worktree-root", worktrees);
  expect(await flow(desk, "spawn", "demo", "main", "primary")).toBe("main@demo");
  expect(await flow(desk, "spawn", "demo", "coordinator", "payments")).toBe("coordinator.payments@demo");
  const coordinator = join(worktrees, "payments");
  expect(await realpath(await ok(coordinator, "jj", "workspace", "root"))).toBe(await realpath(coordinator));
  await flow(desk, "task", "add", "demo", "delivery", "--title", "JJ delivery", "--coordinator", "main@demo", "--done-when", "Isolated.");
  expect(await flow(desk, "spawn", "demo", "driver", "feature", "--task", "delivery")).toContain("driver.feature@demo");
  const driver = join(worktrees, "feature");
  expect(await realpath(await ok(driver, "jj", "workspace", "root"))).toBe(await realpath(driver));
  expect(await ok(driver, "jj", "log", "-r", "delivery/feature", "--no-graph", "-T", "commit_id")).toMatch(/^[0-9a-f]{40}$/);
});

test("a legacy project record without a vcs field keeps reading as Git", () => {
  expect(vcsMode({})).toBe("git");
});
