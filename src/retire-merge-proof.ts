// URN: component:flow:terminal-seat-retirement:retire-merge-proof:backend:integration
// Tested-By:
// - test:atdd-flow:terminal-seat-retire-merge-proof
// Runtime: bun
// Purpose: Independent merge proof for retiring a driver that worktree finish refuses.

import { type Seat, runOutput } from "./core";
import { isAncestor } from "./vcs";

type PullRequest = { state?: string; headRefOid?: string; mergeCommit?: { oid?: string } | null };

/** A clean worktree is required; only generated hook files may be untracked, as `worktree finish` allows. */
async function worktreeIsClean(worktree: string) {
  const status = await runOutput(["git", "-C", worktree, "status", "--porcelain"]);
  return status.split("\n").filter(Boolean).every((line) => line.endsWith(" .githooks/") || line.endsWith(" .githooks"));
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
 * Proves a retiring driver has no unmerged work without `worktree finish`: the worktree is clean and at the branch tip, and that tip
 * is reachable from the primary branch or is the head of a merged PR whose merge commit is on it. Returns the evidence, or undefined.
 * Nothing is removed or deleted: the caller retains the worktree and branch.
 */
export async function terminalMergeProof(repository: string, owner: Seat): Promise<string | undefined> {
  try {
    const primary = await runOutput(["git", "-C", repository, "branch", "--show-current"]);
    const tip = await runOutput(["git", "-C", repository, "rev-parse", "--verify", `refs/heads/${owner.branch}`]);
    if (!primary || !await worktreeIsClean(owner.worktree) || await runOutput(["git", "-C", owner.worktree, "rev-parse", "HEAD"]) !== tip) return undefined;
    if (await isAncestor(repository, tip, primary)) return `branch tip ${tip} is reachable from ${primary}`;
    const merge = await squashMergeProof(repository, owner.branch, tip, primary);
    return merge ? `branch tip ${tip} is the head of a merged PR whose merge commit ${merge} is on ${primary}` : undefined;
  } catch { return undefined; }
}
