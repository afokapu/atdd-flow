// URN: test:flow:explicit-baseline-governed-spawn:E002-RED-001
// Acceptance: acc:flow:E002-RED-001
// Phase: RED
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("RED: explicit base dry-run reports an exact proposal without Desk, ref, worktree, or runtime effects", async () => {
  const subject = await fixture(); const before = await snapshot(subject);
  const result = await invoke(subject.site, ...spawnArgs(subject, subject.base, ["--dry-run"]));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(`driver.child@demo  dry-run ${subject.task}  base ${subject.base}  branch delivery/child  worktree ${join(subject.worktrees, "child")}`);
  expect(await snapshot(subject)).toEqual(before);
});

test("RED: invalid explicit bases and invalid targets fail closed without partial effects", async () => {
  const subject = await fixture();
  const unrelated = await git(subject.repository, "rev-parse", "HEAD^");
  for (const base of ["abc", "0".repeat(40), unrelated]) {
    const before = await snapshot(subject); const result = await invoke(subject.site, ...spawnArgs(subject, base, ["--dry-run"]));
    // The unsupported implementation currently accepts --base; this is an intentional RED behavioral witness.
    if (result.code === 0) expect(true).toBe(false);
    expect(result.code).not.toBe(0); expect(await snapshot(subject)).toEqual(before);
  }
  // GREEN must additionally cover missing base, dirty/existing targets, branch/worktree/seat collisions,
  // unready/assigned/cross-project tasks, role/topology mismatch, and atomic post-write rollback.
});

test("RED: explicit-base success creates only the exact governed target while legacy spawn remains unchanged without --base", async () => {
  const subject = await fixture();
  const result = await invoke(subject.site, ...spawnArgs(subject));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(`driver.child@demo  assigned ${subject.task}  return main  base ${subject.base}`);
  const task = await Bun.file(join(subject.site, "work", "demo", "tasks", `${subject.task}.yaml`)).text();
  expect(task).toContain(`commit: ${subject.base}`);
  expect(await git(join(subject.worktrees, "child"), "rev-parse", "HEAD")).toBe(subject.base);

  const legacy = await fixture();
  expect(await run(legacy.site, "spawn", "demo", "driver", "legacy", "--task", legacy.task)).toBe(`driver.legacy@demo  assigned ${legacy.task}  return main`);
}, 20_000);
