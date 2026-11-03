// URN: test:atdd-flow:jj-merged-driver-seat-retire
// Acceptance: acc:flow:E029-UNIT-001
// Phase: UNIT
// Purpose: Retiring a terminal JJ driver whose delivery work is proven merged into main is accepted when ATDD Bun's `worktree finish`
// refuses it (squash-merged / deleted-origin bookmark, or zero bookmarks after `jj bookmark forget`). Proof is the recorded delivered head
// being reachable from main, the head of a merged PR whose merge commit is on main, or a clean empty working copy parented by main.
// Dirty, conflicted, and unmerged work, and retirement authorization, stay fail-closed; the worktree and any bookmark are always retained.
import { afterEach, expect, test as bunTest } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
// JJ is not installed in the general ATDD Bun CI job; the dedicated jj-vcs workflow runs this file with JJ present.
const test = (name: string, body: () => unknown | Promise<unknown>) => (Bun.which("jj") ? bunTest : bunTest.skip)(name, body, 120_000);
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ATDD_") && !key.startsWith("HERDR_")));

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function exec(cwd: string, environment: Record<string, string | undefined>, command: string, ...args: string[]) {
  const child = Bun.spawn([command, ...args], { cwd, env: environment as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

async function ok(cwd: string, command: string, ...args: string[]) {
  const result = await exec(cwd, clean, command, ...args);
  expect(result.code, `${command} ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout;
}

const flow = (site: string, ...args: string[]) => ok(site, process.execPath, cli, ...args);

/** Colocated JJ repository, a Desk configured for it, and a finished driver `sq` whose workspace is a real JJ workspace. */
async function jjDriver() {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-jj-retire-"));
  roots.push(root);
  const repository = join(root, "repository"), worktrees = join(root, "worktrees"), site = join(root, "site");
  await mkdir(repository);
  await ok(repository, "git", "init", "--initial-branch=main");
  await ok(repository, "git", "config", "user.email", "fixture@example.test");
  await ok(repository, "git", "config", "user.name", "Fixture");
  await writeFile(join(repository, "README.md"), "initial\n");
  await ok(repository, "git", "add", "README.md");
  await ok(repository, "git", "commit", "-m", "initial");
  await ok(repository, "jj", "git", "init", "--colocate");
  await flow(root, "init", site);
  await flow(site, "project", "init", "demo");
  await flow(site, "project", "configure", "demo", "--vcs", "jj", "--repository", repository, "--worktree-root", worktrees);
  await flow(site, "spawn", "demo", "main", "primary");
  await flow(site, "task", "add", "demo", "W-sq", "--title", "Deliver sq", "--coordinator", "main@demo", "--done-when", "Delivery is merged.");
  await flow(site, "spawn", "demo", "driver", "sq", "--task", "W-sq");
  const worktree = join(worktrees, "sq");
  await flow(site, "task", "start", "demo", "W-sq", "--by", "driver.sq@demo");
  await flow(site, "task", "prove", "demo", "W-sq", "--by", "driver.sq@demo", "--item", "1", "--proof", "main contains the delivery");
  await flow(site, "task", "review", "demo", "W-sq", "--by", "driver.sq@demo");
  await flow(site, "task", "done", "demo", "W-sq", "--by", "main@demo");
  return { root, site, repository, worktree, environment: await fakeGh(root, []) };
}

type Fixture = Awaited<ReturnType<typeof jjDriver>>;

async function fakeGh(root: string, prs: unknown) {
  const bin = join(root, "gh-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "gh"), `#!/bin/sh\nprintf '%s' '${JSON.stringify(prs)}'\n`);
  await chmod(join(bin, "gh"), 0o755);
  return { ...clean, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

const commitId = (cwd: string, revision: string) => ok(cwd, "jj", "log", "-r", revision, "--no-graph", "-T", "commit_id");
const pr = (head: string, merge: string | null, state = "MERGED") => [{ state, headRefOid: head, mergeCommit: merge ? { oid: merge } : null }];

/** The driver commits one deliverable and points its bookmark at the delivered commit, leaving an empty working copy. */
async function deliver(fixture: Fixture) {
  await writeFile(join(fixture.worktree, "delivered.txt"), "delivered\n");
  await ok(fixture.worktree, "jj", "commit", "-m", "deliver");
  await ok(fixture.worktree, "jj", "bookmark", "set", "delivery/sq", "-r", "@-");
  return commitId(fixture.worktree, "@-");
}

/** main contains the delivered head itself (a fast-forward / merge-commit style merge). */
async function mergeReachable(fixture: Fixture) {
  await ok(fixture.repository, "jj", "bookmark", "set", "main", "-r", "delivery/sq");
  return commitId(fixture.repository, "main");
}

/** main contains only a squash commit with the same content. */
async function mergeSquash(fixture: Fixture) {
  await ok(fixture.repository, "jj", "new", "main", "-m", "squash: deliver (#1)");
  await writeFile(join(fixture.repository, "delivered.txt"), "delivered\n");
  await ok(fixture.repository, "jj", "bookmark", "set", "main", "-r", "@");
  const main = await commitId(fixture.repository, "main");
  await ok(fixture.repository, "jj", "new", "main");
  return main;
}

const forget = (fixture: Fixture) => ok(fixture.repository, "jj", "bookmark", "forget", "delivery/sq");
/** Retirement resolves ATDD Bun from the primary checkout; it refuses the way the observed JJ failures do. Installed at retire time because
 * moving the primary's JJ working copy would otherwise snapshot away the untracked stub. */
async function retire(fixture: Fixture, environment: Record<string, string | undefined>, by = "main@demo") {
  const bin = join(fixture.repository, "node_modules", ".bin", "atdd-bun");
  await mkdir(join(fixture.repository, "node_modules", ".bin"), { recursive: true });
  await writeFile(bin, "#!/bin/sh\necho 'atdd-bun: no exported bookmark found 0' >&2\nexit 1\n");
  await chmod(bin, 0o755);
  return exec(fixture.site, environment, process.execPath, cli, "seat", "retire", "driver.sq@demo", "--by", by);
}

async function expectRetired(fixture: Fixture, environment: Record<string, string | undefined>, tip: string, keepsBookmark: boolean) {
  const result = await retire(fixture, environment);
  expect(result.code, result.stderr).toBe(0);
  expect(await flow(fixture.site, "open", "driver.sq@demo")).toContain("retired:");
  await stat(fixture.worktree);
  expect(await commitId(fixture.worktree, "@-")).toBe(tip);
  const bookmarks = await ok(fixture.repository, "jj", "bookmark", "list", "delivery/sq");
  expect(bookmarks.includes("delivery/sq")).toBe(keepsBookmark);
}

async function expectRefused(fixture: Fixture, environment: Record<string, string | undefined>, by = "main@demo", match: RegExp = /./) {
  const result = await retire(fixture, environment, by);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toMatch(match);
  expect(await flow(fixture.site, "open", "driver.sq@demo")).not.toContain("retired:");
  await stat(fixture.worktree);
}

test("RED: squash-merged JJ driver with its bookmark still present is retired on merged-PR evidence; worktree and bookmark are retained", async () => {
  const fixture = await jjDriver();
  const tip = await deliver(fixture);
  const main = await mergeSquash(fixture);
  await expectRetired(fixture, await fakeGh(fixture.root, pr(tip, main)), tip, true);
});

test("RED: squash-merged JJ driver with zero bookmarks after forget is retired on merged-PR evidence", async () => {
  const fixture = await jjDriver();
  const tip = await deliver(fixture);
  const main = await mergeSquash(fixture);
  await forget(fixture);
  await expectRetired(fixture, await fakeGh(fixture.root, pr(tip, main)), tip, false);
});

test("RED: JJ driver with zero bookmarks whose delivered head is reachable from main is retired without any PR evidence", async () => {
  const fixture = await jjDriver();
  const tip = await deliver(fixture);
  await mergeReachable(fixture);
  await forget(fixture);
  await expectRetired(fixture, fixture.environment, tip, false);
});

test("RED: JJ driver that delivered nothing, forgotten bookmark, clean empty working copy parented by main, is retired", async () => {
  const fixture = await jjDriver();
  await forget(fixture);
  const result = await retire(fixture, fixture.environment);
  expect(result.code, result.stderr).toBe(0);
  expect(await flow(fixture.site, "open", "driver.sq@demo")).toContain("retired:");
  await stat(fixture.worktree);
});

test("RED: JJ driver that delivered nothing, bookmark still on the empty working copy, is retired and the bookmark is retained", async () => {
  const fixture = await jjDriver();
  const result = await retire(fixture, fixture.environment);
  expect(result.code, result.stderr).toBe(0);
  expect(await ok(fixture.repository, "jj", "bookmark", "list", "delivery/sq")).toContain("delivery/sq");
});

test("guard: unmerged commits, missing or mismatched PR evidence, and a dirty JJ workspace stay refused", async () => {
  const unmerged = await jjDriver();
  const tip = await deliver(unmerged);
  await forget(unmerged);
  // Delivered commit is not in main and there is no PR evidence.
  await expectRefused(unmerged, unmerged.environment);
  // A squash commit exists on main but no merged PR names this head, or names another head.
  const main = await mergeSquash(unmerged);
  await expectRefused(unmerged, unmerged.environment);
  await expectRefused(unmerged, await fakeGh(unmerged.root, pr("0".repeat(40), main)));
  await expectRefused(unmerged, await fakeGh(unmerged.root, pr(tip, main, "OPEN")));
  await expectRefused(unmerged, await fakeGh(unmerged.root, pr(tip, "1".repeat(40))));
  await expectRefused(unmerged, await fakeGh(unmerged.root, pr(tip, null)));

  // Full merge proof never excuses uncommitted work: a new file or an edit in @ is dirty.
  const dirty = await jjDriver();
  const dirtyTip = await deliver(dirty);
  const dirtyMain = await mergeSquash(dirty);
  await forget(dirty);
  await writeFile(join(dirty.worktree, "scratch.txt"), "uncommitted\n");
  await expectRefused(dirty, await fakeGh(dirty.root, pr(dirtyTip, dirtyMain)));
  const edited = await jjDriver();
  const editedTip = await deliver(edited);
  const editedMain = await mergeSquash(edited);
  await writeFile(join(edited.worktree, "delivered.txt"), "edited after delivery\n");
  await expectRefused(edited, await fakeGh(edited.root, pr(editedTip, editedMain)));
});

test("guard: a conflicted working copy is refused even when its parents are merged into main", async () => {
  const fixture = await jjDriver();
  // Two sibling commits on main edit the same line; both are then merged into main, so only the conflict itself blocks retirement.
  const sibling = async (message: string) => {
    await ok(fixture.worktree, "jj", "new", "main", "-m", message);
    await writeFile(join(fixture.worktree, "README.md"), `${message}\n`);
    return commitId(fixture.worktree, "@");
  };
  const left = await sibling("left"), right = await sibling("right");
  await ok(fixture.worktree, "jj", "new", left, right);
  expect(await ok(fixture.worktree, "jj", "log", "-r", "@ & conflicts()", "--no-graph", "-T", "commit_id")).not.toBe("");
  await ok(fixture.repository, "jj", "bookmark", "set", "main", "-r", right);
  await ok(fixture.repository, "jj", "new", "main");
  await expectRefused(fixture, fixture.environment);
});

test("guard: a bookmark that has moved past the merged head is unmerged work and stays refused", async () => {
  const fixture = await jjDriver();
  const tip = await deliver(fixture);
  const main = await mergeSquash(fixture);
  await writeFile(join(fixture.worktree, "later.txt"), "later\n");
  await ok(fixture.worktree, "jj", "commit", "-m", "later work");
  await ok(fixture.worktree, "jj", "bookmark", "set", "delivery/sq", "-r", "@-");
  await expectRefused(fixture, await fakeGh(fixture.root, pr(tip, main)));
});

test("guard: retirement authorization is unchanged even with full merge proof", async () => {
  const fixture = await jjDriver();
  const tip = await deliver(fixture);
  const main = await mergeSquash(fixture);
  await expectRefused(fixture, await fakeGh(fixture.root, pr(tip, main)), "driver.other@demo", /Only .* may retire|retire/);
});
