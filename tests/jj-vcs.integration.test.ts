// URN: test:flow:jj-vcs:E011-UNIT-001
// Acceptance: acc:flow:E011-UNIT-001
// Phase: UNIT
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

async function exec(cwd: string, command: string, ...args: string[]) {
  const child = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
  return stdout.trim();
}

async function flow(cwd: string, ...args: string[]) {
  return exec(cwd, process.execPath, cli, ...args);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("JJ integration: project selection provisions colocated workspaces and bookmarks follow working-copy rewrites", async () => {
  if (!Bun.which("jj")) return;
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-jj-"));
  roots.push(root);
  const desk = join(root, "desk"), repository = join(root, "repository"), worktrees = join(root, "worktrees");
  await mkdir(repository);
  await exec(repository, "git", "init", "--initial-branch=main");
  await exec(repository, "git", "config", "user.email", "fixture@example.test");
  await exec(repository, "git", "config", "user.name", "Fixture");
  await writeFile(join(repository, "README.md"), "initial\n");
  await exec(repository, "git", "add", "README.md");
  await exec(repository, "git", "commit", "-m", "initial");
  await exec(repository, "jj", "git", "init", "--colocate");

  await flow(root, "init", desk);
  await flow(desk, "project", "init", "demo");
  await flow(desk, "project", "configure", "demo", "--vcs", "jj", "--repository", repository, "--worktree-root", worktrees);
  const project = await readFile(join(desk, "work", "demo", "project.yaml"), "utf8");
  expect(project).toContain("vcs: jj");

  expect(await flow(desk, "spawn", "demo", "main", "primary")).toBe("main@demo");
  expect(await flow(desk, "spawn", "demo", "coordinator", "payments")).toBe("coordinator.payments@demo");
  const coordinatorWorktree = join(worktrees, "payments");
  expect(await realpath(await exec(coordinatorWorktree, "jj", "workspace", "root"))).toBe(await realpath(coordinatorWorktree));
  expect(await exec(coordinatorWorktree, "jj", "log", "-r", "integration/payments", "--no-graph", "-T", "commit_id"))
    .toBe(await exec(coordinatorWorktree, "jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"));

  await flow(desk, "task", "add", "demo", "delivery", "--title", "JJ delivery", "--coordinator", "main@demo", "--done-when", "Change is isolated.");
  expect(await flow(desk, "spawn", "demo", "driver", "feature", "--task", "delivery")).toBe("driver.feature@demo  assigned delivery  return main");
  const driver = join(worktrees, "feature");
  expect(await realpath(await exec(driver, "jj", "workspace", "root"))).toBe(await realpath(driver));

  await writeFile(join(driver, "feature.txt"), "changed through jj\n");
  await exec(driver, "jj", "status");
  const current = await exec(driver, "jj", "log", "-r", "@", "--no-graph", "-T", "commit_id");
  const bookmark = await exec(driver, "jj", "log", "-r", "delivery/feature", "--no-graph", "-T", "commit_id");
  expect(bookmark).toBe(current);
  expect(await exec(driver, "git", "rev-parse", "refs/heads/delivery/feature")).toBe(current);
});
