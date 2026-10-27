// URN: component:flow:jj-vcs-migration:vcs-migration:backend:application
// Tested-By:
// - test:flow:jj-vcs-migration:E013-UNIT-001
// - test:flow:jj-vcs-migration:E014-UNIT-001
// - test:flow:jj-vcs-migration:E017-UNIT-001
// Runtime: bun
// Purpose: Migrate one legacy Flow Git project to colocated JJ without losing lineage.
//
// Migration is deliberately narrower than project configuration. Configuration
// selects a VCS before seats exist; migration converts an already-live topology.
// The project remains Git-authoritative until every recreated workspace verifies.
//
// The conversion never rewrites historical task or review records. Secondary
// branches gain the same clean JJ working-copy anchor used by greenfield seats,
// leaving their legacy Git tip as the unchanged parent and preserving ancestry.
//
// Preflight is intentionally strict because conversion briefly replaces clean
// linked Git worktrees at their existing paths. Any dirty, detached, unmanaged,
// review-state, or ambiguous topology is rejected before JJ metadata is created.
//
// Rollback uses the captured branch, commit, and path tuple rather than inferring
// state from a partial JJ conversion. The durable project VCS is written last.

import { lstat, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  type Project, type Seat, atomicYaml, exists, paths, project, readYaml, required, yaml,
} from "./core";
import { assertBranchReady, assertRepository, branchCommit, vcsMode, workspaceName } from "./vcs";

type CommandResult = { code: number; out: string; err: string };
type SeatState = { address: string; branch: string; worktree: string; commit: string; primary: boolean };
type GitWorktree = { path: string; branch?: string };
type TaskLite = { assignee?: string; status?: string; governed_base?: { commit?: string } };
type ReviewsLite = { attempts?: Array<{ delivery_head?: string }> };

/** JJ silently skips new files above this size (snapshot.max-new-file-size default). */
const SNAPSHOT_MAX_NEW_FILE_BYTES = 1048576;
const DIRTY_PRIMARY_FLAG = "--allow-dirty-primary";
const RETAIN_LARGE_FLAG = "--retain-large-primary-file";
const USAGE = `Use \`atdd-flow project migrate-vcs <project> --to jj [--allow-dirty-primary [${RETAIN_LARGE_FLAG} <path>:<sha256>:<bytes>:<mode> ...]] [--dry-run]\`.`;

/** One operator-authorized over-limit primary file, matched against disk exactly. */
type LargeFile = { path: string; sha256: string; bytes: number; mode: string };

type DiskState =
  | { kind: "absent" }
  | { kind: "file"; sha256: string; exec: boolean }
  | { kind: "symlink"; target: string };
type DirtyEntry = { path: string; status: string; disk: DiskState; retained?: LargeFile };

export type VcsMigrationPlan = {
  schema: "atdd-flow/vcs-migration-plan/v1";
  project: string;
  from: "git";
  to: "jj";
  primary: SeatState;
  workspaces: SeatState[];
  lineage: { tasks_checked: number; reviews_checked: number };
  dirty_primary?: { entries: Array<{ path: string; status: string }> };
  large_primary?: LargeFile[];
};

type PreparedMigration = {
  config: Project;
  repository: string;
  states: SeatState[];
  plan: VcsMigrationPlan;
  dirty: DirtyEntry[];
  index: Buffer | null;
};

/** Parse `<path>:<sha256>:<bytes>:<mode>` from the right so the path alone may contain colons. */
function parseLargeFile(spec: string): LargeFile {
  const match = spec.match(/^(.+):([0-9a-f]{64}):(\d+):([0-7]{4})$/);
  if (!match) throw new Error(`${RETAIN_LARGE_FLAG} expects <path>:<sha256>:<bytes>:<mode> (lowercase 64-hex sha256, decimal bytes, four-digit octal mode); got ${spec}.`);
  const [, path, sha256, bytes, mode] = match as unknown as [string, string, string, string, string];
  if (isAbsolute(path) || path.split("/").includes("..") || normalize(path) !== path || path.endsWith("/")) {
    throw new Error(`${RETAIN_LARGE_FLAG} path must be a normalized repository-relative path with no '..' (outside the primary checkout is refused): ${path}`);
  }
  return { path, sha256, bytes: Number(bytes), mode };
}

/** Every authorization must name a path that is actually dirty in the primary checkout. */
function assertAuthorizationsDirty(authorized: LargeFile[], dirty: DirtyEntry[]) {
  for (const auth of authorized) {
    if (!dirty.some(entry => entry.path === auth.path)) throw new Error(`Authorized large file ${auth.path} is not a dirty primary path (it does not exist or is unchanged).`);
  }
}

/** Compare one over-limit new file with its authorization; every field must match exactly. */
function assertAuthorizedLarge(auth: LargeFile, size: number, mode: string, sha256: string) {
  if (size !== auth.bytes) throw new Error(`Authorized large file ${auth.path} is ${size} bytes on disk, not the authorized ${auth.bytes} bytes.`);
  if (sha256 !== auth.sha256) throw new Error(`Authorized large file ${auth.path} sha256 ${sha256} does not match the authorized sha256 ${auth.sha256}.`);
  if (mode !== auth.mode) throw new Error(`Authorized large file ${auth.path} has mode ${mode} on disk, not the authorized mode ${auth.mode}.`);
}

/** Run one external VCS command without throwing so rollback can inspect failures. */
async function command(cwd: string, executable: string, args: string[]): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

/** Require successful command output for all forward migration operations. */
async function output(cwd: string, executable: string, args: string[]) {
  const result = await command(cwd, executable, args);
  if (result.code !== 0) throw new Error(`${executable} ${args.join(" ")} failed: ${result.err || result.out}`);
  return result.out;
}

/** Parse only the conventional semantic version tuple advertised by Git and JJ. */
function versionTuple(text: string) {
  const match = text.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) throw new Error(`Unable to parse version from: ${text}`);
  return match.slice(1).map(Number) as [number, number, number];
}

/** Compare tool versions without adding a semver dependency to Flow. */
function atLeast(actual: [number, number, number], expected: [number, number, number]) {
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]! !== expected[index]!) return actual[index]! > expected[index]!;
  }
  return true;
}

/** JJ colocated child workspaces require JJ 0.46 and its Git 2.42 floor. */
async function assertToolVersions(repository: string) {
  const jj = versionTuple(await output(repository, "jj", ["version"]));
  if (!atLeast(jj, [0, 46, 0])) throw new Error(`Jujutsu 0.46.0 or newer is required; found ${jj.join(".")}.`);
  const git = versionTuple(await output(repository, "git", ["--version"]));
  if (!atLeast(git, [2, 42, 0])) throw new Error(`Git 2.42.0 or newer is required for colocated JJ workspaces; found ${git.join(".")}.`);
}

/** Retired seats own no live workspace and therefore are not migration inputs. */
async function activeSeats(root: string, name: string) {
  const directory = paths(root).seats(name);
  const entries = await readdir(directory, { withFileTypes: true });
  const records = await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry =>
    readYaml<Seat>(join(directory, entry.name, "seat.yaml"))));
  return records.filter(record => !record.retired);
}

/** Read one working-copy path exactly as JJ will snapshot it, without following symlinks. */
async function diskState(worktree: string, path: string): Promise<DiskState> {
  const full = join(worktree, path);
  const info = await lstat(full).catch(() => null);
  if (!info) return { kind: "absent" };
  if (info.isSymbolicLink()) return { kind: "symlink", target: await readlink(full) };
  if (info.isDirectory()) throw new Error(`Dirty primary path ${path} is a nested repository or gitlink; JJ cannot retain it.`);
  const sha256 = createHash("sha256").update(await readFile(full)).digest("hex");
  return { kind: "file", sha256, exec: (info.mode & 0o111) !== 0 };
}

/** Classify one dirty path: retained exactly, plain, or an unauthorized over-limit refusal. */
async function classifyDirty(worktree: string, flags: string, path: string, authorized: LargeFile[]) {
  const disk = await diskState(worktree, path);
  const auth = authorized.find(item => item.path === path);
  const info = disk.kind === "file" ? await lstat(join(worktree, path)) : null;
  const isNew = flags.includes("?") || flags.includes("A");
  const overLimit = isNew && info !== null && info.size > SNAPSHOT_MAX_NEW_FILE_BYTES;
  const entry: DirtyEntry = { path, status: flags, disk };
  if (auth) {
    if (!overLimit || disk.kind !== "file" || !info) {
      throw new Error(`Authorized file ${path} does not exceed the JJ snapshot size limit of ${SNAPSHOT_MAX_NEW_FILE_BYTES} bytes as a new regular file; the authorization is refused.`);
    }
    assertAuthorizedLarge(auth, info.size, (info.mode & 0o777).toString(8).padStart(4, "0"), disk.sha256);
    entry.retained = auth;
  }
  const refusal = overLimit && !auth
    ? `Dirty primary file ${path} (${info!.size} bytes) exceeds the JJ snapshot size limit of ${SNAPSHOT_MAX_NEW_FILE_BYTES} bytes and would not be retained; commit it, move it, ignore it, or authorize it exactly with ${RETAIN_LARGE_FLAG}.`
    : undefined;
  return { entry, refusal };
}

/** Capture the primary's uncommitted paths read-only, refusing anything JJ would drop. */
async function captureDirtyPrimary(worktree: string, authorized: LargeFile[]): Promise<DirtyEntry[]> {
  // Raw, untrimmed: the first record's leading status space is significant.
  const status = await Bun.spawn(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
  const [raw, failure, code] = await Promise.all([new Response(status.stdout).text(), new Response(status.stderr).text(), status.exited]);
  if (code !== 0) throw new Error(`git status failed: ${failure.trim()}`);
  const entries: DirtyEntry[] = [];
  const refused: string[] = [];
  for (const record of raw.split("\0").filter(Boolean)) {
    const { entry, refusal } = await classifyDirty(worktree, record.slice(0, 2), record.slice(3), authorized);
    entries.push(entry);
    if (refusal) refused.push(refusal);
  }
  // Report a stale authorization before an unauthorized file so the operator fixes the spec first.
  assertAuthorizationsDirty(authorized, entries);
  if (refused.length) throw new Error(refused[0]!);
  return entries;
}

/** Capture the exact clean Git tuple that migration must preserve or parent. */
async function inspectSeat(repository: string, record: Seat, allowDirtyPrimary: boolean, authorized: LargeFile[]): Promise<{ state: SeatState; dirty: DirtyEntry[] }> {
  const worktree = await realpath(resolve(record.worktree)).catch(() => null);
  if (!worktree) throw new Error(`Seat ${record.address} worktree does not exist: ${record.worktree}`);
  const top = await realpath(await output(worktree, "git", ["rev-parse", "--show-toplevel"]));
  if (top !== worktree) throw new Error(`Seat ${record.address} is not at a Git worktree root: ${worktree}`);
  const primary = worktree === repository;
  let dirty: DirtyEntry[] = [];
  if (await output(worktree, "git", ["status", "--porcelain"])) {
    if (!primary) throw new Error(`Seat ${record.address} worktree is dirty: ${worktree}`);
    if (!allowDirtyPrimary) throw new Error(`Seat ${record.address} worktree is dirty: ${worktree}. Pass ${DIRTY_PRIMARY_FLAG} to retain the primary checkout's uncommitted changes as JJ working-copy state.`);
    dirty = await captureDirtyPrimary(worktree, authorized);
  }
  const branch = await output(worktree, "git", ["branch", "--show-current"]);
  if (branch !== record.branch) throw new Error(`Seat ${record.address} is checked out at ${branch || "detached HEAD"}, not ${record.branch}.`);
  const commit = await output(worktree, "git", ["rev-parse", "HEAD"]);
  const ref = await output(repository, "git", ["rev-parse", "--verify", `refs/heads/${record.branch}^{commit}`]);
  if (commit !== ref) throw new Error(`Seat ${record.address} HEAD does not match branch ${record.branch}.`);
  return { state: { address: record.address, branch: record.branch, worktree, commit, primary }, dirty };
}

/** Parse Git's porcelain registry rather than trusting directory existence alone. */
function parseWorktrees(text: string): GitWorktree[] {
  return text.split(/\n\s*\n/).filter(Boolean).map(block => {
    const lines = block.split("\n");
    const path = lines.find(line => line.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find(line => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
    if (!path) throw new Error("Git worktree registry contains an entry without a path.");
    return { path: resolve(path), ...(branch ? { branch } : {}) };
  });
}

/** Refuse unmanaged Git worktrees so conversion cannot strand operator state. */
async function assertWorktreeRegistry(repository: string, states: SeatState[]) {
  const listed = parseWorktrees(await output(repository, "git", ["worktree", "list", "--porcelain"]));
  const expected = new Map(states.map(state => [state.worktree, state]));
  if (listed.length !== expected.size) throw new Error("Git worktree registry contains worktrees not owned by active Flow seats.");
  for (const item of listed) {
    const state = expected.get(await realpath(item.path).catch(() => item.path));
    if (!state) throw new Error(`Git worktree ${item.path} is not owned by an active Flow seat.`);
    if (item.branch !== state.branch) throw new Error(`Git worktree ${item.path} is registered at ${item.branch ?? "detached HEAD"}, not ${state.branch}.`);
  }
}

/** Sanitized JJ workspace names must stay one-to-one with Flow branches. */
function assertWorkspaceNames(states: SeatState[]) {
  const names = new Set<string>();
  for (const state of states.filter(entry => !entry.primary)) {
    const name = workspaceName(state.branch);
    if (!name) throw new Error(`Branch ${state.branch} cannot form a JJ workspace name.`);
    if (names.has(name)) throw new Error(`Multiple branches map to JJ workspace name ${name}.`);
    names.add(name);
  }
}

/** Historical lineage is valid only while every referenced Git commit resolves. */
async function commitExists(repository: string, commit: string) {
  return (await command(repository, "git", ["cat-file", "-e", `${commit}^{commit}`])).code === 0;
}

/** Validate task bases before any branch acquires a JJ working-copy anchor. */
async function assertTaskLineage(directory: string, repository: string, states: SeatState[], files: string[]) {
  const byAddress = new Map(states.map(state => [state.address, state]));
  let checked = 0;
  for (const file of files.filter(file => file.endsWith(".yaml") && !file.endsWith(".reviews.yaml"))) {
    const task = await readYaml<TaskLite>(join(directory, file));
    if (task.status === "review") throw new Error(`Task ${file} is in review; complete or return it before VCS migration.`);
    const base = task.governed_base?.commit;
    if (!base) continue;
    checked += 1;
    if (!await commitExists(repository, base)) throw new Error(`Task ${file} governed base ${base} is unavailable.`);
    const owner = task.assignee ? byAddress.get(task.assignee) : undefined;
    if (owner && (await command(repository, "git", ["merge-base", "--is-ancestor", base, owner.commit])).code !== 0) {
      throw new Error(`Task ${file} governed base is not an ancestor of ${owner.address}.`);
    }
  }
  return checked;
}

/** Review heads remain historical evidence; only their referenced commits must survive. */
async function assertReviewLineage(directory: string, repository: string, files: string[]) {
  let checked = 0;
  for (const file of files.filter(file => file.endsWith(".reviews.yaml"))) {
    const history = await readYaml<ReviewsLite>(join(directory, file));
    for (const attempt of history.attempts ?? []) {
      if (!attempt.delivery_head) continue;
      checked += 1;
      if (!await commitExists(repository, attempt.delivery_head)) throw new Error(`Review ${file} delivery head ${attempt.delivery_head} is unavailable.`);
    }
  }
  return checked;
}

/** Read lineage once so dry-run and execution share the identical preflight proof. */
async function assertLineage(root: string, name: string, repository: string, states: SeatState[]) {
  const directory = paths(root).tasks(name);
  if (!await exists(directory)) return { tasks_checked: 0, reviews_checked: 0 };
  const files = await readdir(directory);
  const tasks_checked = await assertTaskLineage(directory, repository, states, files);
  const reviews_checked = await assertReviewLineage(directory, repository, files);
  return { tasks_checked, reviews_checked };
}

/** Build the complete deterministic migration plan before creating .jj metadata. */
async function prepare(root: string, name: string, allowDirtyPrimary: boolean, authorized: LargeFile[]): Promise<PreparedMigration> {
  const config = await project(root, name);
  if (vcsMode(config) !== "git") throw new Error(`Project ${name} is not a Git project.`);
  const repository = await realpath(resolve(required(config.repository, `project ${name} repository`))).catch(() => null);
  if (!repository) throw new Error(`Project ${name} repository does not exist.`);
  await assertRepository("git", repository);
  if (await exists(join(repository, ".jj"))) throw new Error(`Project ${name} already has Jujutsu metadata; refusing implicit adoption.`);
  await assertToolVersions(repository);
  const records = await activeSeats(root, name);
  if (!records.length) throw new Error("Project has no active seats; configure vcs: jj directly before creating seats.");
  const inspected = await Promise.all(records.map(record => inspectSeat(repository, record, allowDirtyPrimary, authorized)));
  const states = inspected.map(entry => entry.state);
  const dirty = inspected.flatMap(entry => entry.dirty);
  assertAuthorizationsDirty(authorized, dirty);
  const primary = states.filter(state => state.primary);
  if (primary.length !== 1) throw new Error(`Migration requires exactly one active seat in the primary checkout; found ${primary.length}.`);
  if (new Set(states.map(state => state.worktree)).size !== states.length) throw new Error("Active Flow seats must have distinct worktree paths before migration.");
  assertWorkspaceNames(states);
  await assertWorktreeRegistry(repository, states);
  const lineage = await assertLineage(root, name, repository, states);
  const workspaces = states.filter(state => !state.primary);
  const index = await readIndex(repository);
  const plan: VcsMigrationPlan = { schema: "atdd-flow/vcs-migration-plan/v1", project: name, from: "git", to: "jj", primary: primary[0]!, workspaces, lineage };
  if (dirty.length) plan.dirty_primary = { entries: dirty.map(({ path, status }) => ({ path, status })) };
  const large = dirty.flatMap(entry => entry.retained ? [entry.retained] : []);
  if (large.length) plan.large_primary = large;
  return { config, repository, states, plan, dirty, index };
}

/** The primary bookmark is intentionally not advanced during migration. */
async function verifyPrimary(state: SeatState, dirty: DirtyEntry[]) {
  if (dirty.length) return verifyDirtyPrimary(state, dirty);
  const ready = await assertBranchReady("jj", state.worktree, state.branch);
  if (ready !== state.commit) throw new Error(`Primary bookmark ${state.branch} changed during JJ migration.`);
}

/** Read the Git tree entry for one path in the JJ working-copy commit. */
async function treeEntry(state: SeatState, head: string, path: string) {
  const listed = await output(state.worktree, "git", ["ls-tree", head, "--", path]);
  if (!listed) return null;
  const [meta] = listed.split("\t");
  const [mode, , blob] = (meta ?? "").split(" ");
  return { mode: mode!, blob: blob! };
}

/** True when the tree entry is exactly the captured disk state (content and mode). */
async function entryMatches(state: SeatState, entry: DirtyEntry, found: { mode: string; blob: string }) {
  const disk = entry.disk;
  if (disk.kind === "symlink") {
    return found.mode === "120000" && await output(state.worktree, "git", ["cat-file", "blob", found.blob]) === disk.target;
  }
  if (disk.kind !== "file") return false;
  const hashed = await output(state.worktree, "git", ["hash-object", "--no-filters", "--", entry.path]);
  return found.mode === (disk.exec ? "100755" : "100644") && found.blob === hashed;
}

/** Compare one retained path in the JJ working-copy commit against the captured disk state. */
async function verifyDirtyPath(state: SeatState, head: string, entry: DirtyEntry) {
  const now = await diskState(state.worktree, entry.path);
  if (JSON.stringify(now) !== JSON.stringify(entry.disk)) throw new Error(`Primary path ${entry.path} changed on disk during JJ migration.`);
  const found = await treeEntry(state, head, entry.path);
  const retained = entry.disk.kind === "absent" ? found === null : found !== null && await entryMatches(state, entry, found);
  if (!retained) throw new Error(`Primary path ${entry.path} was not retained exactly in the JJ working copy.`);
  if (entry.retained) await verifyLargeBlob(state, head, entry.retained);
}

/** Hash-preservation: the bytes stored in the JJ working-copy commit equal the authorization. */
async function verifyLargeBlob(state: SeatState, head: string, auth: LargeFile) {
  const child = Bun.spawn(["git", "cat-file", "blob", `${head}:${auth.path}`], { cwd: state.worktree, stdout: "pipe", stderr: "pipe" });
  const [bytes, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
  const digest = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  if (code !== 0 || bytes.byteLength !== auth.bytes || digest !== auth.sha256) {
    throw new Error(`Authorized large file ${auth.path} in the JJ working copy does not match the authorized sha256 ${auth.sha256} and ${auth.bytes} bytes.`);
  }
}

/** A dirty primary must be exactly `main` plus the captured manifest, nothing more. */
async function verifyDirtyPrimary(state: SeatState, dirty: DirtyEntry[]) {
  const bookmarked = await branchCommit("jj", state.worktree, state.branch);
  const parent = await output(state.worktree, "jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
  if (bookmarked !== state.commit || parent !== state.commit) throw new Error(`Primary bookmark ${state.branch} changed during JJ migration.`);
  const head = await output(state.worktree, "jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
  const changed = (await output(state.worktree, "git", ["diff-tree", "-r", "-z", "--no-renames", "--name-only", state.commit, head])).split("\0").filter(Boolean);
  const expected = new Set(dirty.map(entry => entry.path));
  const extra = changed.filter(path => !expected.has(path));
  if (extra.length) throw new Error(`JJ working copy contains paths outside the captured dirty manifest: ${extra.join(", ")}`);
  for (const entry of dirty) await verifyDirtyPath(state, head, entry);
}

/** Secondary seats may gain one clean child; their legacy tip must be its parent. */
async function migratedHead(state: SeatState) {
  const current = await output(state.worktree, "jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
  const parent = await output(state.worktree, "jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
  const changed = await output(state.worktree, "jj", ["diff", "-r", "@", "--name-only"]);
  if (current !== state.commit && (parent !== state.commit || changed)) {
    throw new Error(`JJ workspace ${state.worktree} does not preserve legacy tip ${state.commit} as its clean parent.`);
  }
  return current;
}

/** Prove JJ bookmark, working copy, and exported Git ref are synchronized. */
async function verifyMigratedWorkspace(state: SeatState) {
  const current = await migratedHead(state);
  const bookmarked = await branchCommit("jj", state.worktree, state.branch);
  if (bookmarked !== current) throw new Error(`Bookmark ${state.branch} is not attached to its JJ working-copy revision.`);
  const exported = await output(state.worktree, "git", ["rev-parse", "--verify", `refs/heads/${state.branch}^{commit}`]);
  if (exported !== current) throw new Error(`Git ref ${state.branch} is not synchronized with its JJ bookmark.`);
}

/** Replace one clean linked Git worktree at the same path with a JJ workspace. */
async function convertWorkspace(repository: string, state: SeatState) {
  await output(repository, "git", ["worktree", "remove", state.worktree]);
  await output(repository, "jj", ["workspace", "add", "--colocate", "--name", workspaceName(state.branch), "-r", state.branch, state.worktree]);
  await output(state.worktree, "jj", ["bookmark", "set", state.branch, "-r", "@"]);
  await verifyMigratedWorkspace(state);
}

/** Remove only workspace state created by this migration attempt. */
async function removePartialWorkspace(repository: string, state: SeatState) {
  await command(repository, "jj", ["workspace", "remove", workspaceName(state.branch)]);
  await command(repository, "git", ["worktree", "remove", "--force", state.worktree]);
}

/** Restore one captured Git branch/worktree tuple after removing JJ metadata. */
async function restoreGitWorkspace(repository: string, state: SeatState) {
  const errors: string[] = [];
  await rm(state.worktree, { recursive: true, force: true }).catch(error => errors.push(String(error)));
  const reset = await command(repository, "git", ["branch", "-f", state.branch, state.commit]);
  if (reset.code) errors.push(reset.err || reset.out);
  const restored = await command(repository, "git", ["worktree", "add", state.worktree, state.branch]);
  if (restored.code) errors.push(restored.err || restored.out);
  return errors;
}

/** Locate the primary's Git index so JJ's colocation rewrite can be undone byte-for-byte. */
async function indexPath(repository: string) {
  return resolve(repository, await output(repository, "git", ["rev-parse", "--git-path", "index"]));
}

async function readIndex(repository: string): Promise<Buffer | null> {
  return readFile(await indexPath(repository)).catch(() => null);
}

/** Restore (or remove) the captured index atomically. */
async function restoreIndex(repository: string, index: Buffer | null) {
  const path = await indexPath(repository);
  if (index === null) return rm(path, { force: true });
  const temp = `${path}.migrate-restore`;
  await writeFile(temp, index);
  await rename(temp, path);
}

/** JJ records kept commits under refs/jj; they exist only because this attempt initialized JJ. */
async function removeJjRefs(repository: string) {
  const refs = (await output(repository, "git", ["for-each-ref", "--format=%(refname)", "refs/jj/"])).split("\n").filter(Boolean);
  for (const ref of refs) await output(repository, "git", ["update-ref", "-d", ref]);
}

/** Best-effort rollback never changes project.vcs and reports every incomplete restore. */
async function rollback(repository: string, primary: SeatState, displaced: SeatState[], index: Buffer | null) {
  const errors: string[] = [];
  for (const state of [...displaced].reverse()) await removePartialWorkspace(repository, state);
  await rm(join(repository, ".jj"), { recursive: true, force: true }).catch(error => errors.push(String(error)));
  await removeJjRefs(repository).catch(error => errors.push(String(error)));
  // Skip the switch when HEAD already names the branch so rollback adds no HEAD reflog entry.
  const onBranch = await command(repository, "git", ["symbolic-ref", "-q", "HEAD"]);
  if (onBranch.out !== `refs/heads/${primary.branch}`) {
    const switched = await command(repository, "git", ["switch", primary.branch]);
    if (switched.code) errors.push(switched.err || switched.out);
  }
  for (const state of displaced) errors.push(...await restoreGitWorkspace(repository, state));
  await restoreIndex(repository, index).catch(error => errors.push(String(error)));
  return errors;
}

/** Require exactly one `--to jj` pair and return the remaining arguments. */
function withoutTarget(args: string[]) {
  const toIndex = args.indexOf("--to");
  const valid = toIndex >= 0 && args[toIndex + 1] === "jj" && args.filter(arg => arg === "--to").length === 1;
  if (!valid) throw new Error(USAGE);
  return args.filter((_arg, index) => index !== toIndex && index !== toIndex + 1);
}

/** Parse the value after one `--retain-large-primary-file`, refusing duplicates. */
function parseRetainValue(value: string | undefined, authorized: LargeFile[]) {
  if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
  const file = parseLargeFile(value);
  if (authorized.some(item => item.path === file.path)) throw new Error(`${RETAIN_LARGE_FLAG} names ${file.path} more than once (duplicate authorization).`);
  return file;
}

/** Accept exactly `--to jj`, at most one each of the known flags, and any number of distinct file authorizations. */
function parseMigrationArgs(args: string[]) {
  const rest = withoutTarget(args);
  const flags = new Set<string>();
  const authorized: LargeFile[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === RETAIN_LARGE_FLAG) {
      authorized.push(parseRetainValue(rest[index + 1], authorized));
      index += 1;
    } else if (["--dry-run", DIRTY_PRIMARY_FLAG].includes(arg) && !flags.has(arg)) flags.add(arg);
    else throw new Error(USAGE);
  }
  if (authorized.length && !flags.has(DIRTY_PRIMARY_FLAG)) throw new Error(`${RETAIN_LARGE_FLAG} requires ${DIRTY_PRIMARY_FLAG}.`);
  return { dryRun: flags.has("--dry-run"), allowDirtyPrimary: flags.has(DIRTY_PRIMARY_FLAG), authorized };
}

/** Execute the only supported legacy conversion: Git project to colocated JJ. */
export async function migrateProjectVcs(root: string, name: string, args: string[]) {
  const { dryRun, allowDirtyPrimary, authorized } = parseMigrationArgs(args);
  const prepared = await prepare(root, name, allowDirtyPrimary, authorized);
  if (dryRun) { process.stdout.write(yaml.print(prepared.plan)); return; }

  const displaced: SeatState[] = [];
  try {
    // The raised snapshot limit is scoped to this one command and equals the largest authorized file;
    // preflight proved every over-limit new file is authorized and verification rejects any extra path.
    const limit = Math.max(0, ...(prepared.plan.large_primary ?? []).map(file => file.bytes));
    const config = limit > SNAPSHOT_MAX_NEW_FILE_BYTES ? [`--config=snapshot.max-new-file-size=${limit}`] : [];
    await output(prepared.repository, "jj", [...config, "git", "init", "--colocate"]);
    await assertRepository("jj", prepared.repository);
    await verifyPrimary(prepared.plan.primary, prepared.dirty);
    for (const state of prepared.plan.workspaces) {
      displaced.push(state);
      await convertWorkspace(prepared.repository, state);
    }
    await verifyPrimary(prepared.plan.primary, prepared.dirty);
    for (const state of prepared.plan.workspaces) await verifyMigratedWorkspace(state);
    await atomicYaml(paths(root).projectFile(name), { ...prepared.config, vcs: "jj" });
    process.stdout.write(`${name}  migrated git -> jj  ${prepared.states.length} seats  lineage preserved\n`);
  } catch (error) {
    const rollbackErrors = await rollback(prepared.repository, prepared.plan.primary, displaced, prepared.index);
    const suffix = rollbackErrors.length ? ` Automatic rollback was incomplete: ${rollbackErrors.join("; ")}` : " Git worktrees were restored.";
    throw new Error(`JJ migration failed before project.vcs changed: ${(error as Error).message}.${suffix}`);
  }
}
