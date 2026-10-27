// URN: component:flow:jj-vcs-migration:vcs-migration:backend:application
// Tested-By:
// - test:flow:jj-vcs-migration:E012-UNIT-001
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

import { readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type Project, type Seat, atomicYaml, exists, paths, project, readYaml, required, yaml,
} from "./core";
import { assertBranchReady, assertRepository, branchCommit, vcsMode, workspaceName } from "./vcs";

type CommandResult = { code: number; out: string; err: string };
type SeatState = { address: string; branch: string; worktree: string; commit: string; primary: boolean };
type GitWorktree = { path: string; branch?: string };
type TaskLite = { assignee?: string; status?: string; governed_base?: { commit?: string } };
type ReviewsLite = { attempts?: Array<{ delivery_head?: string }> };

export type VcsMigrationPlan = {
  schema: "atdd-flow/vcs-migration-plan/v1";
  project: string;
  from: "git";
  to: "jj";
  primary: SeatState;
  workspaces: SeatState[];
  lineage: { tasks_checked: number; reviews_checked: number };
};

type PreparedMigration = {
  config: Project;
  repository: string;
  states: SeatState[];
  plan: VcsMigrationPlan;
};

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

/** Capture the exact clean Git tuple that migration must preserve or parent. */
async function inspectSeat(repository: string, record: Seat): Promise<SeatState> {
  const worktree = await realpath(resolve(record.worktree)).catch(() => null);
  if (!worktree) throw new Error(`Seat ${record.address} worktree does not exist: ${record.worktree}`);
  const top = await realpath(await output(worktree, "git", ["rev-parse", "--show-toplevel"]));
  if (top !== worktree) throw new Error(`Seat ${record.address} is not at a Git worktree root: ${worktree}`);
  if (await output(worktree, "git", ["status", "--porcelain"])) throw new Error(`Seat ${record.address} worktree is dirty: ${worktree}`);
  const branch = await output(worktree, "git", ["branch", "--show-current"]);
  if (branch !== record.branch) throw new Error(`Seat ${record.address} is checked out at ${branch || "detached HEAD"}, not ${record.branch}.`);
  const commit = await output(worktree, "git", ["rev-parse", "HEAD"]);
  const ref = await output(repository, "git", ["rev-parse", "--verify", `refs/heads/${record.branch}^{commit}`]);
  if (commit !== ref) throw new Error(`Seat ${record.address} HEAD does not match branch ${record.branch}.`);
  return { address: record.address, branch: record.branch, worktree, commit, primary: worktree === repository };
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
async function prepare(root: string, name: string): Promise<PreparedMigration> {
  const config = await project(root, name);
  if (vcsMode(config) !== "git") throw new Error(`Project ${name} is not a Git project.`);
  const repository = await realpath(resolve(required(config.repository, `project ${name} repository`))).catch(() => null);
  if (!repository) throw new Error(`Project ${name} repository does not exist.`);
  await assertRepository("git", repository);
  if (await exists(join(repository, ".jj"))) throw new Error(`Project ${name} already has Jujutsu metadata; refusing implicit adoption.`);
  await assertToolVersions(repository);
  const records = await activeSeats(root, name);
  if (!records.length) throw new Error("Project has no active seats; configure vcs: jj directly before creating seats.");
  const states = await Promise.all(records.map(record => inspectSeat(repository, record)));
  const primary = states.filter(state => state.primary);
  if (primary.length !== 1) throw new Error(`Migration requires exactly one active seat in the primary checkout; found ${primary.length}.`);
  if (new Set(states.map(state => state.worktree)).size !== states.length) throw new Error("Active Flow seats must have distinct worktree paths before migration.");
  assertWorkspaceNames(states);
  await assertWorktreeRegistry(repository, states);
  const lineage = await assertLineage(root, name, repository, states);
  const workspaces = states.filter(state => !state.primary);
  return { config, repository, states, plan: { schema: "atdd-flow/vcs-migration-plan/v1", project: name, from: "git", to: "jj", primary: primary[0]!, workspaces, lineage } };
}

/** The primary bookmark is intentionally not advanced during migration. */
async function verifyPrimary(state: SeatState) {
  const ready = await assertBranchReady("jj", state.worktree, state.branch);
  if (ready !== state.commit) throw new Error(`Primary bookmark ${state.branch} changed during JJ migration.`);
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

/** Best-effort rollback never changes project.vcs and reports every incomplete restore. */
async function rollback(repository: string, primary: SeatState, displaced: SeatState[]) {
  const errors: string[] = [];
  for (const state of [...displaced].reverse()) await removePartialWorkspace(repository, state);
  await rm(join(repository, ".jj"), { recursive: true, force: true }).catch(error => errors.push(String(error)));
  const switched = await command(repository, "git", ["switch", primary.branch]);
  if (switched.code) errors.push(switched.err || switched.out);
  for (const state of displaced) errors.push(...await restoreGitWorkspace(repository, state));
  return errors;
}

/** Execute the only supported legacy conversion: Git project to colocated JJ. */
export async function migrateProjectVcs(root: string, name: string, args: string[]) {
  const toIndex = args.indexOf("--to"), to = toIndex < 0 ? undefined : args[toIndex + 1];
  const dryRun = args.includes("--dry-run");
  const consumed = new Set([toIndex, toIndex + 1, ...(dryRun ? [args.indexOf("--dry-run")] : [])]);
  const valid = toIndex >= 0 && to === "jj"
    && args.filter(arg => arg === "--to").length === 1
    && args.filter(arg => arg === "--dry-run").length <= 1
    && args.every((_arg, index) => consumed.has(index));
  if (!valid) throw new Error("Use `atdd-flow project migrate-vcs <project> --to jj [--dry-run]`.");
  const prepared = await prepare(root, name);
  if (dryRun) { process.stdout.write(yaml.print(prepared.plan)); return; }

  const displaced: SeatState[] = [];
  try {
    await output(prepared.repository, "jj", ["git", "init", "--colocate"]);
    await assertRepository("jj", prepared.repository);
    await verifyPrimary(prepared.plan.primary);
    for (const state of prepared.plan.workspaces) {
      displaced.push(state);
      await convertWorkspace(prepared.repository, state);
    }
    await verifyPrimary(prepared.plan.primary);
    for (const state of prepared.plan.workspaces) await verifyMigratedWorkspace(state);
    await atomicYaml(paths(root).projectFile(name), { ...prepared.config, vcs: "jj" });
    process.stdout.write(`${name}  migrated git -> jj  ${prepared.states.length} seats  lineage preserved\n`);
  } catch (error) {
    const rollbackErrors = await rollback(prepared.repository, prepared.plan.primary, displaced);
    const suffix = rollbackErrors.length ? ` Automatic rollback was incomplete: ${rollbackErrors.join("; ")}` : " Git worktrees were restored.";
    throw new Error(`JJ migration failed before project.vcs changed: ${(error as Error).message}.${suffix}`);
  }
}
