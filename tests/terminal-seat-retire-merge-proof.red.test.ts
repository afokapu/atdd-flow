// URN: test:atdd-flow:terminal-seat-retire-merge-proof
// Acceptance: acc:flow:E021-UNIT-001
// Phase: UNIT
// Purpose: Retiring a terminal driver whose delivery branch ATDD Bun's `worktree finish` cannot prove merged (squash-merged, or post-JJ
// exported bookmark) is accepted when the branch tip is reachable from main or is the head of a merged PR whose merge commit is on main.
// The clean-worktree and no-unmerged-work checks and retirement authorization stay fail-closed, and the branch is always preserved.
import { afterEach, expect, test as bunTest } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const test = (name: string, body: () => unknown | Promise<unknown>) => bunTest(name, body, 60_000);

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function spawnCli(cwd: string, environment: Record<string, string | undefined>, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

async function run(cwd: string, environment: Record<string, string | undefined>, ...args: string[]) {
  const result = await spawnCli(cwd, environment, args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}

/** A real repository with ATDD Bun linked-worktree policy and a Desk that spawns linked driver worktrees. */
async function desk(drivers: string[]) {
  const root = await mkdtemp(join(tmpdir(), "atdd-inactive-cleanup-"));
  roots.push(root);
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  const site = join(root, "site");
  const clean = { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, HERDR_SESSION: undefined, HERDR_PANE_ID: undefined };
  await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "test@example.test");
  await git(repository, "config", "user.name", "Test");
  await writeFile(join(repository, ".gitignore"), "node_modules/\n");
  await writeFile(join(repository, "atdd-bun.yaml"), "worktrees:\n  enabled: true\n  root: ../worktrees\n  primary_directory: repository\n  primary_branch: main\n  require_linked_worktree: true\n");
  await git(repository, "add", ".gitignore", "atdd-bun.yaml");
  await git(repository, "commit", "-m", "configure worktrees");
  // Retirement resolves ATDD Bun from the primary checkout, never the seat worktree.
  await mkdir(join(repository, "node_modules", ".bin"), { recursive: true });
  await symlink(join(import.meta.dir, "..", "node_modules", ".bin", "atdd-bun"), join(repository, "node_modules", ".bin", "atdd-bun"));
  await run(root, clean, "init", site);
  await run(site, clean, "project", "init", "demo");
  await writeFile(join(site, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
repository: ${repository}
worktree_root: ${worktrees}
roles:
  coordinator:
    address: coordinator@{project}
    branch: main
    agent: codex
    worktree: "{repository}"
  driver:
    address: driver.{name}@{project}
    branch: delivery/{name}
    base: main
    agent: codex
    worktree: "{worktree_root}/{name}"
`);
  const deskFile = join(site, "desk.yaml");
  await writeFile(deskFile, stringify({ ...parse(await readFile(deskFile, "utf8")), multiplexer: { close_inactive: true } }));
  await run(site, clean, "spawn", "demo", "coordinator", "main");
  for (const name of drivers) await run(site, clean, "spawn", "demo", "driver", name);
  return { root, site, repository, worktrees, clean, coordinator: "coordinator@demo" };
}

async function finishTask(site: string, environment: Record<string, string | undefined>, driver: string, id: string, ...doneFlags: string[]) {
  await run(site, environment, "task", "add", "demo", id, "--title", `Deliver ${id}`, "--coordinator", "coordinator@demo", "--assignee", driver, "--done-when", "Delivery branch is merged.");
  await run(site, environment, "task", "start", "demo", id, "--by", driver);
  await run(site, environment, "task", "prove", "demo", id, "--by", driver, "--item", "1", "--proof", "main already contains the delivery branch");
  await run(site, environment, "task", "review", "demo", id, "--by", driver);
  await run(site, environment, "task", "done", "demo", id, "--by", "coordinator@demo", ...doneFlags);
}


/** ATDD Bun in the primary checkout that refuses `worktree finish` the way the observed post-JJ and squash-merged failures do. */
async function refusingFinish(repository: string) {
  const bin = join(repository, "node_modules", ".bin", "atdd-bun");
  await rm(bin, { force: true });
  await writeFile(bin, "#!/bin/sh\necho 'atdd-bun: unknown profile delivery; no exported bookmark found 0' >&2\nexit 1\n");
  await chmod(bin, 0o755);
}

/** A fake `gh` that answers `pr list` with the configured JSON; an empty list means no PR evidence. */
async function fakeGh(root: string, prs: unknown) {
  const bin = join(root, "gh-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "gh"), `#!/bin/sh\nprintf '%s' '${JSON.stringify(prs)}'\n`);
  await chmod(join(bin, "gh"), 0o755);
  return { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, HERDR_SESSION: undefined, HERDR_PANE_ID: undefined, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

type Delivery = "reachable" | "squash";

/** A finished driver `sq` whose branch holds one commit that main contains either as an ancestor or only as a squash commit. */
async function terminalDriver(delivery: Delivery) {
  const fixture = await desk(["sq"]);
  const worktree = join(fixture.worktrees, "sq");
  await finishTask(fixture.site, fixture.clean, "driver.sq@demo", "W-sq");
  await writeFile(join(worktree, "delivered.txt"), "delivered\n");
  await git(worktree, "add", "delivered.txt");
  await git(worktree, "-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "deliver");
  const tip = await git(worktree, "rev-parse", "HEAD");
  if (delivery === "reachable") await git(fixture.repository, "merge", "--ff-only", "delivery/sq");
  else {
    await writeFile(join(fixture.repository, "delivered.txt"), "delivered\n");
    await git(fixture.repository, "add", "delivered.txt");
    await git(fixture.repository, "commit", "-m", "squash: deliver (#1)");
  }
  const main = await git(fixture.repository, "rev-parse", "main");
  await refusingFinish(fixture.repository);
  return { ...fixture, worktree, tip, main };
}

const pr = (head: string, merge: string | null, state = "MERGED") => [{ state, headRefOid: head, mergeCommit: merge ? { oid: merge } : null }];

async function retire(fixture: Awaited<ReturnType<typeof terminalDriver>>, environment: Record<string, string | undefined>, by = fixture.coordinator) {
  return spawnCli(fixture.site, environment, ["seat", "retire", "driver.sq@demo", "--by", by]);
}

async function expectRetired(fixture: Awaited<ReturnType<typeof terminalDriver>>, environment: Record<string, string | undefined>) {
  const result = await retire(fixture, environment);
  expect(result.code, result.stderr).toBe(0);
  expect(await run(fixture.site, environment, "open", "driver.sq@demo")).toContain("retired:");
  // The branch is always preserved as evidence.
  expect(await git(fixture.repository, "rev-parse", "refs/heads/delivery/sq")).toBe(fixture.tip);
}

async function expectRefused(fixture: Awaited<ReturnType<typeof terminalDriver>>, environment: Record<string, string | undefined>, match: RegExp, by = fixture.coordinator) {
  const result = await retire(fixture, environment, by);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toMatch(match);
  expect(await run(fixture.site, environment, "open", "driver.sq@demo")).not.toContain("retired:");
  expect(await git(fixture.repository, "rev-parse", "refs/heads/delivery/sq")).toBe(fixture.tip);
  await stat(fixture.worktree);
}

test("RED: a terminal driver whose branch tip is reachable from main is retired when worktree finish refuses it; the branch is preserved", async () => {
  const fixture = await terminalDriver("reachable");
  await expectRetired(fixture, await fakeGh(fixture.root, []));
});

test("RED: a terminal driver whose squash-merged PR head is its branch tip is retired; the branch is preserved", async () => {
  const fixture = await terminalDriver("squash");
  await expectRetired(fixture, await fakeGh(fixture.root, pr(fixture.tip, fixture.main)));
});

test("guard: unmerged work, missing or mismatched PR evidence, and a dirty worktree stay refused", async () => {
  const unmerged = await terminalDriver("squash");
  // No merged PR for the branch: the squash commit on main proves nothing about this tip.
  await expectRefused(unmerged, await fakeGh(unmerged.root, []), /./);
  // A merged PR for an older head: the branch has commits the merge did not include.
  await expectRefused(unmerged, await fakeGh(unmerged.root, pr("0".repeat(40), unmerged.main)), /./);
  // PR not merged, or its merge commit is not on main.
  await expectRefused(unmerged, await fakeGh(unmerged.root, pr(unmerged.tip, unmerged.main, "OPEN")), /./);
  await expectRefused(unmerged, await fakeGh(unmerged.root, pr(unmerged.tip, "1".repeat(40))), /./);
  await expectRefused(unmerged, await fakeGh(unmerged.root, pr(unmerged.tip, null)), /./);
  // Clean-worktree check: even with full merge proof, uncommitted work is refused.
  const dirty = await terminalDriver("squash");
  await writeFile(join(dirty.worktree, "scratch.txt"), "uncommitted\n");
  await expectRefused(dirty, await fakeGh(dirty.root, pr(dirty.tip, dirty.main)), /./);
});

test("guard: retirement authorization is unchanged even with full merge proof", async () => {
  const fixture = await terminalDriver("squash");
  const environment = await fakeGh(fixture.root, pr(fixture.tip, fixture.main));
  await expectRefused(fixture, environment, /Only .* may retire/, "driver.other@demo");
});
