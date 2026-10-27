// URN: test:flow:jj-vcs-migration:E017-UNIT-001
// Acceptance: acc:flow:E017-UNIT-001
// Phase: UNIT
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * RED contract for `project migrate-vcs <project> --to jj --allow-dirty-primary
 * --retain-large-primary-file <path>:<sha256>:<bytes>:<mode>` (repeatable).
 *
 * JJ silently skips new files above snapshot.max-new-file-size (1 MiB). The dirty-primary
 * path therefore refuses them. This contract adds an explicit, exact, per-file exemption (flag repeatable, one per file):
 * the operator names the repo-relative path plus the file's sha256, byte length and
 * permission mode; the migration retains exactly the named files in the JJ `@` revision and
 * still refuses every other over-limit file. Git is only read. Every fixture is a
 * mkdtemp-isolated Desk and repository; the live Desk and its backups are never referenced.
 */
const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const DIRTY = "--allow-dirty-primary";
const RETAIN = "--retain-large-primary-file";
const LARGE_PATH = ".atdd-flow/runtime-launch/backups/newest.jsonl";
const OLDER_PATH = ".atdd-flow/runtime-launch/backups/older.jsonl";
const LARGE_BYTES = 1_299_770;
const OLDER_BYTES = 4_043_344;
// Isolation: the harness seat exports ATDD_WORKFLOW_ROOT (the live Desk). Spawned CLIs must never inherit it.
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ATDD_")));

async function run(cwd: string, env: Record<string, string | undefined>, command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}
async function exec(cwd: string, command: string, ...args: string[]) {
  const result = await run(cwd, isolatedEnv, command, args);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
const flow = (cwd: string, ...args: string[]) => exec(cwd, process.execPath, cli, ...args);
async function failFlow(cwd: string, ...args: string[]) {
  const result = await run(cwd, isolatedEnv, process.execPath, [cli, ...args]);
  expect(result.code).not.toBe(0);
  return `${result.stdout}${result.stderr}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
/** Deterministic non-compressible bytes so the digest is stable across runs. */
function payload(bytes: number, seed: number) {
  const out = Buffer.alloc(bytes);
  let state = seed >>> 0;
  for (let index = 0; index < bytes; index += 1) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; out[index] = state >>> 24; }
  return out;
}
const LARGE = payload(LARGE_BYTES, 7);
const OLDER = payload(OLDER_BYTES, 11);
const spec = (path = LARGE_PATH, digest = sha256(LARGE), bytes = LARGE_BYTES, mode = "0644") => `${path}:${digest}:${bytes}:${mode}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-jj-large-primary-"));
  roots.push(root);
  const desk = join(root, "desk"), repository = join(root, "repository"), worktrees = join(root, "worktrees");
  await mkdir(repository);
  await exec(repository, "git", "init", "--initial-branch=main");
  await exec(repository, "git", "config", "user.email", "fixture@example.test");
  await exec(repository, "git", "config", "user.name", "Fixture");
  await writeFile(join(repository, "README.md"), "initial\n");
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

/** Untracked large record (mode 0644, fixed mtime) plus ordinary dirty content. */
async function dirtyWithLargeRecord(repository: string, options: { older?: boolean } = {}) {
  await mkdir(join(repository, ".atdd-flow", "runtime-launch", "backups"), { recursive: true });
  await writeFile(join(repository, LARGE_PATH), LARGE);
  await chmod(join(repository, LARGE_PATH), 0o644);
  await utimes(join(repository, LARGE_PATH), new Date("2026-10-26T08:46:37Z"), new Date("2026-10-26T08:46:37Z"));
  await writeFile(join(repository, "README.md"), "initial\nlocal edit\n");
  await writeFile(join(repository, "small.txt"), "ordinary dirty\n");
  if (options.older) await writeFile(join(repository, OLDER_PATH), OLDER);
}

/** Exact bytes + mode + mtime of every working-copy file outside VCS metadata. */
async function tree(repository: string) {
  const entries: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".jj") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      const info = await lstat(path);
      entries[relative(repository, path)] = `${(info.mode & 0o777).toString(8)}:${info.size}:${info.mtimeMs}:${sha256(await readFile(path))}`;
    }
  };
  await walk(repository);
  return entries;
}

/** Git history evidence that must be identical before and after migration. */
async function gitHistory(repository: string) {
  return {
    head: await exec(repository, "git", "symbolic-ref", "HEAD"),
    main: await exec(repository, "git", "rev-parse", "refs/heads/main"),
    commits: await exec(repository, "git", "rev-list", "--count", "refs/heads/main"),
    // Secondary branches intentionally gain a JJ working-copy anchor child; main and tags must not move.
    refs: await exec(repository, "git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/main", "refs/tags"),
    reflog: await exec(repository, "git", "reflog", "--format=%H %gs"),
    stash: await exec(repository, "git", "stash", "list"),
  };
}
const indexDigest = async (repository: string) => sha256(await readFile(join(repository, ".git", "index")));
const projectVcsIsJj = async (desk: string) => (await readFile(join(desk, "work", "demo", "project.yaml"), "utf8")).includes("vcs: jj");
const jjHead = (repository: string) => exec(repository, "jj", "log", "-r", "@", "--no-graph", "-T", "commit_id");

/** Nothing about the repository, working tree, Git history, index, or Desk changed. */
async function expectUntouched(desk: string, repository: string, before: { tree: Record<string, string>; git: Awaited<ReturnType<typeof gitHistory>>; index: string }) {
  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);
  expect(await tree(repository)).toEqual(before.tree);
  expect(await gitHistory(repository)).toEqual(before.git);
  expect(await indexDigest(repository)).toBe(before.index);
  expect(await projectVcsIsJj(desk)).toBe(false);
}
async function snapshotBefore(repository: string) {
  return { tree: await tree(repository), git: await gitHistory(repository), index: await indexDigest(repository) };
}

test("dry-run with the exact authorization reports the retained large record and mutates nothing", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository } = await fixture();
  await dirtyWithLargeRecord(repository);
  const before = await snapshotBefore(repository);

  const plan = await flow(desk, "project", "migrate-vcs", "demo", "--to", "jj", DIRTY, RETAIN, spec(), "--dry-run");
  expect(plan).toContain("atdd-flow/vcs-migration-plan/v1");
  expect(plan).toContain("large_primary");
  expect(plan).toContain(LARGE_PATH);
  expect(plan).toContain(sha256(LARGE));
  expect(plan).toContain(String(LARGE_BYTES));
  expect(plan).toContain("0644");
  await expectUntouched(desk, repository, before);
});

test("the authorized large record is retained byte-exact in JJ @ with Git history unchanged and no persistent size override", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository, worktrees } = await fixture();
  await dirtyWithLargeRecord(repository);
  const before = await snapshotBefore(repository);
  const driver = join(worktrees, "feature");
  const driverTip = await exec(driver, "git", "rev-parse", "delivery/feature");

  expect(await flow(desk, "project", "migrate-vcs", "demo", "--to", "jj", DIRTY, RETAIN, spec())).toContain("migrated git -> jj");
  expect(await projectVcsIsJj(desk)).toBe(true);

  // Hash-preservation assertion: disk bytes, JJ @ blob bytes and the authorization all agree.
  const head = await jjHead(repository);
  const retained = await exec(repository, "git", "ls-tree", "-l", head, LARGE_PATH);
  expect(retained).toStartWith("100644 blob");
  expect(retained).toContain(String(LARGE_BYTES));
  const catted = await Bun.spawn(["git", "cat-file", "blob", `${head}:${LARGE_PATH}`], { cwd: repository, stdout: "pipe" });
  expect(sha256(new Uint8Array(await new Response(catted.stdout).arrayBuffer()))).toBe(sha256(LARGE));
  expect(sha256(await readFile(join(repository, LARGE_PATH)))).toBe(sha256(LARGE));

  // On-disk bytes, modes, sizes and mtimes of every file (including the record) are untouched.
  expect(await tree(repository)).toEqual(before.tree);
  // Git history is untouched: same HEAD ref, main tip, commit count, refs, reflog, no stash.
  expect(await gitHistory(repository)).toEqual(before.git);
  // The record sits in @ directly above the unchanged main tip alongside the other dirty paths.
  expect(await exec(repository, "jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id")).toBe(before.git.main);
  expect((await exec(repository, "jj", "diff", "-r", "@", "--name-only")).split("\n").sort())
    .toEqual([LARGE_PATH, "README.md", "small.txt"].sort());
  // The exemption was per-command: no repository or user config keeps a raised snapshot limit.
  expect(await exec(repository, "jj", "config", "list", "--repo")).not.toContain("max-new-file-size");
  expect(await exec(repository, "jj", "log", "-r", "@", "--no-graph", "-T", "commit_id")).toBe(head); // later jj commands do not re-snapshot differently
  // Secondary workspace conversion is unchanged by the flags.
  expect(await exec(driver, "jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id")).toBe(driverTip);
});

test("authorizing the newest record never admits an older over-limit file", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository } = await fixture();
  await dirtyWithLargeRecord(repository, { older: true });
  const before = await snapshotBefore(repository);

  const error = await failFlow(desk, "project", "migrate-vcs", "demo", "--to", "jj", DIRTY, RETAIN, spec());
  expect(error).toContain(OLDER_PATH);
  expect(error).toMatch(/snapshot|retain|size/i);
  expect(error).not.toContain("Use `atdd-flow project migrate-vcs");
  await expectUntouched(desk, repository, before);
});

test("an authorization that does not match the file exactly is refused before JJ metadata exists", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository } = await fixture();
  await dirtyWithLargeRecord(repository);
  const before = await snapshotBefore(repository);
  const migrate = (value: string, ...extra: string[]) =>
    failFlow(desk, "project", "migrate-vcs", "demo", "--to", "jj", DIRTY, RETAIN, value, ...extra);

  expect(await migrate(spec(LARGE_PATH, sha256(Buffer.from("other"))))).toMatch(/sha256/i);
  expect(await migrate(spec(LARGE_PATH, sha256(LARGE), LARGE_BYTES + 1))).toMatch(/bytes|size/i);
  expect(await migrate(spec(LARGE_PATH, sha256(LARGE), LARGE_BYTES, "0600"))).toMatch(/mode/i);
  expect(await migrate(spec(".atdd-flow/runtime-launch/backups/missing.jsonl"))).toMatch(/not a dirty|missing|does not exist/i);
  expect(await migrate(spec("small.txt", sha256(Buffer.from("ordinary dirty\n")), 15))).toMatch(/does not exceed|not over|within the JJ snapshot/i);
  expect(await migrate(spec("../outside.jsonl"))).toMatch(/relative|outside/i);
  expect(await migrate(spec(join(repository, LARGE_PATH)))).toMatch(/relative|outside/i);
  expect(await migrate("not-a-valid-spec")).toMatch(/<path>:<sha256>:<bytes>:<mode>/);
  await expectUntouched(desk, repository, before);
});

test("the flag is repeatable: each authorized file is retained, duplicates and a bare flag are refused", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository } = await fixture();
  await dirtyWithLargeRecord(repository, { older: true });
  const before = await snapshotBefore(repository);
  const olderSpec = spec(OLDER_PATH, sha256(OLDER), OLDER_BYTES);

  const duplicate = await failFlow(desk, "project", "migrate-vcs", "demo", "--to", "jj", DIRTY, RETAIN, spec(), RETAIN, spec());
  expect(duplicate).toMatch(/duplicate|more than once|twice/i);
  const alone = await failFlow(desk, "project", "migrate-vcs", "demo", "--to", "jj", RETAIN, spec());
  expect(alone).toContain(DIRTY);
  await expectUntouched(desk, repository, before);

  const both = await flow(desk, "project", "migrate-vcs", "demo", "--to", "jj", DIRTY, RETAIN, spec(), RETAIN, olderSpec);
  expect(both).toContain("migrated git -> jj");
  expect(await projectVcsIsJj(desk)).toBe(true);
  const head = await jjHead(repository);
  for (const [path, bytes, digest] of [[LARGE_PATH, LARGE_BYTES, sha256(LARGE)], [OLDER_PATH, OLDER_BYTES, sha256(OLDER)]] as const) {
    expect(await exec(repository, "git", "ls-tree", "-l", head, path)).toContain(String(bytes));
    const catted = Bun.spawn(["git", "cat-file", "blob", `${head}:${path}`], { cwd: repository, stdout: "pipe" });
    expect(sha256(new Uint8Array(await new Response(catted.stdout).arrayBuffer()))).toBe(digest);
  }
  expect(await tree(repository)).toEqual(before.tree);
  expect(await gitHistory(repository)).toEqual(before.git);
});

test("the authorization never admits a dirty secondary worktree", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository, worktrees } = await fixture();
  await dirtyWithLargeRecord(repository);
  await writeFile(join(worktrees, "feature", "dirty.txt"), "uncommitted\n");
  const before = await snapshotBefore(repository);

  const error = await failFlow(desk, "project", "migrate-vcs", "demo", "--to", "jj", DIRTY, RETAIN, spec());
  expect(error).toContain("worktree is dirty");
  expect(error).toContain(join(worktrees, "feature").replace(/^\/private/, ""));
  await expectUntouched(desk, repository, before);
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

test("failure after JJ initialization with the large record restores index bytes, working tree, refs and Git state", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository } = await fixture();
  await dirtyWithLargeRecord(repository);
  const before = await snapshotBefore(repository);

  const result = await run(desk, { ...isolatedEnv, PATH: await failingWorkspaceAddPath(join(repository, "..")) }, process.execPath,
    [cli, "project", "migrate-vcs", "demo", "--to", "jj", DIRTY, RETAIN, spec()]);
  expect(result.code).not.toBe(0);
  const text = `${result.stdout}${result.stderr}`;
  expect(text).toContain("JJ migration failed before project.vcs changed");
  expect(text).toContain("injected workspace add failure");
  expect(text).not.toContain("rollback was incomplete");

  await expectUntouched(desk, repository, before);
  expect(await exec(repository, "git", "for-each-ref", "refs/jj/")).toBe("");
});
