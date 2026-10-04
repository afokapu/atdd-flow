import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
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
  await stat(join(site, "workflow.yaml"));
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

  await run(site, "bind", driver, "--pane", "old-driver-pane", "--backend", "tuios");
  await run(site, "receipt", thread, request, "--from", driver, "--body", "Received; beginning work.");
  await run(site, "checkpoint", driver, "--status", "blocked", "--summary", "Rate limit reached after receiving the rollout request.", "--next", "Replacement agent should finish the rollout and post the result.");

  // The coordinator replaces a rate-limited agent. The address—and therefore
  // its durable thread history and responsibility—does not change.
  await run(site, "bind", driver, "--pane", "replacement-driver-pane", "--backend", "tuios");
  const resumedSeat = await run(site, "open", driver);
  expect(resumedSeat).toContain("replacement-driver-pane");
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
  await writeFile(join(site, "workflow.yaml"), `schema: atdd-workflow/site/v1
site: site
backend: tuios
aliases:
  coordinator@DOS-jev: coordinator@decision-os
`);

  await run(site, "checkpoint", "coordinator@DOS-jev", "--status", "unverified", "--summary", "Recovered through the old address.", "--next", "Reconcile current owner.");
  const opened = await run(site, "open", "coordinator@decision-os");
  expect(opened).toContain("Recovered through the old address.");
  expect(opened).toContain("coordinator@decision-os");
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
