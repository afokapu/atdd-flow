import { afterEach, expect, test as bunTest } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { projectHerdrSeat } from "../src/multiplexer";

/**
 * RED contract for closing inactive driver workspaces. Every fixture lives
 * below mkdtemp and talks to a fake `herdr` executable that only logs calls,
 * so no real multiplexer session is touched.
 */
const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const test = (name: string, body: () => unknown | Promise<unknown>) => bunTest(name, body, 30_000);

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

type Workspace = { id: string; label: string; path: string; agent?: "idle" | "working" | "blocked" };

/**
 * A fake Herdr that reports fixed workspaces/panes and logs every invocation.
 * `pane get` answers only for listed live Pi panes; `worktree open` fails for a
 * missing checkout, as real Herdr does.
 */
async function fakeHerdr(root: string, workspaces: Workspace[], livePanes: string[] = []) {
  const bin = join(root, "bin");
  const log = join(root, "herdr.log");
  await mkdir(bin, { recursive: true });
  const listed = JSON.stringify({ result: { workspaces: workspaces.map((entry) => ({ workspace_id: entry.id, label: entry.label, worktree: { checkout_path: entry.path } })) } });
  const paneCases = workspaces.map((entry) => `  pane:list:${entry.id}) printf '%s' '${JSON.stringify({ result: { panes: [{ pane_id: `${entry.id}:p1`, tab_id: `${entry.id}:t1`, workspace_id: entry.id, label: entry.label, agent: "pi", agent_status: entry.agent ?? "idle" }] } })}' ;;`).join("\n");
  await writeFile(join(bin, "herdr"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$3:$4" = "pane:get" ]; then
  case "$5" in
${livePanes.map((pane) => `    ${pane}) printf '%s' '${JSON.stringify({ result: { pane: { pane_id: pane, agent: "pi", agent_status: "idle" } } })}' ; exit 0 ;;`).join("\n")}
    *) printf '%s' 'pane not found' >&2 ; exit 1 ;;
  esac
fi
if [ "$3:$4" = "worktree:open" ] && [ ! -d "$8" ]; then printf '%s' 'worktree path does not exist' >&2 ; exit 1 ; fi
case "$3:$4:$6" in
  workspace:list:*) printf '%s' '${listed}' ;;
${paneCases}
  pane:list:*) printf '%s' '{"result":{"panes":[]}}' ;;
  tab:list:*) printf '%s' '{"result":{"tabs":[]}}' ;;
  workspace:create:*) printf '%s' '{"result":{"workspace":{"workspace_id":"wNew"},"root_tab":{"tab_id":"wNew:t1"},"root_pane":{"pane_id":"wNew:p1"}}}' ;;
  worktree:open:*) printf '%s' '{"result":{"workspace":{"workspace_id":"wOpen"},"root_tab":{"tab_id":"wOpen:t1"},"root_pane":{"pane_id":"wOpen:p1"}}}' ;;
  tab:create:*) printf '%s' '{"result":{"tab":{"tab_id":"wTab:t1"},"root_pane":{"pane_id":"wTab:p1"}}}' ;;
  *) printf '%s' '{"result":{}}' ;;
esac
`);
  await chmod(join(bin, "herdr"), 0o755);
  const environment = { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, HERDR_SESSION: undefined, HERDR_PANE_ID: undefined, PATH: `${bin}:${process.env.PATH ?? ""}` };
  return { log, environment, calls: async () => await Bun.file(log).exists() ? readFile(log, "utf8") : "" };
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

/** Inactive driver (wDone), working inactive driver (wBusy), active driver, primary, operator and unrelated workspaces. */
async function mixedSession() {
  const fixture = await desk(["done", "busy", "active"]);
  await finishTask(fixture.site, fixture.clean, "driver.done@demo", "W-done");
  await finishTask(fixture.site, fixture.clean, "driver.busy@demo", "W-busy");
  await run(fixture.site, fixture.clean, "task", "add", "demo", "W-active", "--title", "Active", "--coordinator", fixture.coordinator, "--assignee", "driver.active@demo", "--done-when", "Delivered.");
  await run(fixture.site, fixture.clean, "task", "start", "demo", "W-active", "--by", "driver.active@demo");
  const herdr = await fakeHerdr(fixture.root, [
    { id: "wPrimary", label: "demo", path: fixture.repository },
    { id: "wDone", label: "driver.done@demo", path: join(fixture.worktrees, "done") },
    { id: "wBusy", label: "driver.busy@demo", path: join(fixture.worktrees, "busy"), agent: "working" },
    { id: "wActive", label: "driver.active@demo", path: join(fixture.worktrees, "active") },
    { id: "wOperator", label: "operator@desk", path: fixture.root },
    { id: "wScratch", label: "scratch", path: tmpdir() },
  ]);
  return { ...fixture, herdr };
}

test("RED: multiplexer status reports inactive driver workspaces as stale", async () => {
  const fixture = await mixedSession();
  const output = await run(fixture.site, fixture.herdr.environment, "multiplexer", "status", "herdr", "--session", "chosen");
  expect(JSON.parse(output)).toMatchObject({ schema: "atdd-workflow/multiplexer-status/v1", stale: 2 });
  expect(await fixture.herdr.calls()).not.toContain(" close");
});

type StaleEntry = { address: string; workspace_id: string; reason: string; agents: Array<{ pane_id: string; agent?: string; agent_status?: string }>; outcome: string; because?: string };
const staleEntries = (status: { stale_workspaces?: StaleEntry[] }) => [...(status.stale_workspaces ?? [])].sort((left, right) => left.workspace_id.localeCompare(right.workspace_id));

test("RED: multiplexer status lists each stale workspace with the close/keep outcome apply acts on", async () => {
  const fixture = await mixedSession();
  const status = JSON.parse(await run(fixture.site, fixture.herdr.environment, "multiplexer", "status", "herdr", "--session", "chosen"));
  expect(status.stale).toBe(2);
  expect(staleEntries(status)).toEqual([
    { address: "driver.busy@demo", workspace_id: "wBusy", reason: "no active task", agents: [{ pane_id: "wBusy:p1", agent: "pi", agent_status: "working" }], outcome: "keep", because: "agent in wBusy:p1 is working" },
    { address: "driver.done@demo", workspace_id: "wDone", reason: "no active task", agents: [{ pane_id: "wDone:p1", agent: "pi", agent_status: "idle" }], outcome: "close" },
  ]);
  // Status is read-only: listing the stale set never closes, renames or creates anything.
  expect(await fixture.herdr.calls()).not.toMatch(/ (close|rename|create|open) /);
  const output = await run(fixture.site, fixture.herdr.environment, "multiplexer", "apply", "herdr", "--session", "chosen");
  const closed = [...(await fixture.herdr.calls()).matchAll(/workspace close (\S+)/g)].map((match) => match[1]);
  expect(closed).toEqual(staleEntries(status).filter((entry) => entry.outcome === "close").map((entry) => entry.workspace_id));
  expect(output).toContain("kept  driver.busy@demo  wBusy: agent in wBusy:p1 is working");
});

test("RED: status names a retired driver's stale workspace as retired", async () => {
  const fixture = await desk(["gone"]);
  await finishTask(fixture.site, fixture.clean, "driver.gone@demo", "W-gone", "--retire-assignee");
  const herdr = await fakeHerdr(fixture.root, [
    { id: "wPrimary", label: "demo", path: fixture.repository },
    { id: "wGone", label: "driver.gone@demo", path: join(fixture.worktrees, "gone") },
  ]);
  const status = JSON.parse(await run(fixture.site, herdr.environment, "multiplexer", "status", "herdr", "--session", "chosen"));
  expect(staleEntries(status)).toEqual([
    { address: "driver.gone@demo", workspace_id: "wGone", reason: "retired", agents: [{ pane_id: "wGone:p1", agent: "pi", agent_status: "idle" }], outcome: "close" },
  ]);
  expect(await herdr.calls()).not.toContain("workspace close");
});

test("RED: without close_inactive every listed stale workspace is kept, as apply keeps it", async () => {
  const fixture = await mixedSession();
  const deskFile = join(fixture.site, "desk.yaml");
  await writeFile(deskFile, stringify({ ...parse(await readFile(deskFile, "utf8")), multiplexer: { close_inactive: false } }));
  const status = JSON.parse(await run(fixture.site, fixture.herdr.environment, "multiplexer", "status", "herdr", "--session", "chosen"));
  expect(staleEntries(status).map(({ workspace_id, outcome, because }) => ({ workspace_id, outcome, because }))).toEqual([
    { workspace_id: "wBusy", outcome: "keep", because: "close_inactive is off" },
    { workspace_id: "wDone", outcome: "keep", because: "close_inactive is off" },
  ]);
  expect(await fixture.herdr.calls()).not.toContain("workspace close");
});

test("RED: multiplexer apply closes only idle inactive driver workspaces when close_inactive is enabled", async () => {
  const fixture = await mixedSession();
  const output = await run(fixture.site, fixture.herdr.environment, "multiplexer", "apply", "herdr", "--session", "chosen");
  const calls = await fixture.herdr.calls();
  expect(calls).toContain("--session chosen workspace close wDone");
  // A working or blocked Pi agent is reported, never closed.
  expect(output).toContain("driver.busy@demo");
  for (const kept of ["wBusy", "wActive", "wPrimary", "wOperator", "wScratch"]) expect(calls).not.toContain(`workspace close ${kept}`);
});

async function assign(fixture: Awaited<ReturnType<typeof desk>>, driver: string, id: string, ...states: Array<"start" | "block">) {
  await run(fixture.site, fixture.clean, "task", "add", "demo", id, "--title", id, "--coordinator", fixture.coordinator, "--assignee", driver, "--done-when", "Delivered.");
  if (states.includes("start")) await run(fixture.site, fixture.clean, "task", "start", "demo", id, "--by", driver);
  if (states.includes("block")) await run(fixture.site, fixture.clean, "task", "block", "demo", id, "--by", fixture.coordinator, "--reason", "waiting on a decision");
}

test("RED: apply projects only drivers with unblocked in-progress work or a live Pi runtime", async () => {
  const fixture = await desk(["working", "queued", "blocked", "livebound", "deadbound"]);
  await assign(fixture, "driver.working@demo", "W-working", "start");
  await assign(fixture, "driver.queued@demo", "W-queued");
  await assign(fixture, "driver.blocked@demo", "W-blocked", "start", "block");
  await assign(fixture, "driver.livebound@demo", "W-livebound");
  await assign(fixture, "driver.deadbound@demo", "W-deadbound");
  await run(fixture.site, fixture.clean, "bind", "driver.livebound@demo", "--application", "herdr", "--address", "wElsewhere:p1", "--session", "chosen");
  await run(fixture.site, fixture.clean, "bind", "driver.deadbound@demo", "--application", "herdr", "--address", "wGone:p9", "--session", "chosen");
  const herdr = await fakeHerdr(fixture.root, [
    { id: "wPrimary", label: "demo", path: fixture.repository },
    { id: "wBlocked", label: "driver.blocked@demo", path: join(fixture.worktrees, "blocked") },
  ], ["wElsewhere:p1"]);
  await run(fixture.site, herdr.environment, "multiplexer", "apply", "herdr", "--session", "chosen");
  const calls = await herdr.calls();
  const opened = (name: string) => calls.includes(`worktree open --workspace wPrimary --path ${join(fixture.worktrees, name)} `);
  expect(opened("working")).toBe(true);
  expect(opened("livebound")).toBe(true);
  // Never-started, blocked, and stale-bound drivers are not recreated as empty shells.
  expect(opened("queued")).toBe(false);
  expect(opened("blocked")).toBe(false);
  expect(opened("deadbound")).toBe(false);
  expect(calls).toContain("--session chosen workspace close wBlocked");
  expect(calls).not.toContain("workspace close wPrimary");
  const status = JSON.parse(await run(fixture.site, herdr.environment, "multiplexer", "status", "herdr", "--session", "chosen"));
  expect(status).toMatchObject({ stale: 1 });
});

test("RED: apply skips and reports a missing driver worktree instead of aborting the Desk", async () => {
  const fixture = await desk(["gone", "working"]);
  await assign(fixture, "driver.gone@demo", "W-gone", "start");
  await assign(fixture, "driver.working@demo", "W-working", "start");
  await rm(join(fixture.worktrees, "gone"), { recursive: true, force: true });
  const herdr = await fakeHerdr(fixture.root, [{ id: "wPrimary", label: "demo", path: fixture.repository }]);
  const result = await spawnCli(fixture.site, herdr.environment, ["multiplexer", "apply", "herdr", "--session", "chosen"]);
  expect(result.code, result.stderr).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("driver.gone@demo");
  expect(await herdr.calls()).toContain(`worktree open --workspace wPrimary --path ${join(fixture.worktrees, "working")} `);
});

test("guard: explicit per-seat projection still opens a driver that blanket apply treats as inactive", async () => {
  const fixture = await desk(["queued"]);
  await assign(fixture, "driver.queued@demo", "W-queued");
  const herdr = await fakeHerdr(fixture.root, [{ id: "wPrimary", label: "demo", path: fixture.repository }]);
  const projection = await projectHerdrSeat(fixture.site, "driver.queued@demo", "chosen", async (args) => {
    const child = Bun.spawn(args, { env: herdr.environment, stdout: "pipe", stderr: "pipe" });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`herdr failed: ${args.join(" ")}`);
    return stdout.trim();
  });
  expect(projection.label).toBe("driver.queued@demo");
  expect(await herdr.calls()).toContain(`worktree open --workspace wPrimary --path ${join(fixture.worktrees, "queued")} `);
});

test("RED: task done --retire-assignee closes the retired driver workspace", async () => {
  const fixture = await desk(["runtime"]);
  const herdr = await fakeHerdr(fixture.root, [
    { id: "wPrimary", label: "demo", path: fixture.repository },
    { id: "wRuntime", label: "driver.runtime@demo", path: join(fixture.worktrees, "runtime") },
  ]);
  const environment = { ...herdr.environment, HERDR_SESSION: "chosen" };
  await finishTask(fixture.site, environment, "driver.runtime@demo", "W-runtime", "--retire-assignee");
  await expect(stat(join(fixture.worktrees, "runtime"))).rejects.toThrow();
  expect(await run(fixture.site, environment, "open", "driver.runtime@demo")).toContain("retired:");
  const calls = await herdr.calls();
  expect(calls).toContain("--session chosen workspace close wRuntime");
  expect(calls).not.toContain("workspace close wPrimary");
});

test("RED: an already-DONE driver can be retired by its coordinator, which also closes its workspace", async () => {
  const fixture = await desk(["finished"]);
  const herdr = await fakeHerdr(fixture.root, [
    { id: "wPrimary", label: "demo", path: fixture.repository },
    { id: "wFinished", label: "driver.finished@demo", path: join(fixture.worktrees, "finished") },
  ]);
  const environment = { ...herdr.environment, HERDR_SESSION: "chosen" };
  await finishTask(fixture.site, environment, "driver.finished@demo", "W-finished");
  await run(fixture.site, environment, "seat", "retire", "driver.finished@demo", "--by", fixture.coordinator);
  await expect(stat(join(fixture.worktrees, "finished"))).rejects.toThrow();
  expect(await git(fixture.repository, "branch", "--list", "delivery/finished")).toBe("");
  const record = await run(fixture.site, environment, "open", "driver.finished@demo");
  expect(record).toContain("retired:");
  expect(record).toContain("status: complete");
  const calls = await herdr.calls();
  expect(calls).toContain("--session chosen workspace close wFinished");
  expect(calls).not.toContain("workspace close wPrimary");
});

test("an assignee whose only task is superseded can be retired by its coordinator", async () => {
  const fixture = await desk(["obsolete"]);
  const herdr = await fakeHerdr(fixture.root, [
    { id: "wPrimary", label: "demo", path: fixture.repository },
    { id: "wObsolete", label: "driver.obsolete@demo", path: join(fixture.worktrees, "obsolete") },
  ]);
  const environment = { ...herdr.environment, HERDR_SESSION: "chosen" };
  await run(fixture.site, environment, "task", "add", "demo", "W-obsolete", "--title", "Obsolete", "--coordinator", "coordinator@demo", "--assignee", "driver.obsolete@demo", "--done-when", "Never delivered.");
  await run(fixture.site, environment, "task", "supersede", "demo", "W-obsolete", "--by", "coordinator@demo", "--reason", "Replaced.");
  await run(fixture.site, environment, "seat", "retire", "driver.obsolete@demo", "--by", fixture.coordinator);
  await expect(stat(join(fixture.worktrees, "obsolete"))).rejects.toThrow();
  expect(await run(fixture.site, environment, "open", "driver.obsolete@demo")).toContain("retired:");
  expect(await herdr.calls()).toContain("--session chosen workspace close wObsolete");
});

test("guard: without close_inactive, status still reports stale workspaces but apply never closes them", async () => {
  const fixture = await mixedSession();
  const deskFile = join(fixture.site, "desk.yaml");
  await writeFile(deskFile, stringify({ ...parse(await readFile(deskFile, "utf8")), multiplexer: { close_inactive: false } }));
  expect(JSON.parse(await run(fixture.site, fixture.herdr.environment, "multiplexer", "status", "herdr", "--session", "chosen"))).toMatchObject({ stale: 2, close_inactive: false });
  const output = await run(fixture.site, fixture.herdr.environment, "multiplexer", "apply", "herdr", "--session", "chosen");
  expect(output).toContain("driver.done@demo");
  expect(await fixture.herdr.calls()).not.toContain("workspace close");
});

test("guard: a blocked agent keeps its stale workspace open and is reported", async () => {
  const fixture = await desk(["waiting"]);
  await finishTask(fixture.site, fixture.clean, "driver.waiting@demo", "W-waiting");
  const herdr = await fakeHerdr(fixture.root, [
    { id: "wPrimary", label: "demo", path: fixture.repository },
    { id: "wWaiting", label: "driver.waiting@demo", path: join(fixture.worktrees, "waiting"), agent: "blocked" },
  ]);
  const output = await run(fixture.site, herdr.environment, "multiplexer", "apply", "herdr", "--session", "chosen");
  expect(output).toContain("driver.waiting@demo");
  expect(output).toContain("blocked");
  expect(await herdr.calls()).not.toContain("workspace close");
});

async function retireFailsClosed(fixture: Awaited<ReturnType<typeof desk>>, name: string, args: string[], message: string) {
  const herdr = await fakeHerdr(fixture.root, [
    { id: "wPrimary", label: "demo", path: fixture.repository },
    { id: "wDriver", label: `driver.${name}@demo`, path: join(fixture.worktrees, name) },
  ]);
  const environment = { ...herdr.environment, HERDR_SESSION: "chosen" };
  const result = await spawnCli(fixture.site, environment, args);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect((await stat(join(fixture.worktrees, name))).isDirectory()).toBe(true);
  expect(await run(fixture.site, environment, "open", `driver.${name}@demo`)).not.toContain("retired:");
  expect(await herdr.calls()).not.toContain("workspace close");
}

test("guard: seat retire fails closed for unfinished work or a non-coordinator actor", async () => {
  const fixture = await desk(["partial", "other"]);
  await finishTask(fixture.site, fixture.clean, "driver.partial@demo", "W-first");
  await assign(fixture, "driver.partial@demo", "W-second", "start");
  await retireFailsClosed(fixture, "partial", ["seat", "retire", "driver.partial@demo", "--by", fixture.coordinator], "unfinished tasks: W-second");
  await finishTask(fixture.site, fixture.clean, "driver.other@demo", "W-other");
  await retireFailsClosed(fixture, "other", ["seat", "retire", "driver.other@demo", "--by", "driver.partial@demo"], "may retire it");
});

test("guard: seat retire and task done --retire-assignee fail closed on a dirty worktree", async () => {
  const fixture = await desk(["dirty", "dirtydone"]);
  await finishTask(fixture.site, fixture.clean, "driver.dirty@demo", "W-dirty");
  await writeFile(join(fixture.worktrees, "dirty", "uncommitted.txt"), "work in progress\n");
  await retireFailsClosed(fixture, "dirty", ["seat", "retire", "driver.dirty@demo", "--by", fixture.coordinator], "worktree is dirty");
  await writeFile(join(fixture.worktrees, "dirtydone", "uncommitted.txt"), "work in progress\n");
  await run(fixture.site, fixture.clean, "task", "add", "demo", "W-dirtydone", "--title", "Dirty", "--coordinator", fixture.coordinator, "--assignee", "driver.dirtydone@demo", "--done-when", "Delivered.");
  await run(fixture.site, fixture.clean, "task", "start", "demo", "W-dirtydone", "--by", "driver.dirtydone@demo");
  await run(fixture.site, fixture.clean, "task", "prove", "demo", "W-dirtydone", "--by", "driver.dirtydone@demo", "--item", "1", "--proof", "local");
  await run(fixture.site, fixture.clean, "task", "review", "demo", "W-dirtydone", "--by", "driver.dirtydone@demo");
  await retireFailsClosed(fixture, "dirtydone", ["task", "done", "demo", "W-dirtydone", "--by", fixture.coordinator, "--retire-assignee"], "worktree is dirty");
  expect(await run(fixture.site, fixture.clean, "task", "open", "demo", "W-dirtydone")).toContain("status: review");
});

test("guard: seat retire fails closed on an unmerged delivery branch", async () => {
  const fixture = await desk(["unmerged"]);
  const worktree = join(fixture.worktrees, "unmerged");
  await writeFile(join(worktree, "feature.txt"), "unmerged\n");
  await git(worktree, "add", "feature.txt");
  await git(worktree, "commit", "-m", "unmerged work");
  await finishTask(fixture.site, fixture.clean, "driver.unmerged@demo", "W-unmerged");
  await retireFailsClosed(fixture, "unmerged", ["seat", "retire", "driver.unmerged@demo", "--by", fixture.coordinator], "is not merged");
  expect(await git(fixture.repository, "branch", "--list", "delivery/unmerged")).toContain("delivery/unmerged");
});

test("RED: seat retire records retirement for an all-DONE driver whose worktree is absent and unregistered, keeping its branch", async () => {
  const fixture = await desk(["vanished"]);
  const worktree = join(fixture.worktrees, "vanished");
  await finishTask(fixture.site, fixture.clean, "driver.vanished@demo", "W-vanished");
  await git(fixture.repository, "worktree", "remove", "--force", worktree);
  const herdr = await fakeHerdr(fixture.root, [
    { id: "wPrimary", label: "demo", path: fixture.repository },
    { id: "wVanished", label: "driver.vanished@demo", path: worktree },
  ]);
  const environment = { ...herdr.environment, HERDR_SESSION: "chosen" };
  await run(fixture.site, environment, "seat", "retire", "driver.vanished@demo", "--by", fixture.coordinator);
  const record = await run(fixture.site, environment, "open", "driver.vanished@demo");
  expect(record).toContain("retired:");
  expect(record).toContain("status: complete");
  expect(record).toContain("absent");
  // No worktree finish ran: the branch is kept as evidence and the worktree is not recreated.
  expect(await git(fixture.repository, "branch", "--list", "delivery/vanished")).toContain("delivery/vanished");
  await expect(stat(worktree)).rejects.toThrow();
  const calls = await herdr.calls();
  expect(calls).toContain("--session chosen workspace close wVanished");
  expect(calls).not.toContain("workspace close wPrimary");
});

test("guard: seat retire fails closed when the absent worktree is still registered with Git", async () => {
  const fixture = await desk(["registered"]);
  const worktree = join(fixture.worktrees, "registered");
  await finishTask(fixture.site, fixture.clean, "driver.registered@demo", "W-registered");
  await rm(worktree, { recursive: true, force: true });
  expect(await git(fixture.repository, "worktree", "list", "--porcelain")).toContain(worktree);
  const herdr = await fakeHerdr(fixture.root, [{ id: "wPrimary", label: "demo", path: fixture.repository }]);
  const environment = { ...herdr.environment, HERDR_SESSION: "chosen" };
  const result = await spawnCli(fixture.site, environment, ["seat", "retire", "driver.registered@demo", "--by", fixture.coordinator]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("still registered with Git");
  expect(await run(fixture.site, environment, "open", "driver.registered@demo")).not.toContain("retired:");
  expect(await git(fixture.repository, "branch", "--list", "delivery/registered")).toContain("delivery/registered");
  expect(await herdr.calls()).not.toContain("workspace close");
});

/*
 * Retiring completed coordinator seats, and resolving the ATDD Bun used by retirement: the primary
 * checkout copy, then a primary checkout that is the ATDD Bun package source, then PATH, never the
 * seat worktree copy. ATDD Bun calls go through logging wrappers that delegate to the real one.
 */
const realBun = join(import.meta.dir, "..", "node_modules", ".bin", "atdd-bun");

/** Writes an `atdd-bun` wrapper that logs `<label> <cwd>` and delegates to the real ATDD Bun. */
async function wrapper(directory: string, label: string, log: string) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, "atdd-bun");
  await writeFile(file, `#!/bin/sh\nprintf '%s %s\\n' '${label}' "$(pwd -P)" >> '${log}'\nexec '${process.execPath}' '${await realpath(realBun)}' "$@"\n`);
  await chmod(file, 0o755);
}

/** A repository with linked-worktree policy, main@demo on the primary checkout, and named coordinators/drivers. */
async function topologyDesk(options: { coordinators?: string[]; drivers?: string[]; packageSource?: boolean; primaryBun?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-coordinator-retire-"));
  roots.push(root);
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  const site = join(root, "site");
  const log = join(root, "atdd-bun.log");
  const environment: Record<string, string | undefined> = { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, HERDR_SESSION: undefined, HERDR_PANE_ID: undefined };
  await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "test@example.test");
  await git(repository, "config", "user.name", "Test");
  await writeFile(join(repository, ".gitignore"), "node_modules/\n");
  await writeFile(join(repository, "atdd-bun.yaml"), "worktrees:\n  enabled: true\n  root: ../worktrees\n  primary_directory: repository\n  primary_branch: main\n  require_linked_worktree: true\n");
  const tracked = [".gitignore", "atdd-bun.yaml"];
  if (options.packageSource) {
    await writeFile(join(repository, "package.json"), JSON.stringify({ name: "@afokapu/atdd-bun", type: "module" }));
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src", "cli.ts"), `import { appendFileSync, realpathSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "source " + realpathSync(process.cwd()) + "\\n");
const child = Bun.spawnSync([process.execPath, ${JSON.stringify(await realpath(realBun))}, ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" });
process.exit(child.exitCode ?? 1);
`);
    tracked.push("package.json", "src/cli.ts");
  }
  await git(repository, "add", ...tracked);
  await git(repository, "commit", "-m", "configure worktrees");
  // Retirement resolves ATDD Bun from the primary checkout; node_modules is gitignored there.
  if (options.primaryBun !== false && !options.packageSource) {
    await mkdir(join(repository, "node_modules", ".bin"), { recursive: true });
    await symlink(join(import.meta.dir, "..", "node_modules", ".bin", "atdd-bun"), join(repository, "node_modules", ".bin", "atdd-bun"));
  }
  await run(root, environment, "init", site);
  await run(site, environment, "project", "init", "demo");
  await writeFile(join(site, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
repository: ${repository}
worktree_root: ${worktrees}
roles:
  main:
    address: main@{project}
    branch: main
    worktree: "{repository}"
  coordinator:
    address: coordinator.{name}@{project}
    branch: integration/{name}
    base: main
    worktree: "{worktree_root}/{name}"
  driver:
    address: driver.{name}@{project}
    branch: delivery/{name}
    base: main
    worktree: "{worktree_root}/{name}"
`);
  await run(site, environment, "spawn", "demo", "main", "primary");
  for (const name of options.coordinators ?? []) await run(site, environment, "spawn", "demo", "coordinator", name);
  for (const name of options.drivers ?? []) await run(site, environment, "spawn", "demo", "driver", name);
  return { root, site, repository, worktrees, log, environment };
}

type TopologyFixture = Awaited<ReturnType<typeof topologyDesk>>;

async function finishCoordinated(fixture: TopologyFixture, coordinator: string, driver: string, id: string) {
  const { site, environment } = fixture;
  await run(site, environment, "task", "add", "demo", id, "--title", id, "--coordinator", coordinator, "--assignee", driver, "--done-when", "Delivery branch is merged.");
  await run(site, environment, "task", "start", "demo", id, "--by", driver);
  await run(site, environment, "task", "prove", "demo", id, "--by", driver, "--item", "1", "--proof", "main already contains the delivery branch");
  await run(site, environment, "task", "review", "demo", id, "--by", driver);
  await run(site, environment, "task", "done", "demo", id, "--by", coordinator);
}

test("RED: main retires a terminal non-main generic coordinator on the primary checkout without finishing it", async () => {
  const fixture = await desk(["terminal"]);
  await finishTask(fixture.site, fixture.clean, "driver.terminal@demo", "W-terminal");
  await rm(join(fixture.repository, "node_modules", ".bin", "atdd-bun"));
  await wrapper(join(fixture.repository, "node_modules", ".bin"), "primary", join(fixture.root, "atdd-bun.log"));

  await run(fixture.site, fixture.clean, "seat", "retire", "coordinator@demo", "--by", "main@demo");

  expect(await run(fixture.site, fixture.clean, "open", "coordinator@demo")).toContain("retired:");
  expect((await stat(fixture.repository)).isDirectory()).toBe(true);
  expect(await git(fixture.repository, "branch", "--show-current")).toBe("main");
  expect(await Bun.file(join(fixture.root, "atdd-bun.log")).exists()).toBe(false);
});

async function refused(fixture: TopologyFixture, address: string, by: string, message?: string) {
  const result = await spawnCli(fixture.site, fixture.environment, ["seat", "retire", address, "--by", by]);
  expect(result.code).not.toBe(0);
  if (message) expect(result.stderr).toContain(message);
  return result;
}

test("RED: main retires an all-DONE named coordinator whose worktree is absent and unregistered, keeping its branch", async () => {
  const fixture = await topologyDesk({ coordinators: ["payments"], drivers: ["checkout"] });
  await finishCoordinated(fixture, "coordinator.payments@demo", "driver.checkout@demo", "W-checkout");
  const worktree = join(fixture.worktrees, "payments");
  await git(fixture.repository, "worktree", "remove", "--force", worktree);
  await run(fixture.site, fixture.environment, "seat", "retire", "coordinator.payments@demo", "--by", "main@demo");
  const record = await run(fixture.site, fixture.environment, "open", "coordinator.payments@demo");
  expect(record).toContain("retired:");
  expect(record).toContain("status: complete");
  expect(record).toContain("absent");
  expect(await git(fixture.repository, "branch", "--list", "integration/payments")).toContain("integration/payments");
  await expect(stat(worktree)).rejects.toThrow();
});

test("RED: main retires an all-DONE named coordinator with a clean merged worktree through worktree finish", async () => {
  const fixture = await topologyDesk({ coordinators: ["ledger"], drivers: ["posting"] });
  await finishCoordinated(fixture, "coordinator.ledger@demo", "driver.posting@demo", "W-posting");
  await run(fixture.site, fixture.environment, "seat", "retire", "coordinator.ledger@demo", "--by", "main@demo");
  await expect(stat(join(fixture.worktrees, "ledger"))).rejects.toThrow();
  expect(await git(fixture.repository, "branch", "--list", "integration/ledger")).toBe("");
  expect(await run(fixture.site, fixture.environment, "open", "coordinator.ledger@demo")).toContain("retired:");
});

test("guard: a coordinator with an open coordinated task, a non-main actor, main, and operator stay refused", async () => {
  const fixture = await topologyDesk({ coordinators: ["busy", "idle"], drivers: ["open", "done"] });
  await run(fixture.site, fixture.environment, "task", "add", "demo", "W-open", "--title", "Open", "--coordinator", "coordinator.busy@demo", "--assignee", "driver.open@demo", "--done-when", "Delivered.");
  await run(fixture.site, fixture.environment, "task", "start", "demo", "W-open", "--by", "driver.open@demo");
  await refused(fixture, "coordinator.busy@demo", "main@demo", "unfinished tasks: W-open");
  expect((await stat(join(fixture.worktrees, "busy"))).isDirectory()).toBe(true);
  await finishCoordinated(fixture, "coordinator.idle@demo", "driver.done@demo", "W-done");
  await refused(fixture, "coordinator.idle@demo", "coordinator.busy@demo", "main@demo");
  await refused(fixture, "main@demo", "main@demo");
  await refused(fixture, "operator@desk", "main@demo");
  for (const address of ["coordinator.busy@demo", "coordinator.idle@demo", "main@demo"]) {
    expect(await run(fixture.site, fixture.environment, "open", address)).not.toContain("retired:");
  }
  expect((await stat(join(fixture.worktrees, "idle"))).isDirectory()).toBe(true);
});

test("RED: retirement prefers the primary checkout ATDD Bun over the seat worktree copy, run in the seat worktree", async () => {
  const fixture = await topologyDesk({ drivers: ["alpha"], primaryBun: false });
  const worktree = await realpath(join(fixture.worktrees, "alpha"));
  await wrapper(join(fixture.repository, "node_modules", ".bin"), "primary", fixture.log);
  await wrapper(join(worktree, "node_modules", ".bin"), "seat", fixture.log);
  await finishCoordinated(fixture, "main@demo", "driver.alpha@demo", "W-alpha");
  await run(fixture.site, fixture.environment, "seat", "retire", "driver.alpha@demo", "--by", "main@demo");
  const log = await readFile(fixture.log, "utf8");
  expect(log).toContain(`primary ${worktree}`);
  expect(log).not.toContain("seat ");
});

test("RED: retirement runs the ATDD Bun package source when the primary checkout is that package", async () => {
  const fixture = await topologyDesk({ drivers: ["beta"], packageSource: true });
  const worktree = await realpath(join(fixture.worktrees, "beta"));
  await wrapper(join(worktree, "node_modules", ".bin"), "seat", fixture.log);
  await finishCoordinated(fixture, "main@demo", "driver.beta@demo", "W-beta");
  await run(fixture.site, fixture.environment, "seat", "retire", "driver.beta@demo", "--by", "main@demo");
  const log = await readFile(fixture.log, "utf8");
  expect(log).toContain(`source ${worktree}`);
  expect(log).not.toContain("seat ");
});

test("RED: without a primary copy, retirement uses PATH ATDD Bun even when the seat worktree has its own", async () => {
  const fixture = await topologyDesk({ drivers: ["gamma"], primaryBun: false });
  const worktree = await realpath(join(fixture.worktrees, "gamma"));
  const bin = join(fixture.root, "bin");
  await wrapper(bin, "path", fixture.log);
  await wrapper(join(worktree, "node_modules", ".bin"), "seat", fixture.log);
  const environment = { ...fixture.environment, PATH: `${bin}:${process.env.PATH ?? ""}` };
  await finishCoordinated({ ...fixture, environment }, "main@demo", "driver.gamma@demo", "W-gamma");
  await run(fixture.site, environment, "seat", "retire", "driver.gamma@demo", "--by", "main@demo");
  const log = await readFile(fixture.log, "utf8");
  expect(log).toContain(`path ${worktree}`);
  expect(log).not.toContain("seat ");
});
