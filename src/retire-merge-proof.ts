// URN: component:flow:terminal-seat-retirement:retire-merge-proof:backend:integration
// Tested-By:
// - test:atdd-flow:terminal-seat-retire-merge-proof
// Runtime: bun
// Purpose: Independent merge proof for retiring a driver that worktree finish refuses.

import { type Seat, runOutput } from "./core";
import { type VcsMode, isAncestor } from "./vcs";

type PullRequest = { state?: string; headRefOid?: string; mergeCommit?: { oid?: string } | null };

/** A clean worktree is required; only generated hook files may be untracked, as `worktree finish` allows. */
async function worktreeIsClean(worktree: string) {
  const status = await runOutput(["git", "-C", worktree, "status", "--porcelain"]);
  return status.split("\n").filter(Boolean).every((line) => line.endsWith(" .githooks/") || line.endsWith(" .githooks"));
}

/** No uncommitted work, and the worktree is on the exact branch tip being proven merged. */
async function worktreeIsAtTip(worktree: string, tip: string) {
  return await worktreeIsClean(worktree) && await runOutput(["git", "-C", worktree, "rev-parse", "HEAD"]) === tip;
}

/** Merged PRs for the branch, from GitHub; an unavailable or malformed answer is no evidence. */
async function mergedPullRequests(repository: string, branch: string): Promise<PullRequest[]> {
  try {
    const listed = JSON.parse(await runOutput(["gh", "pr", "list", "--head", branch, "--state", "merged", "--limit", "20", "--json", "state,headRefOid,mergeCommit"], repository));
    return Array.isArray(listed) ? listed : [];
  } catch { return []; }
}

/** A merged PR whose head is exactly the branch tip and whose merge (or squash) commit is on the primary branch. */
async function squashMergeProof(repository: string, branch: string, tip: string, primary: string) {
  for (const pull of await mergedPullRequests(repository, branch)) {
    const merge = pull.mergeCommit?.oid;
    if (pull.state === "MERGED" && pull.headRefOid === tip && merge && await isAncestor(repository, merge, primary)) return merge;
  }
  return undefined;
}

/**
 * A colocated JJ workspace has no `refs/heads/<branch>` once its bookmark is forgotten or deleted, and Git's HEAD is the parent of the
 * working-copy commit. The delivered head is therefore `@-` and the working copy must be a clean, empty, conflict-free child of it; JJ
 * snapshots untracked and edited files into `@`, so any of them make it non-empty. A surviving bookmark must name that head (or the empty
 * `@` itself); a bookmark anywhere else is unmerged work and fails closed.
 */
async function jjDeliveredHead(repository: string, owner: Seat) {
  const at = (revision: string, template: string) => runOutput(["jj", "log", "-r", revision, "--no-graph", "-T", template], owner.worktree);
  await runOutput(["jj", "status"], owner.worktree);
  if (await at("@", 'if(empty, "empty", "changed")') !== "empty" || await at("@ & conflicts()", "commit_id")) return undefined;
  const tip = await at("@-", "commit_id");
  if (!/^[0-9a-f]{40}$/.test(tip)) return undefined;
  const bookmarked = await runOutput(["jj", "log", "-r", `bookmarks(exact:${JSON.stringify(owner.branch)})`, "--no-graph", "-T", 'commit_id ++ "\n"'], repository).catch(() => "");
  const heads = bookmarked.split("\n").filter(Boolean);
  const current = await at("@", "commit_id");
  return heads.every((head) => head === tip || head === current) ? tip : undefined;
}

/** Proves a JJ driver has no unmerged work: its delivered head is on main, or is the head of a merged PR whose merge commit is on main. */
async function jjTerminalMergeProof(repository: string, owner: Seat) {
  const tip = await jjDeliveredHead(repository, owner);
  if (!tip) return undefined;
  const primary = "main";
  const main = await runOutput(["jj", "log", "-r", primary, "--no-graph", "-T", "commit_id"], repository);
  if (!/^[0-9a-f]{40}$/.test(main)) return undefined;
  if (await isAncestor(repository, tip, main)) return `delivered head ${tip} is reachable from ${primary}`;
  const merge = await squashMergeProof(repository, owner.branch, tip, main);
  return merge ? `delivered head ${tip} is the head of a merged PR whose merge commit ${merge} is on ${primary}` : undefined;
}

/**
 * Proves a retiring driver has no unmerged work without `worktree finish`: the worktree is clean and at the branch tip, and that tip
 * is reachable from the primary branch or is the head of a merged PR whose merge commit is on it. Returns the evidence, or undefined.
 * A JJ driver is proved through its delivered head (`@-`) and a clean empty working copy, with zero or one bookmark.
 * Nothing is removed or deleted: the caller retains the worktree and branch.
 */
export async function terminalMergeProof(repository: string, owner: Seat, mode: VcsMode = "git"): Promise<string | undefined> {
  try {
    if (mode === "jj") return await jjTerminalMergeProof(repository, owner);
    const primary = await runOutput(["git", "-C", repository, "branch", "--show-current"]);
    const tip = await runOutput(["git", "-C", repository, "rev-parse", "--verify", `refs/heads/${owner.branch}`]);
    if (!primary || !await worktreeIsAtTip(owner.worktree, tip)) return undefined;
    if (await isAncestor(repository, tip, primary)) return `branch tip ${tip} is reachable from ${primary}`;
    const merge = await squashMergeProof(repository, owner.branch, tip, primary);
    return merge ? `branch tip ${tip} is the head of a merged PR whose merge commit ${merge} is on ${primary}` : undefined;
  } catch { return undefined; }
}
