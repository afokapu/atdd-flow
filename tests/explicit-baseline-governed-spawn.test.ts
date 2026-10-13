// URN: test:flow:explicit-baseline-governed-spawn:E002-RED-001
// Acceptance: acc:flow:E002-RED-001
// Phase: UNIT
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

type Fixture = { root: string; site: string; repository: string; worktrees: string; base: string; task: string; };

async function invoke(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

async function run(cwd: string, ...args: string[]) {
  const result = await invoke(cwd, ...args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "atdd-explicit-base-spawn-"));
  roots.push(root);
  const site = join(root, "desk"), repository = join(root, "repository"), worktrees = join(root, "worktrees"), task = "baseline-child";
  await mkdir(repository); await mkdir(worktrees);
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.email", "fixture@example.test"); await git(repository, "config", "user.name", "Fixture");
  await writeFile(join(repository, "README.md"), "initial\n"); await git(repository, "add", "README.md"); await git(repository, "commit", "-m", "initial");
  await writeFile(join(repository, "BASELINE.md"), "explicit baseline\n"); await git(repository, "add", "BASELINE.md"); await git(repository, "commit", "-m", "baseline");
  const base = await git(repository, "rev-parse", "HEAD");
  await run(root, "init", site); await run(site, "project", "init", "demo");
  const projectFile = join(site, "work", "demo", "project.yaml");
  const project = Bun.YAML.parse(await Bun.file(projectFile).text()) as Record<string, unknown>;
  project.repository = repository; project.worktree_root = worktrees; await Bun.write(projectFile, Bun.YAML.stringify(project));
  await run(site, "spawn", "demo", "main", "primary");
  await run(site, "task", "add", "demo", task, "--title", "Spawn from explicit base", "--coordinator", "main@demo", "--done-when", "Create only the governed driver.");
  return { root, site, repository, worktrees, base, task };
}

async function tree(root: string, folder: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(out, await tree(root, full));
    else out[relative(root, full)] = await readFile(full, "utf8");
  }
  return out;
}

async function snapshot(subject: Fixture) {
  return {
    desk: await tree(subject.site, join(subject.site, "work", "demo")),
    refs: await git(subject.repository, "for-each-ref", "--format=%(refname) %(objectname)"),
    worktrees: await git(subject.repository, "worktree", "list", "--porcelain"),
    status: await git(subject.repository, "status", "--porcelain=v1"),
  };
}

function spawnArgs(subject: Fixture, base = subject.base, extra: string[] = []) {
  return ["spawn", "demo", "driver", "child", "--task", subject.task, "--base", base, ...extra];
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("GREEN: explicit base dry-run reports an exact proposal without Desk, ref, worktree, or runtime effects", async () => {
  const subject = await fixture(); const before = await snapshot(subject);
  const result = await invoke(subject.site, ...spawnArgs(subject, subject.base, ["--dry-run"]));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(`driver.child@demo  dry-run ${subject.task}  base ${subject.base}  branch delivery/child  worktree ${join(subject.worktrees, "child")}`);
  expect(await snapshot(subject)).toEqual(before);
});

test("GREEN: malformed, missing, unrelated, and non-descendant explicit bases fail closed", async () => {
  const subject = await fixture();
  const nonDescendant = await git(subject.repository, "rev-parse", "HEAD^");
  const unrelated = await git(subject.repository, "commit-tree", "HEAD^{tree}", "-m", "unrelated");
  for (const base of ["abc", subject.base.slice(0, 12), "0".repeat(40), unrelated, nonDescendant]) {
    const before = await snapshot(subject); const result = await invoke(subject.site, ...spawnArgs(subject, base, ["--dry-run"]));
    expect(result.code).not.toBe(0); expect(await snapshot(subject)).toEqual(before);
  }
  const missingBefore = await snapshot(subject);
  const missing = await invoke(subject.site, "spawn", "demo", "driver", "child", "--task", subject.task, "--dry-run");
  expect(missing.code).not.toBe(0); expect(await snapshot(subject)).toEqual(missingBefore);
});

test("GREEN: invalid targets, task state, and topology fail closed without Desk, ref, worktree, or runtime effects", async () => {
  const collision = await fixture();
  await mkdir(join(collision.worktrees, "child"));
  const collisionBefore = await snapshot(collision);
  expect((await invoke(collision.site, ...spawnArgs(collision, collision.base, ["--dry-run"]))).code).not.toBe(0);
  expect(await snapshot(collision)).toEqual(collisionBefore);

  const branch = await fixture();
  await git(branch.repository, "branch", "delivery/child", "main");
  const branchBefore = await snapshot(branch);
  expect((await invoke(branch.site, ...spawnArgs(branch))).code).not.toBe(0);
  expect(await snapshot(branch)).toEqual(branchBefore);

  const seat = await fixture();
  await run(seat.site, "spawn", "demo", "driver", "child");
  const seatBefore = await snapshot(seat);
  expect((await invoke(seat.site, ...spawnArgs(seat))).code).not.toBe(0);
  expect(await snapshot(seat)).toEqual(seatBefore);

  const assigned = await fixture();
  const assignedTask = join(assigned.site, "work", "demo", "tasks", `${assigned.task}.yaml`);
  const assignedRecord = Bun.YAML.parse(await Bun.file(assignedTask).text()) as Record<string, unknown>;
  assignedRecord.status = "in_progress"; assignedRecord.assignee = "driver.elsewhere@demo";
  await Bun.write(assignedTask, Bun.YAML.stringify(assignedRecord));
  const assignedBefore = await snapshot(assigned);
  expect((await invoke(assigned.site, ...spawnArgs(assigned))).code).not.toBe(0);
  expect(await snapshot(assigned)).toEqual(assignedBefore);

  const crossProject = await fixture();
  const crossTask = join(crossProject.site, "work", "demo", "tasks", `${crossProject.task}.yaml`);
  const crossRecord = Bun.YAML.parse(await Bun.file(crossTask).text()) as Record<string, unknown>;
  crossRecord.coordinator = "main@other";
  await Bun.write(crossTask, Bun.YAML.stringify(crossRecord));
  const crossBefore = await snapshot(crossProject);
  expect((await invoke(crossProject.site, ...spawnArgs(crossProject))).code).not.toBe(0);
  expect(await snapshot(crossProject)).toEqual(crossBefore);

  const topology = await fixture();
  const projectFile = join(topology.site, "work", "demo", "project.yaml");
  const project = Bun.YAML.parse(await Bun.file(projectFile).text()) as { roles: { driver: { branch: string } } };
  project.roles.driver.branch = "delivery/not-{name}";
  await Bun.write(projectFile, Bun.YAML.stringify(project));
  const topologyBefore = await snapshot(topology);
  expect((await invoke(topology.site, ...spawnArgs(topology))).code).not.toBe(0);
  expect(await snapshot(topology)).toEqual(topologyBefore);
});

test("GREEN: a post-Git Desk write failure removes only the new branch, worktree, and seat", async () => {
  const subject = await fixture();
  const taskDirectory = join(subject.site, "work", "demo", "tasks");
  const before = await snapshot(subject);
  await chmod(taskDirectory, 0o555);
  try {
    const result = await invoke(subject.site, ...spawnArgs(subject));
    expect(result.code).not.toBe(0);
  } finally {
    await chmod(taskDirectory, 0o755);
  }
  expect(await snapshot(subject)).toEqual(before);
});

test("GREEN: explicit-base success creates only the exact governed target while legacy spawn remains unchanged without --base", async () => {
  const subject = await fixture();
  const explicitBase = await git(subject.repository, "commit-tree", `${subject.base}^{tree}`, "-p", subject.base, "-m", "descendant baseline");
  await writeFile(join(subject.repository, "DIRTY.md"), "primary is deliberately dirty\n");
  const result = await invoke(subject.site, ...spawnArgs(subject, explicitBase));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(`driver.child@demo  assigned ${subject.task}  return main  base ${explicitBase}`);
  const task = await Bun.file(join(subject.site, "work", "demo", "tasks", `${subject.task}.yaml`)).text();
  expect(task).toContain(`commit: ${explicitBase}`);
  expect(await git(join(subject.worktrees, "child"), "rev-parse", "HEAD")).toBe(explicitBase);

  const legacy = await fixture();
  expect(await run(legacy.site, "spawn", "demo", "driver", "legacy", "--task", legacy.task)).toBe(`driver.legacy@demo  assigned ${legacy.task}  return main`);
}, 20_000);
