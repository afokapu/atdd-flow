import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Project } from "./core";
import { run, runOutput } from "./core";

export type VcsMode = "git" | "jj";

export function vcsMode(config: Pick<Project, "vcs">): VcsMode {
  return config.vcs ?? "git";
}

export function workspaceName(branch: string) {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function jjVersion(cwd: string) {
  const output = await runOutput(["jj", "version"], cwd);
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) throw new Error(`Unable to parse Jujutsu version from: ${output}`);
  const [, major, minor] = match.map(Number);
  if (major === 0 && minor < 46) throw new Error(`Jujutsu 0.46.0 or newer is required; found ${match[0]}.`);
}

export async function assertRepository(mode: VcsMode, path: string) {
  const expected = await realpath(resolve(path));
  if (mode === "git") {
    const top = await realpath(await runOutput(["git", "-C", expected, "rev-parse", "--show-toplevel"]));
    if (top !== expected) throw new Error(`${expected} is not the top level of a Git repository.`);
    return;
  }
  await jjVersion(expected);
  const top = await realpath(await runOutput(["jj", "root"], expected));
  if (top !== expected) throw new Error(`${expected} is not the top level of a Jujutsu repository.`);
  await runOutput(["jj", "git", "colocation", "status"], expected);
}

export async function snapshot(mode: VcsMode, cwd: string) {
  if (mode === "jj") await runOutput(["jj", "status"], cwd);
}

export async function branchCommit(mode: VcsMode, cwd: string, branch: string) {
  if (mode === "git") return runOutput(["git", "-C", cwd, "rev-parse", branch]);
  await snapshot(mode, cwd);
  return runOutput(["jj", "log", "-r", branch, "--no-graph", "-T", "commit_id"], cwd);
}

export async function currentCommit(mode: VcsMode, cwd: string) {
  if (mode === "git") return runOutput(["git", "-C", cwd, "rev-parse", "HEAD"]);
  await snapshot(mode, cwd);
  return runOutput(["jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"], cwd);
}

export async function branchExists(mode: VcsMode, cwd: string, branch: string) {
  try { await branchCommit(mode, cwd, branch); return true; }
  catch { return false; }
}

export async function commitExists(cwd: string, commit: string) {
  try { await runOutput(["git", "-C", cwd, "cat-file", "-e", `${commit}^{commit}`]); return true; }
  catch { return false; }
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string) {
  try { await run(["git", "-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant], true); return true; }
  catch { return false; }
}

export async function assertBranchReady(mode: VcsMode, cwd: string, branch: string) {
  if (mode === "git") {
    if (await runOutput(["git", "-C", cwd, "status", "--porcelain"])) throw new Error(`Worktree ${cwd} is dirty.`);
    const checkedOut = await runOutput(["git", "-C", cwd, "branch", "--show-current"]);
    if (checkedOut !== branch) throw new Error(`Worktree ${cwd} is not checked out at ${branch}.`);
  } else {
    await snapshot(mode, cwd);
    const conflicts = await runOutput(["jj", "log", "-r", "@ & conflicts()", "--no-graph", "-T", "commit_id"], cwd);
    if (conflicts) throw new Error(`Jujutsu workspace ${cwd} has unresolved conflicts.`);
  }
  const [current, expected] = await Promise.all([currentCommit(mode, cwd), branchCommit(mode, cwd, branch)]);
  if (current !== expected) throw new Error(`Worktree ${cwd} is stale relative to ${branch}.`);
  return current;
}

export async function addWorkspace(mode: VcsMode, repository: string, worktree: string, branch: string, base: string) {
  if (mode === "git") {
    const exists = await branchExists(mode, repository, branch);
    await run(exists
      ? ["git", "-C", repository, "worktree", "add", worktree, branch]
      : ["git", "-C", repository, "worktree", "add", "-b", branch, worktree, base], true);
    return;
  }
  if (await branchExists(mode, repository, branch)) {
    await run(["jj", "workspace", "add", "--colocate", "--name", workspaceName(branch), "-r", branch, worktree], true, repository);
  } else {
    await run(["jj", "workspace", "add", "--colocate", "--name", workspaceName(branch), "-r", base, worktree], true, repository);
    await run(["jj", "bookmark", "set", branch, "-r", "@"], true, worktree);
  }
  await assertBranchReady(mode, worktree, branch);
}

export async function rollbackWorkspace(mode: VcsMode, repository: string, worktree: string, branch: string) {
  if (mode === "git") {
    await run(["git", "-C", repository, "worktree", "remove", "--force", worktree], true).catch(() => undefined);
    await run(["git", "-C", repository, "branch", "-D", branch], true).catch(() => undefined);
    return;
  }
  await run(["jj", "workspace", "remove", workspaceName(branch)], true, repository).catch(() => undefined);
  await run(["jj", "bookmark", "delete", branch], true, repository).catch(() => undefined);
}

export async function changedFiles(mode: VcsMode, worktree: string, base: string) {
  if (mode === "jj") {
    await snapshot(mode, worktree);
    const output = await runOutput(["jj", "diff", "--name-only", "--from", base, "--to", "@"], worktree);
    return output.split("\n").map(entry => entry.trim()).filter(Boolean).slice(0, 200);
  }
  const outputs = await Promise.allSettled([
    runOutput(["git", "diff", "--name-only", `${base}...HEAD`], worktree),
    runOutput(["git", "diff", "--name-only"], worktree),
    runOutput(["git", "diff", "--name-only", "--cached"], worktree),
    runOutput(["git", "ls-files", "--others", "--exclude-standard"], worktree),
  ]);
  return [...new Set(outputs.flatMap(output => output.status === "fulfilled"
    ? output.value.split("\n").map(entry => entry.trim()).filter(Boolean)
    : []
  ))].slice(0, 200);
}

export async function planArtifacts(mode: VcsMode, worktree: string) {
  try {
    const output = mode === "git"
      ? await runOutput(["git", "ls-files", "plan"], worktree)
      : await runOutput(["jj", "file", "list", "plan"], worktree);
    return output.split("\n").map(entry => entry.trim()).filter(entry => entry.endsWith(".yaml")).slice(0, 400);
  } catch {
    return [];
  }
}

export function diffCommand(mode: VcsMode, base: string) {
  return mode === "git" ? `git diff ${base}...HEAD` : `jj diff --from ${base} --to @`;
}
