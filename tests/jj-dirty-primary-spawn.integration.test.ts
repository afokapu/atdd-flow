// URN: test:flow:jj-dirty-primary-spawn:E014-UNIT-001
// Acceptance: acc:flow:E014-UNIT-001
// Phase: UNIT
// Layer: integration
// Purpose: A Git project whose primary holds staged toolkit surfaces migrates to JJ and then spawns a driver from the last committed
// main lineage through public commands, leaving the dirty primary untouched by hash; a primary that is not at main stays refused.
import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * RED contract for `project migrate-vcs <project> --to jj --allow-dirty-primary`.
 * Only the single primary-checkout seat may carry uncommitted work; it becomes the
 * JJ `@` revision above the unchanged `main` tip. Git is only read: no commit,
 * stash, reset, clean, checkout, or branch/ref movement. Every fixture is a
 * mkdtemp-isolated Desk and repository; the live Desk is never referenced.
 */
const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const FLAG = "--allow-dirty-primary";
// Isolation: the harness seat exports ATDD_WORKFLOW_ROOT (the live Desk). Spawned CLIs must never inherit it.
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ATDD_")));

async function exec(cwd: string, command: string, ...args: string[]) {
  const child = Bun.spawn([command, ...args], { cwd, env: isolatedEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
  return stdout.trim();
}
const flow = (cwd: string, ...args: string[]) => exec(cwd, process.execPath, cli, ...args);

async function failFlow(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: isolatedEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).not.toBe(0);
  return `${stdout}${stderr}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-jj-dirty-primary-"));
  roots.push(root);
  const desk = join(root, "desk"), repository = join(root, "repository"), worktrees = join(root, "worktrees");
  await mkdir(repository);
  await exec(repository, "git", "init", "--initial-branch=main");
  await exec(repository, "git", "config", "user.email", "fixture@example.test");
  await exec(repository, "git", "config", "user.name", "Fixture");
  await writeFile(join(repository, "README.md"), "initial\n");
  await writeFile(join(repository, "removed.txt"), "tracked then deleted\n");
  await writeFile(join(repository, "run.sh"), "#!/bin/sh\n");
  await exec(repository, "git", "add", ".");
  await exec(repository, "git", "commit", "-m", "initial");
  await flow(root, "init", desk);
  await flow(desk, "project", "init", "demo", "--vcs", "git");
  await flow(desk, "project", "configure", "demo", "--repository", repository, "--worktree-root", worktrees);
  await flow(desk, "spawn", "demo", "main", "primary");
  await flow(desk, "task", "add", "demo", "delivery", "--title", "Legacy delivery", "--coordinator", "main@demo", "--done-when", "Preserve lineage.");
  return { desk, repository, worktrees };
}

/** Exact bytes + executable bit of every working-copy file outside VCS metadata. */
async function tree(repository: string) {
  const entries: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".jj") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      const mode = (await lstat(path)).mode & 0o111 ? "x" : "-";
      const hash = new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex");
      entries[relative(repository, path)] = `${mode}:${hash}`;
    }
  };
  await walk(repository);
  return entries;
}


/** Staged canonical toolkit surfaces, including a hook that rejects every commit on the protected main. */
async function stageToolkit(repository: string) {
  await mkdir(join(repository, ".githooks"), { recursive: true });
  await writeFile(join(repository, "AGENTS.md"), "toolkit instructions\n");
  await writeFile(join(repository, "atdd-bun.yaml"), "worktrees:\n  enabled: true\n");
  await writeFile(join(repository, ".githooks", "pre-commit"), "#!/bin/sh\necho protected main >&2\nexit 1\n");
  await chmod(join(repository, ".githooks", "pre-commit"), 0o755);
  await writeFile(join(repository, "README.md"), "initial\nregenerated toolkit surface\n");
  await exec(repository, "git", "add", "AGENTS.md", "atdd-bun.yaml", ".githooks/pre-commit", "README.md");
}

const projectVcsIsJj = async (desk: string) => (await readFile(join(desk, "work", "demo", "project.yaml"), "utf8")).includes("vcs: jj");

test("a staged-toolkit primary migrates to JJ, then spawns a driver from committed main without touching the primary", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository, worktrees } = await fixture();
  await stageToolkit(repository);
  const staged = await exec(repository, "git", "diff", "--cached");
  const main = await exec(repository, "git", "rev-parse", "refs/heads/main");
  const before = await tree(repository);

  // Fail closed while the project is still Git: a dirty primary is not a spawn base and nothing is created.
  expect(await failFlow(desk, "spawn", "demo", "driver", "early", "--task", "delivery")).toContain("worktree is dirty");
  expect(await Bun.file(join(worktrees, "early")).exists()).toBe(false);

  expect(await flow(desk, "project", "migrate-vcs", "demo", "--to", "jj", FLAG)).toContain("migrated git -> jj");
  expect(await projectVcsIsJj(desk)).toBe(true);
  const dirtyDiff = await exec(repository, "jj", "diff", "-r", "@", "--git");
  expect(dirtyDiff).toContain("AGENTS.md");

  // The supported spawn: from the last committed lineage, with the dirty primary left exactly as it is.
  expect(await flow(desk, "spawn", "demo", "driver", "feature", "--task", "delivery")).toContain("assigned delivery");
  const driver = join(worktrees, "feature");
  expect(await exec(driver, "jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id")).toBe(main);
  expect(await exec(driver, "jj", "diff", "-r", "@", "--name-only")).toBe("");
  expect(await Bun.file(join(driver, "AGENTS.md")).exists()).toBe(false);
  expect(await tree(repository)).toEqual(before);
  expect(await exec(repository, "jj", "diff", "-r", "@", "--git")).toBe(dirtyDiff);
  expect(await exec(repository, "git", "rev-parse", "refs/heads/main")).toBe(main);
  expect(await exec(repository, "git", "rev-list", "--count", "refs/heads/main")).toBe("1");
  expect(staged).toContain("+toolkit instructions");
});

test("a JJ primary that is not exactly main plus working-copy changes is still refused and nothing is created", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository, worktrees } = await fixture();
  await stageToolkit(repository);
  await flow(desk, "project", "migrate-vcs", "demo", "--to", "jj", FLAG);
  // Committed work above main makes the primary a different lineage: @- is no longer the main tip.
  await exec(repository, "jj", "new");
  const before = await tree(repository);
  const error = await failFlow(desk, "spawn", "demo", "driver", "stale", "--task", "delivery");
  expect(error).toContain("is not ready");
  expect(error).toContain("stale relative to main");
  expect(await Bun.file(join(worktrees, "stale")).exists()).toBe(false);
  expect(await tree(repository)).toEqual(before);
});
