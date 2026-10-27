// URN: test:flow:jj-vcs-migration:E014-UNIT-001
// Acceptance: acc:flow:E014-UNIT-001
// Phase: UNIT
// Layer: integration
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
  await flow(desk, "project", "init", "demo");
  await flow(desk, "project", "configure", "demo", "--repository", repository, "--worktree-root", worktrees);
  await flow(desk, "spawn", "demo", "main", "primary");
  await flow(desk, "task", "add", "demo", "delivery", "--title", "Legacy delivery", "--coordinator", "main@demo", "--done-when", "Preserve lineage.");
  await flow(desk, "spawn", "demo", "driver", "feature", "--task", "delivery");
  return { desk, repository, worktrees };
}

/** Make the primary dirty in every way Git reports: modified, deleted, staged, untracked, binary, executable, nested. */
async function dirtyPrimary(repository: string) {
  await writeFile(join(repository, "README.md"), "initial\nlocal edit\n");
  await rm(join(repository, "removed.txt"));
  await writeFile(join(repository, "staged.txt"), "staged only\n");
  await exec(repository, "git", "add", "staged.txt");
  await mkdir(join(repository, "nested", "deep"), { recursive: true });
  await writeFile(join(repository, "nested", "deep", "untracked.txt"), "untracked\n");
  await writeFile(join(repository, "binary.bin"), Buffer.from([0, 255, 1, 254, 2]));
  await writeFile(join(repository, "tool.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(repository, "tool.sh"), 0o755);
  await writeFile(join(repository, ".gitignore"), "*.log\n");
  await writeFile(join(repository, "ignored.log"), "ignored stays on disk\n");
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

async function gitState(repository: string) {
  return {
    main: await exec(repository, "git", "rev-parse", "refs/heads/main"),
    commits: await exec(repository, "git", "rev-list", "--count", "refs/heads/main"),
    stash: await exec(repository, "git", "stash", "list"),
  };
}

const projectVcsIsJj = async (desk: string) => (await readFile(join(desk, "work", "demo", "project.yaml"), "utf8")).includes("vcs: jj");

test("dirty primary dry-run reports retained entries and mutates nothing", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository } = await fixture();
  await dirtyPrimary(repository);
  const before = await tree(repository);
  const git = await gitState(repository);

  const plan = await flow(desk, "project", "migrate-vcs", "demo", "--to", "jj", FLAG, "--dry-run");
  expect(plan).toContain("atdd-flow/vcs-migration-plan/v1");
  expect(plan).toContain("dirty_primary");
  expect(plan).toContain("nested/deep/untracked.txt");
  expect(plan).toContain("removed.txt");
  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);
  expect(await tree(repository)).toEqual(before);
  expect(await gitState(repository)).toEqual(git);
  expect(await projectVcsIsJj(desk)).toBe(false);
});

test("dirty primary migrates with exact working-copy content retained as JJ @ and no Git history change", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository, worktrees } = await fixture();
  await dirtyPrimary(repository);
  const before = await tree(repository);
  const git = await gitState(repository);
  const driver = join(worktrees, "feature");
  const driverTip = await exec(driver, "git", "rev-parse", "delivery/feature");

  expect(await flow(desk, "project", "migrate-vcs", "demo", "--to", "jj", FLAG)).toContain("migrated git -> jj");
  expect(await projectVcsIsJj(desk)).toBe(true);

  // Git history is untouched: same main tip, no new commits, no stash.
  expect(await gitState(repository)).toEqual(git);
  // On-disk bytes and executable bits (including ignored files) are identical.
  expect(await tree(repository)).toEqual({ ...before, ...{} });
  // The dirty work is the JJ working-copy revision directly above the unchanged main tip.
  expect(await exec(repository, "jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id")).toBe(git.main);
  expect(await exec(repository, "jj", "log", "-r", "main", "--no-graph", "-T", "commit_id")).toBe(git.main);
  const changed = (await exec(repository, "jj", "diff", "-r", "@", "--name-only")).split("\n").sort();
  expect(changed).toEqual([".gitignore", "README.md", "binary.bin", "nested/deep/untracked.txt", "removed.txt", "staged.txt", "tool.sh"]);
  // Bytes recorded in @ equal the bytes on disk (binary and executable preserved, deletion recorded).
  const head = await exec(repository, "jj", "log", "-r", "@", "--no-graph", "-T", "commit_id");
  const blob = (path: string) => exec(repository, "git", "rev-parse", `${head}:${path}`);
  const disk = (path: string) => exec(repository, "git", "hash-object", "--no-filters", path);
  for (const path of ["README.md", "binary.bin", "nested/deep/untracked.txt", "staged.txt", "tool.sh"]) expect(await blob(path)).toBe(await disk(path));
  expect(await exec(repository, "git", "ls-tree", head, "tool.sh")).toStartWith("100755");
  expect(await exec(repository, "git", "ls-tree", head, "removed.txt")).toBe("");
  expect((await stat(join(repository, "ignored.log"))).isFile()).toBe(true);
  // Secondary workspace conversion is unchanged by the flag.
  expect(await exec(driver, "jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id")).toBe(driverTip);
});

test("dirty primary without the explicit flag is still refused and names the flag", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository } = await fixture();
  await dirtyPrimary(repository);
  const before = await tree(repository);

  const error = await failFlow(desk, "project", "migrate-vcs", "demo", "--to", "jj");
  expect(error).toContain("worktree is dirty");
  expect(error).toContain(FLAG);
  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);
  expect(await tree(repository)).toEqual(before);
  expect(await projectVcsIsJj(desk)).toBe(false);
});

test("the flag never admits a dirty secondary worktree", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository, worktrees } = await fixture();
  await dirtyPrimary(repository);
  await writeFile(join(worktrees, "feature", "dirty.txt"), "uncommitted\n");
  const before = await tree(repository);

  const error = await failFlow(desk, "project", "migrate-vcs", "demo", "--to", "jj", FLAG);
  expect(error).toContain("worktree is dirty");
  expect(error).toContain(join(worktrees, "feature").replace(/^\/private/, ""));
  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);
  expect(await tree(repository)).toEqual(before);
  expect(await projectVcsIsJj(desk)).toBe(false);
});

test("dirty primary content JJ would refuse to snapshot fails closed before JJ metadata exists", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository } = await fixture();
  await writeFile(join(repository, "large.bin"), Buffer.alloc(1_100_000, 1)); // > JJ snapshot.max-new-file-size (1 MiB)
  const before = await tree(repository);

  const error = await failFlow(desk, "project", "migrate-vcs", "demo", "--to", "jj", FLAG);
  expect(error).toContain("large.bin");
  expect(error).toMatch(/snapshot|retain|size/i);
  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);
  expect(await tree(repository)).toEqual(before);
  expect(await projectVcsIsJj(desk)).toBe(false);
});

/** A `jj` shim that delegates to the real binary but fails `workspace add`, forcing failure after `jj git init --colocate`. */
async function failingWorkspaceAddPath(root: string) {
  const real = Bun.which("jj")!;
  const bin = join(root, "shim-bin");
  await mkdir(bin, { recursive: true });
  const shim = join(bin, "jj");
  await writeFile(shim, `#!/bin/sh\nif [ "$1" = "workspace" ] && [ "$2" = "add" ]; then echo "injected workspace add failure" >&2; exit 1; fi\nexec "${real}" "$@"\n`);
  await chmod(shim, 0o755);
  return `${bin}:${process.env.PATH}`;
}

test("failure after JJ initialization restores primary Git index bytes, working tree, and Git state", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository, worktrees } = await fixture();
  await dirtyPrimary(repository);
  const indexDigest = async () => new Bun.CryptoHasher("sha256").update(await readFile(join(repository, ".git", "index"))).digest("hex");
  const indexBefore = await indexDigest();
  const before = await tree(repository);
  const git = await gitState(repository);
  const driver = join(worktrees, "feature");

  const child = Bun.spawn([process.execPath, cli, "project", "migrate-vcs", "demo", "--to", "jj", FLAG], {
    cwd: desk, env: { ...isolatedEnv, PATH: await failingWorkspaceAddPath(join(repository, "..")) }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).not.toBe(0);
  expect(`${stdout}${stderr}`).toContain("JJ migration failed before project.vcs changed");
  expect(`${stdout}${stderr}`).toContain("injected workspace add failure");
  expect(`${stdout}${stderr}`).not.toContain("rollback was incomplete");

  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);
  expect(await indexDigest()).toBe(indexBefore);       // exact .git/index bytes restored
  expect(await tree(repository)).toEqual(before);      // working tree bytes + modes unchanged
  expect(await gitState(repository)).toEqual(git);     // main, commit count, stash unchanged
  expect(await exec(repository, "git", "for-each-ref", "refs/jj/")).toBe(""); // no JJ bookkeeping refs left behind
  expect(await exec(repository, "git", "status", "--porcelain=v1", "-uall")).toContain("A  staged.txt"); // staged state, not untracked->added
  expect(await exec(repository, "git", "status", "--porcelain=v1", "-uall")).toContain("?? nested/deep/untracked.txt");
  expect(await exec(driver, "git", "branch", "--show-current")).toBe("delivery/feature"); // secondary Git worktree restored
  expect(await projectVcsIsJj(desk)).toBe(false);
});
