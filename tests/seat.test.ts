import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "seat.ts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim();
}

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim();
}

test("a request remains outstanding until its linked result exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-seat-"));
  roots.push(root);
  const project = join(root, "demo");

  await run(root, "init", project);
  await run(project, "spawn", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(project, "spawn", "driver", "runtime", "--worktree", "/tmp/demo-runtime");
  const thread = await run(project, "thread", "start", "--with", "coordinator@demo,driver.runtime@demo", "--subject", "Runtime rollout");
  const request = await run(project, "post", thread, "--from", "coordinator@demo", "--to", "driver.runtime@demo", "--expects-result", "--body", "Run checks");

  await run(project, "receipt", thread, request, "--from", "driver.runtime@demo");
  expect(await run(project, "status")).toContain(`waiting:${request}`);

  await run(project, "result", thread, request, "--from", "driver.runtime@demo", "--body", "Checks pass");
  expect(await run(project, "status")).not.toContain("waiting:");
});

test("a configured driver worktree is created on its declared branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-seat-"));
  roots.push(root);
  const repository = join(root, "repository");
  const project = join(root, "state");
  await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "test@example.test");
  await git(repository, "config", "user.name", "Test");
  await git(repository, "commit", "--allow-empty", "-m", "initial");
  await run(root, "init", project);
  await writeFile(join(project, "project.yaml"), `schema: atdd-seat/project/v1
project: demo
backend: tmux
repository: ${repository}
worktree_root: ${join(root, "worktrees")}
roles:
  driver:
    address: driver.{name}@{project}
    branch: delivery/{name}
    base: main
    agent: codex
    worktree: "{worktree_root}/{name}"
`);

  await run(project, "spawn", "driver", "runtime");
  await stat(join(root, "worktrees", "runtime", ".git"));
  expect(await git(join(root, "worktrees", "runtime"), "branch", "--show-current")).toBe("delivery/runtime");
});

test("a broadcast request remains open until every targeted participant replies", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-seat-"));
  roots.push(root);
  const project = join(root, "demo");
  await run(root, "init", project);
  await run(project, "spawn", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(project, "spawn", "driver", "one", "--worktree", "/tmp/demo-one");
  await run(project, "spawn", "driver", "two", "--worktree", "/tmp/demo-two");
  const thread = await run(project, "thread", "start", "--with", "coordinator@demo,driver.one@demo,driver.two@demo", "--subject", "Fan out");
  const request = await run(project, "post", thread, "--from", "coordinator@demo", "--to", "all", "--expects-result", "--body", "Report status");

  await run(project, "result", thread, request, "--from", "driver.one@demo", "--body", "One complete");
  expect(await run(project, "status")).toContain(`${request}@driver.two@demo`);
  await run(project, "result", thread, request, "--from", "driver.two@demo", "--body", "Two complete");
  expect(await run(project, "status")).not.toContain("waiting:");
});
