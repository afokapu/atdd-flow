import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAddress, launchCommand, launchedAddress, notificationCommand } from "../src/adapters";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function run(cwd: string, ...args: string[]) {
  return runWithEnvironment(cwd, process.env, ...args);
}

async function runWithEnvironment(cwd: string, environment: Record<string, string | undefined>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim();
}

async function fail(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode).not.toBe(0);
  return `${stdout}${stderr}`;
}

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim();
}

test("a request remains outstanding until its linked result exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");

  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "runtime", "--worktree", "/tmp/demo-runtime");
  await run(site, "describe", "driver.runtime@demo", "--purpose", "Own the runtime rollout.");
  await stat(join(site, "coordination.yaml"));
  await stat(join(site, "work", "demo", "project.yaml"));
  await stat(join(site, "work", "demo", "seats", "driver.runtime", "seat.yaml"));
  expect(await run(site, "open", "driver.runtime@demo")).toContain("Own the runtime rollout.");
  const thread = await run(site, "thread", "start", "--with", "coordinator@demo,driver.runtime@demo", "--subject", "Runtime rollout");
  const request = await run(site, "post", thread, "--from", "coordinator@demo", "--to", "driver.runtime@demo", "--expects-result", "--body", "Run checks");

  await run(site, "receipt", thread, request, "--from", "driver.runtime@demo");
  expect(await run(site, "status")).toContain(`waiting:${request}`);

  await run(site, "result", thread, request, "--from", "driver.runtime@demo", "--body", "Checks pass");
  expect(await run(site, "status")).not.toContain("waiting:");
});

test("an operator can initialize a standalone coordination Git repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const coordination = join(root, "private-work-coordination");

  await run(root, "init", coordination, "--git");

  await stat(join(coordination, ".git"));
  const config = await readFile(join(coordination, "coordination.yaml"), "utf8");
  expect(config).toContain("atdd-workflow/coordination/v2");
  expect(config).toContain("application: tuios");
});

test("a configured driver worktree is created on its declared branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const repository = join(root, "repository");
  const site = join(root, "site");
  await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "test@example.test");
  await git(repository, "config", "user.name", "Test");
  await git(repository, "commit", "--allow-empty", "-m", "initial");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await writeFile(join(site, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
repository: ${repository}
worktree_root: ${join(root, "worktrees")}
roles:
  driver:
    address: driver.{name}@{project}
    branch: delivery/{name}
    base: main
    agent: codex
    worktree: "{worktree_root}/{name}"
`);

  await run(site, "spawn", "demo", "driver", "runtime");
  await stat(join(root, "worktrees", "runtime", ".git"));
  expect(await git(join(root, "worktrees", "runtime"), "branch", "--show-current")).toBe("delivery/runtime");
});

test("a broadcast request remains open until every targeted participant replies", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "one", "--worktree", "/tmp/demo-one");
  await run(site, "spawn", "demo", "driver", "two", "--worktree", "/tmp/demo-two");
  const thread = await run(site, "thread", "start", "--with", "coordinator@demo,driver.one@demo,driver.two@demo", "--subject", "Fan out");
  const request = await run(site, "post", thread, "--from", "coordinator@demo", "--to", "all", "--expects-result", "--body", "Report status");

  await run(site, "result", thread, request, "--from", "driver.one@demo", "--body", "One complete");
  expect(await run(site, "status")).toContain(`${request}@driver.two@demo`);
  await run(site, "result", thread, request, "--from", "driver.two@demo", "--body", "Two complete");
  expect(await run(site, "status")).not.toContain("waiting:");
});

test("a receipt or result must reply to a message addressed to its sender", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "one", "--worktree", "/tmp/demo-one");
  await run(site, "spawn", "demo", "driver", "two", "--worktree", "/tmp/demo-two");
  const thread = await run(site, "thread", "start", "--with", "coordinator@demo,driver.one@demo,driver.two@demo", "--subject", "Reply validation");
  const request = await run(site, "post", thread, "--from", "coordinator@demo", "--to", "driver.one@demo", "--expects-result", "--body", "Reply only if addressed.");

  expect(await fail(site, "result", thread, "M-missing", "--from", "driver.one@demo", "--body", "No.")).toContain("does not exist");
  expect(await fail(site, "receipt", thread, request, "--from", "driver.two@demo")).toContain("was not a recipient");
  expect(await fail(site, "result", thread, request, "--from", "driver.two@demo", "--body", "No.")).toContain("was not a recipient");
  await run(site, "result", thread, request, "--from", "driver.one@demo", "--body", "Done.");
});

test("a replacement agent resumes an outstanding seat and completes its work", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "runtime", "--worktree", "/tmp/demo-runtime");
  const driver = "driver.runtime@demo";
  const thread = await run(site, "thread", "start", "--with", `coordinator@demo,${driver}`, "--subject", "Takeover test");
  const request = await run(site, "post", thread, "--from", "coordinator@demo", "--to", driver, "--expects-result", "--body", "Finish the rollout after takeover.");

  await run(site, "bind", driver, "--application", "tuios", "--address", "takeover-demo/old-driver-pane");
  await run(site, "receipt", thread, request, "--from", driver, "--body", "Received; beginning work.");
  await run(site, "checkpoint", driver, "--status", "blocked", "--summary", "Rate limit reached after receiving the rollout request.", "--next", "Replacement agent should finish the rollout and post the result.");

  // The coordinator replaces a rate-limited agent. The address—and therefore
  // its durable thread history and responsibility—does not change.
  await run(site, "bind", driver, "--application", "tuios", "--address", "takeover-demo/replacement-driver-pane");
  const resumedSeat = await run(site, "open", driver);
  expect(resumedSeat).toContain("tuios: takeover-demo/replacement-driver-pane");
  expect(resumedSeat).toContain("application: tuios");
  expect(resumedSeat).toContain(thread);
  expect(resumedSeat).toContain("Rate limit reached after receiving the rollout request.");
  expect(await readFile(join(site, "threads", thread, `${request}.yaml`), "utf8")).toContain("Finish the rollout after takeover.");
  expect(await run(site, "status")).toContain(`${request}@${driver}`);

  await run(site, "result", thread, request, "--from", driver, "--body", "Rollout completed by replacement agent.");
  expect(await run(site, "status")).not.toContain("waiting:");
});

test("a legacy alias resolves to one canonical seat", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "decision-os");
  await run(site, "spawn", "decision-os", "coordinator", "main", "--worktree", "/tmp/decision-os-main");
  await writeFile(join(site, "coordination.yaml"), `schema: atdd-workflow/coordination/v2
site: site
application: tuios
aliases:
  coordinator@DOS-jev: coordinator@decision-os
`);

  await run(site, "checkpoint", "coordinator@DOS-jev", "--status", "unverified", "--summary", "Recovered through the old address.", "--next", "Reconcile current owner.");
  const opened = await run(site, "open", "coordinator@decision-os");
  expect(opened).toContain("Recovered through the old address.");
  expect(opened).toContain("coordinator@decision-os");
});

test("a seat retains native addresses and can switch its active application", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "driver", "runtime", "--worktree", "/tmp/demo-runtime");

  await run(site, "bind", "driver.runtime@demo", "--application", "herdr", "--address", "w89e05ef9ff16:p2f1de975e7b0");
  await run(site, "bind", "driver.runtime@demo", "--application", "tmux", "--address", "workflow:2.1");
  await run(site, "application", "use", "driver.runtime@demo", "herdr");
  const opened = await run(site, "open", "driver.runtime@demo");
  expect(opened).toContain("application: herdr");
  expect(opened).toContain("herdr: w89e05ef9ff16:p2f1de975e7b0");
  expect(opened).toContain("tmux: workflow:2.1");
  expect(await fail(site, "application", "use", "driver.runtime@demo", "claude")).toContain("Bind it first");
});

test("host adapters discover native addresses from host-provided environment", () => {
  expect(discoverAddress("herdr", { HERDR_PANE_ID: "w1:p2" })).toBe("w1:p2");
  expect(discoverAddress("tmux", { TMUX_PANE: "%7" })).toBe("%7");
  expect(discoverAddress("tuios", { TUIOS_SESSION: "session-1", TUIOS_WINDOW_ID: "window-7" })).toBe("session-1/window-7");
  expect(() => discoverAddress("herdr", {})).toThrow("HERDR_PANE_ID");
  expect(() => discoverAddress("claude", {})).toThrow("No deterministic discovery adapter");
  expect(notificationCommand("herdr", "w1:p2", "read mail")).toEqual(["herdr", "pane", "send-text", "w1:p2", "read mail"]);
  expect(notificationCommand("tuios", "session-1/window-7", "read mail")).toEqual(["tuios", "queue", "-s", "session-1", "-w", "window-7", "read mail"]);
  expect(launchCommand({ application: "tuios", placement: "etdd-os", name: "driver.runtime@etdd", worktree: "/worktrees/runtime", agent: "codex", root: "/coordination", seat: "driver.runtime@etdd" })).toEqual([
    "tuios", "new-window", "driver.runtime@etdd", "-s", "etdd-os", "--cwd", "/worktrees/runtime", "--no-focus", "--print-id", "--",
    "/usr/bin/env", "ATDD_WORKFLOW_ROOT=/coordination", "ATDD_WORKFLOW_SEAT=driver.runtime@etdd", "codex",
  ]);
  expect(launchedAddress("tuios", "etdd-os", "window-7\n")).toBe("etdd-os/window-7");
  expect(() => launchCommand({ application: "herdr", placement: "w1", name: "driver", worktree: "/work", agent: "codex", root: "/coordination", seat: "driver@demo" })).toThrow("No deterministic launch adapter");
});

test("a host-attached replacement preserves its durable work and wakes the current native address", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "coordination");
  const bin = join(root, "bin");
  const notificationLog = join(root, "herdr-notifications.txt");
  const fakeHerdr = join(bin, "herdr");
  await mkdir(bin);
  await writeFile(fakeHerdr, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${notificationLog}'\n`);
  await chmod(fakeHerdr, 0o755);
  const host = (pane: string) => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HERDR_PANE_ID: pane,
  });

  await run(root, "init", site, "--git");
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "runtime", "--worktree", "/tmp/demo-runtime");
  const coordinator = "coordinator@demo";
  const driver = "driver.runtime@demo";
  await runWithEnvironment(site, host("w-test:p-old"), "attach", driver, "--application", "herdr");

  const thread = await run(site, "thread", "start", "--with", `${coordinator},${driver}`, "--subject", "Host-attached handoff");
  const request = await runWithEnvironment(site, host("w-test:p-coordinator"), "post", thread, "--from", coordinator, "--to", driver, "--expects-result", "--body", "Complete the handoff.");
  expect(await readFile(notificationLog, "utf8")).toContain(`pane\nsend-text\nw-test:p-old\nSYSTEM: new thread mail ${request}`);
  await run(site, "receipt", thread, request, "--from", driver);
  await run(site, "checkpoint", driver, "--status", "blocked", "--summary", "The first host reached its rate limit.", "--next", "Replacement host must complete the handoff.");

  await runWithEnvironment(site, host("w-test:p-replacement"), "attach", driver, "--application", "herdr");
  const resumed = await run(site, "open", driver);
  expect(resumed).toContain("herdr: w-test:p-replacement");
  expect(resumed).toContain("The first host reached its rate limit.");
  expect(resumed).toContain(thread);
  expect(await run(site, "status")).toContain(`${request}@${driver}`);

  await run(site, "result", thread, request, "--from", driver, "--body", "Replacement completed the handoff.");
  expect(await run(site, "status")).not.toContain("waiting:");
});

test("a coordinator may choose the seat executable at spawn time", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "driver", "receiver", "--worktree", "/tmp/demo-receiver", "--agent", "cat");
  expect(await run(site, "open", "driver.receiver@demo")).toContain("agent: cat");
});

test("task completion retires an idle driver through ATDD Bun housekeeping", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  const site = join(root, "site");
  await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "test@example.test");
  await git(repository, "config", "user.name", "Test");
  await writeFile(join(repository, ".gitignore"), "node_modules/\n");
  await writeFile(join(repository, "atdd-bun.yaml"), `worktrees:\n  enabled: true\n  root: ../worktrees\n  primary_directory: repository\n  primary_branch: main\n  require_linked_worktree: true\n`);
  await git(repository, "add", ".gitignore", "atdd-bun.yaml");
  await git(repository, "commit", "-m", "configure worktrees");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
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
  await run(site, "spawn", "demo", "coordinator", "main");
  await run(site, "spawn", "demo", "driver", "runtime");
  await mkdir(join(worktrees, "runtime", "node_modules", ".bin"), { recursive: true });
  await symlink(join(import.meta.dir, "..", "node_modules", ".bin", "atdd-bun"), join(worktrees, "runtime", "node_modules", ".bin", "atdd-bun"));
  const coordinator = "coordinator@demo";
  const driver = "driver.runtime@demo";
  await run(site, "task", "add", "demo", "W-runtime", "--title", "Retire runtime", "--coordinator", coordinator, "--assignee", driver, "--done-when", "Delivery branch is merged.");
  await run(site, "task", "start", "demo", "W-runtime", "--by", driver);
  await run(site, "task", "prove", "demo", "W-runtime", "--by", driver, "--item", "1", "--proof", "main already contains delivery/runtime");
  await run(site, "task", "review", "demo", "W-runtime", "--by", driver);
  await run(site, "task", "done", "demo", "W-runtime", "--by", coordinator, "--retire-assignee");
  expect(await run(site, "task", "open", "demo", "W-runtime")).toContain("status: done");
  await expect(stat(join(worktrees, "runtime"))).rejects.toThrow();
  expect(await git(repository, "branch", "--list", "delivery/runtime")).toBe("");
  expect(await run(site, "open", driver)).toContain("status: complete");
  expect(await run(site, "open", driver)).toContain("retired:");
});

test("a coordinator unlocks dependent tasks only after reviewing their proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "plan", "--worktree", "/tmp/demo-plan");
  await run(site, "spawn", "demo", "driver", "api", "--worktree", "/tmp/demo-api");
  const coordinator = "coordinator@demo";
  const planner = "driver.plan@demo";
  const api = "driver.api@demo";

  await run(site, "task", "add", "demo", "W-plan", "--title", "Write the plan", "--coordinator", coordinator, "--assignee", planner, "--body", "A rich task body with implementation context.", "--done-when", "Plan is published.");
  await run(site, "task", "add", "demo", "W-api", "--title", "Build the API", "--coordinator", coordinator, "--assignee", api, "--depends-on", "W-plan", "--done-when", "API checks pass.");
  expect(await run(site, "task", "list", "demo")).toContain("W-api  todo  proof:0/1  Build the API  waiting:W-plan");
  expect(await fail(site, "task", "start", "demo", "W-api", "--by", api)).toContain("waiting on: W-plan");

  await run(site, "task", "start", "demo", "W-plan", "--by", planner);
  expect(await fail(site, "task", "review", "demo", "W-plan", "--by", planner)).toContain("missing proof");
  await run(site, "task", "prove", "demo", "W-plan", "--by", planner, "--item", "1", "--proof", "https://example.test/plan-report");
  await run(site, "task", "review", "demo", "W-plan", "--by", planner);
  expect(await run(site, "task", "open", "demo", "W-plan")).toContain("status: review");
  await run(site, "task", "done", "demo", "W-plan", "--by", coordinator);

  await run(site, "task", "start", "demo", "W-api", "--by", api);
  await run(site, "task", "prove", "demo", "W-api", "--by", api, "--item", "1", "--proof", "CI run 42: passed");
  await run(site, "task", "review", "demo", "W-api", "--by", api);
  await run(site, "task", "return", "demo", "W-api", "--by", coordinator);
  expect(await run(site, "task", "open", "demo", "W-api")).toContain("status: in_progress");
});

test("a task can preserve an exact source body through the canonical amend command", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "task", "add", "demo", "W-source", "--title", "Imported slice", "--coordinator", "coordinator@demo", "--body", "Temporary projection", "--done-when", "Coordinator accepts evidence.");
  await run(site, "task", "amend", "demo", "W-source", "--body", "Exact source wording.", "--source", "repo@sha:docs/program.adoc#row-42");
  const task = await run(site, "task", "open", "demo", "W-source");
  expect(task).toContain("body: Exact source wording.");
  expect(task).toContain("repo@sha:docs/program.adoc#row-42");
});
