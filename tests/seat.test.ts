import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAddress, launchCommand, launchedAddress, notificationCommand } from "../src/adapters";
import { atomicYaml } from "../src/core";
import { addressedTo, createInboxReconciler, mailNotice } from "../extensions/pi/index";
import { isPiExecutable, launchNotice, piLaunchArgs, resolveExecutable } from "../src/seats";
import { enqueueNativeMail } from "../src/threads";
import { parse } from "yaml";

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
  await stat(join(site, "desk.yaml"));
  await stat(join(site, "work", "demo", "project.yaml"));
  await stat(join(site, "work", "demo", "seats", "driver.runtime", "seat.yaml"));
  expect(await run(site, "open", "driver.runtime@demo")).toContain("Own the runtime rollout.");
  const thread = await run(site, "thread", "start", "--with", "coordinator@demo,driver.runtime@demo", "--subject", "Runtime rollout");
  const request = await run(site, "post", thread, "--from", "coordinator@demo", "--to", "driver.runtime@demo", "--expects-result", "--body", "Run checks");

  await run(site, "receipt", thread, request, "--from", "driver.runtime@demo");
  expect(await run(site, "status", "--all")).toContain(`waiting:${request}`);

  await run(site, "result", thread, request, "--from", "driver.runtime@demo", "--body", "Checks pass");
  expect(await run(site, "status")).not.toContain("waiting:");
});

test("a message can be read directly without opening its entire thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "runtime", "--worktree", "/tmp/demo-runtime");
  const thread = await run(site, "thread", "start", "--with", "coordinator@demo,driver.runtime@demo", "--subject", "Direct mail");
  const first = await run(site, "post", thread, "--from", "coordinator@demo", "--to", "driver.runtime@demo", "--body", "Read only this message.");
  await run(site, "post", thread, "--from", "coordinator@demo", "--to", "driver.runtime@demo", "--body", "Do not include this message.");

  const output = await run(site, "message", "read", first);
  expect(output).toContain("schema: atdd-workflow/message-read/v1");
  expect(output).toContain(`id: ${thread}`);
  expect(output).toContain("Read only this message.");
  expect(output).not.toContain("Do not include this message.");
  expect(await fail(site, "message", "read", "M-missing")).toContain("does not exist");

  const duplicate = await readFile(join(site, "threads", thread, `${first}.yaml`), "utf8");
  const other = await run(site, "thread", "start", "--with", "coordinator@demo,driver.runtime@demo", "--subject", "Duplicate id");
  await writeFile(join(site, "threads", other, `${first}.yaml`), duplicate);
  expect(await fail(site, "message", "read", first)).toContain("ambiguous across threads");
});

test("durable inbox reconciliation recovers missed mail without duplicate delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "pi", "--worktree", "/tmp/demo-pi");
  const seat = "driver.pi@demo";
  await run(site, "bind", seat, "--application", "herdr", "--address", "w-test:p-native", "--wake", "native");
  const thread = await run(site, "thread", "start", "--with", `coordinator@demo,${seat}`, "--subject", "Durable inbox");
  const first = await run(site, "post", thread, "--from", "coordinator@demo", "--to", seat, "--body", "Missed while Pi was offline.");
  const delivered: string[] = [];
  const initial = createInboxReconciler({ root: site, seat, deliver: async (mail) => { delivered.push(mail.id as string); } });
  await initial.reconcile();
  expect(delivered).toEqual([first]);

  const second = await run(site, "post", thread, "--from", "coordinator@demo", "--to", seat, "--body", "Reject once.");
  const third = await run(site, "post", thread, "--from", "coordinator@demo", "--to", seat, "--body", "Deliver after the retry.");
  const failed = createInboxReconciler({ root: site, seat, batchSize: 2, deliver: async (mail) => {
    if (mail.id === second) throw new Error("Pi rejected delivery");
    delivered.push(mail.id as string);
  } });
  await failed.reconcile();
  expect(delivered).toEqual([first]);

  const restarted = createInboxReconciler({ root: site, seat, batchSize: 2, deliver: async (mail) => { delivered.push(mail.id as string); } });
  await restarted.reconcile();
  await restarted.reconcile();
  expect(delivered).toEqual([first, second, third]);

  const delayedThread = await run(site, "thread", "start", "--with", `coordinator@demo,${seat}`, "--subject", "Delayed first mail");
  const delayed = await run(site, "post", delayedThread, "--from", "coordinator@demo", "--to", seat, "--body", "Created first but hidden.");
  const delayedFile = join(site, "threads", delayedThread, `${delayed}.yaml`);
  const hiddenFile = join(site, "threads", delayedThread, `.${delayed}.hidden`);
  await rename(delayedFile, hiddenFile);
  const laterThread = await run(site, "thread", "start", "--with", `coordinator@demo,${seat}`, "--subject", "Visible later mail");
  const later = await run(site, "post", laterThread, "--from", "coordinator@demo", "--to", seat, "--body", "Visible while the first mail is hidden.");
  await restarted.reconcile();
  await rename(hiddenFile, delayedFile);
  await restarted.reconcile();
  expect(delivered).toEqual([first, second, third, delayed, later]);
  expect(await Bun.file(join(site, ".atdd-flow", "pi-inbox", "driver.pi%40demo", "pending", `${later}.yaml`)).exists()).toBe(false);
});

test("a Pi-designated unbound seat queues ordered native mail in bounded segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "offline", "--worktree", "/tmp/demo-offline");
  const seat = "driver.offline@demo";
  await run(site, "bind", seat, "--application", "herdr", "--address", "w-test:p-offline", "--agent", "pi", "--wake", "native");
  const seatPath = join(site, "work", "demo", "seats", "driver.offline", "seat.yaml");
  await writeFile(seatPath, (await readFile(seatPath, "utf8")).replace(/\nruntime:[\s\S]*$/, "\n"));
  const thread = await run(site, "thread", "start", "--with", `coordinator@demo,${seat}`, "--subject", "Offline Pi inbox");
  const expected: string[] = [];
  for (let index = 0; index < 33; index += 1) {
    expected.push(await run(site, "post", thread, "--from", "coordinator@demo", "--to", seat, "--body", `Queued ${index}`));
  }
  const delivered: string[] = [];
  const inbox = createInboxReconciler({ root: site, seat, batchSize: 32, deliver: async (mail) => { delivered.push(mail.id); } });
  await inbox.reconcile();
  expect(delivered).toEqual(expected.slice(0, 32));
  await inbox.reconcile();
  expect(delivered).toEqual(expected);
});

test("concurrent native posts survive queue rollover without losing references", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "pi", "--worktree", "/tmp/demo-pi");
  const seat = "driver.pi@demo";
  await run(site, "bind", seat, "--application", "herdr", "--address", "w-test:p-native", "--wake", "native");
  const thread = await run(site, "thread", "start", "--with", `coordinator@demo,${seat}`, "--subject", "Concurrent inbox");
  const posted = await Promise.all(Array.from({ length: 40 }, (_, index) => run(site, "post", thread, "--from", "coordinator@demo", "--to", seat, "--body", `Concurrent ${index}`)));
  const delivered: string[] = [];
  const inbox = createInboxReconciler({ root: site, seat, batchSize: 32, deliver: async (mail) => { delivered.push(mail.id); } });
  await inbox.reconcile();
  await inbox.reconcile();
  expect(delivered).toHaveLength(40);
  expect(new Set(delivered)).toEqual(new Set(posted));
  const expected = (await Promise.all(posted.map(async (id) => ({ id, created_at: (parse(await readFile(join(site, "threads", thread, `${id}.yaml`), "utf8")) as { created_at: string }).created_at })))).sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)).map(({ id }) => id);
  expect(delivered).toEqual(expected);
});

test("a failed rollover child write leaves later native mail recoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "pi", "--worktree", "/tmp/demo-pi");
  const seat = "driver.pi@demo";
  await run(site, "bind", seat, "--application", "herdr", "--address", "w-test:p-native", "--wake", "native");
  const thread = await run(site, "thread", "start", "--with", `coordinator@demo,${seat}`, "--subject", "Rollover write failure");
  const posted: string[] = [];
  for (let index = 0; index < 32; index += 1) {
    posted.push(await run(site, "post", thread, "--from", "coordinator@demo", "--to", seat, "--body", `Queued ${index}`));
  }
  const inbox = join(site, ".atdd-flow", "pi-inbox", encodeURIComponent(seat));
  const failedMessage = "M-crashed-rollover";
  const failedChild = join(inbox, "pending", `S-${failedMessage}.yaml`);
  // This throw models a process crash or storage failure while the new child is
  // written. The parent must remain unlinked and therefore reachable mail stays intact.
  await expect(enqueueNativeMail(site, seat, { thread, message: failedMessage, created_at: "9999-12-31T23:59:59.999Z" }, async (path, value) => {
    if (path === failedChild) throw new Error("simulated child segment write failure");
    await atomicYaml(path, value);
  })).rejects.toThrow("simulated child segment write failure");
  expect(await readFile(join(inbox, "pending", `S-${posted[0]}.yaml`), "utf8")).not.toContain("next:");

  const later = await run(site, "post", thread, "--from", "coordinator@demo", "--to", seat, "--body", "Must recover after rollover failure.");
  const delivered: string[] = [];
  const restarted = createInboxReconciler({ root: site, seat, batchSize: 32, deliver: async (mail) => { delivered.push(mail.id); } });
  await restarted.reconcile();
  await restarted.reconcile();
  expect(delivered).toHaveLength(33);
  expect(new Set(delivered)).toEqual(new Set([...posted, later]));
  expect(delivered).toContain(later);
});

test("an incomplete inbox intent never delivers or blocks later durable mail", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "pi", "--worktree", "/tmp/demo-pi");
  const seat = "driver.pi@demo";
  await run(site, "bind", seat, "--application", "herdr", "--address", "w-test:p-native", "--wake", "native");
  const thread = await run(site, "thread", "start", "--with", `coordinator@demo,${seat}`, "--subject", "Orphan intent");
  const inboxRoot = join(site, ".atdd-flow", "pi-inbox", encodeURIComponent(seat));
  await mkdir(join(inboxRoot, "pending"), { recursive: true });
  await writeFile(join(inboxRoot, "queue.yaml"), "schema: atdd-flow/pi-inbox-queue/v1\nhead: S-orphan\ntail: S-orphan\n");
  await writeFile(join(inboxRoot, "pending", "S-orphan.yaml"), `schema: atdd-flow/pi-inbox-segment/v1\nentries:\n  - thread: ${thread}\n    message: M-orphan\n    created_at: ${new Date().toISOString()}\n    published: false\n`);
  const later = await run(site, "post", thread, "--from", "coordinator@demo", "--to", seat, "--body", "Must survive the orphan.");
  // Simulate a crash after authoritative M persistence but before the advisory publish marker write.
  await writeFile(join(inboxRoot, "pending", "S-orphan.yaml"), (await readFile(join(inboxRoot, "pending", "S-orphan.yaml"), "utf8")).replace("published: true", "published: false"));
  const delivered: string[] = [];
  const restarted = createInboxReconciler({ root: site, seat, deliver: async (mail) => { delivered.push(mail.id); } });
  await restarted.reconcile();
  await restarted.reconcile();
  expect(delivered).toEqual([later]);
  expect(delivered).not.toContain("M-orphan");
});

test("an operator can initialize a standalone Desk Git repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const coordination = join(root, "desk");

  await run(root, "init", coordination, "--git");

  await stat(join(coordination, ".git"));
  const config = await readFile(join(coordination, "desk.yaml"), "utf8");
  expect(config).toContain("atdd-workflow/desk/v1");
  expect(config).toContain("application: herdr");
  expect(config).toContain("executables:");
  expect(config).toContain("pi: pi");
  expect(config).not.toContain("claude:");
  expect(config).not.toContain("codex:");
  const models = await readFile(join(coordination, "models.yaml"), "utf8");
  expect(models).toContain("atdd-workflow/models/v1");
  expect(models).toContain("id: pi");
  expect(models).toContain("executable: pi");
  expect(models).not.toContain("executable: claude");
  expect(models).not.toContain("executable: codex");
});

test("initialization refuses to overwrite an existing Desk registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const coordination = join(root, "desk");

  await run(root, "init", coordination);
  const original = await readFile(join(coordination, "desk.yaml"), "utf8");

  expect(await fail(root, "init", coordination)).toContain("refusing to overwrite");
  expect(await readFile(join(coordination, "desk.yaml"), "utf8")).toBe(original);
});

test("a legacy coordination registry upgrades to a Desk without changing its aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const registry = join(root, "legacy");
  await mkdir(registry, { recursive: true });
  await writeFile(join(registry, "coordination.yaml"), `schema: atdd-workflow/coordination/v2
site: legacy
application: herdr
aliases:
  coordinator@old: coordinator@demo
`);

  await run(registry, "desk", "migrate");
  const config = await readFile(join(registry, "desk.yaml"), "utf8");
  expect(config).toContain("schema: atdd-workflow/desk/v1");
  expect(config).toContain("desk: legacy");
  expect(config).toContain("coordinator@old: coordinator@demo");
});

test("a migration can record a completed task from authoritative proof without inventing a driver", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "task", "add", "demo", "legacy-delivery", "--title", "Legacy delivery", "--coordinator", "coordinator@demo", "--done-when", "Merged PR evidence is recorded.");

  await run(site, "task", "import", "demo", "legacy-delivery", "--source", "https://example.test/pull/42", "--proof", "https://example.test/pull/42");

  const record = await run(site, "task", "open", "demo", "legacy-delivery");
  expect(record).toContain("status: done");
  expect(record).toContain("https://example.test/pull/42");
  expect(record).not.toContain("assignee:");
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
  expect(await run(site, "status", "--all")).toContain(`${request}@driver.two@demo`);
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

test("a driver routes through its coordinator and replies only to the requesting seat", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "project", "init", "desk");
  await writeFile(join(site, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
roles:
  main:
    address: main@{project}
    branch: main
    worktree: /tmp/demo-main
  coordinator:
    address: coordinator@{project}
    branch: main
    worktree: /tmp/demo-main
  driver:
    address: driver.{name}@{project}
    branch: delivery/{name}
    worktree: /tmp/demo-{name}
`);
  await writeFile(join(site, "work", "desk", "project.yaml"), `schema: atdd-workflow/project/v1
project: desk
roles:
  operator:
    address: operator@{project}
    branch: main
    worktree: /tmp/desk
`);
  await run(site, "spawn", "demo", "main", "main");
  await run(site, "spawn", "demo", "coordinator", "main");
  await run(site, "spawn", "demo", "driver", "one");
  await run(site, "spawn", "desk", "operator", "desk");

  const thread = await run(site, "thread", "start", "--with", "operator@desk,main@demo,coordinator@demo,driver.one@demo", "--subject", "Routing");
  expect(await fail(site, "post", thread, "--from", "driver.one@demo", "--to", "operator@desk", "--body", "Escalate.")).toContain("may not directly address operator@desk");
  expect(await fail(site, "post", thread, "--from", "driver.one@demo", "--to", "main@demo", "--body", "Escalate.")).toContain("may message only a coordinator");
  await run(site, "post", thread, "--from", "driver.one@demo", "--to", "coordinator@demo", "--body", "Blocked on a shared decision.");
  await run(site, "post", thread, "--from", "main@demo", "--to", "operator@desk", "--body", "Integration decision needed.");
  await run(site, "post", thread, "--from", "coordinator@demo", "--to", "operator@desk", "--body", "Incident escalation.");

  const request = await run(site, "post", thread, "--from", "coordinator@demo", "--to", "driver.one@demo", "--expects-result", "--body", "Return evidence.");
  const receipt = await run(site, "receipt", thread, request, "--from", "driver.one@demo");
  const receiptRecord = await readFile(join(site, "threads", thread, `${receipt}.yaml`), "utf8");
  expect(receiptRecord).toContain("to: [coordinator@demo]");
  expect(receiptRecord).not.toContain("operator@desk");
  expect(receiptRecord).not.toContain("main@demo");
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

  await run(site, "bind", driver, "--application", "tmux", "--address", "workflow:old-driver-pane");
  await run(site, "receipt", thread, request, "--from", driver, "--body", "Received; beginning work.");
  await run(site, "checkpoint", driver, "--status", "blocked", "--summary", "Rate limit reached after receiving the rollout request.", "--next", "Replacement agent should finish the rollout and post the result.");

  // The coordinator replaces a rate-limited agent. The address—and therefore
  // its durable thread history and responsibility—does not change.
  await run(site, "bind", driver, "--application", "tmux", "--address", "workflow:replacement-driver-pane");
  const resumedSeat = await run(site, "open", driver);
  expect(resumedSeat).toContain("tmux: workflow:replacement-driver-pane");
  expect(resumedSeat).toContain("application: tmux");
  expect(resumedSeat).toContain(thread);
  expect(resumedSeat).toContain("Rate limit reached after receiving the rollout request.");
  expect(await readFile(join(site, "threads", thread, `${request}.yaml`), "utf8")).toContain("Finish the rollout after takeover.");
  expect(await run(site, "status", "--all")).toContain(`${request}@${driver}`);

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
  await writeFile(join(site, "desk.yaml"), `schema: atdd-workflow/desk/v1
desk: site
application: herdr
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
  expect(() => discoverAddress("herdr", {})).toThrow("HERDR_PANE_ID");
  expect(() => discoverAddress("claude", {})).toThrow("No deterministic discovery adapter");
  expect(notificationCommand("herdr", "w1:p2", "read mail", "forge")).toEqual(["herdr", "--session", "forge", "agent", "prompt", "w1:p2", "read mail"]);
  expect(addressedTo({ from: "coordinator@demo", to: ["driver.pi@demo"] }, { participants: ["coordinator@demo", "driver.pi@demo"] }, "driver.pi@demo")).toBe(true);
  expect(addressedTo({ from: "coordinator@demo", to: "all" }, { participants: ["coordinator@demo", "driver.pi@demo"] }, "driver.pi@demo")).toBe(true);
  expect(addressedTo({ from: "driver.pi@demo", to: "all" }, { participants: ["coordinator@demo", "driver.pi@demo"] }, "driver.pi@demo")).toBe(false);
  expect(mailNotice("T-thread", { id: "M-message", from: "coordinator@demo", to: ["driver.pi@demo"], subject: "Compact mail" })).toBe("SYSTEM: Flow mail M-message | thread T-thread (Compact mail) | coordinator@demo → driver.pi@demo. Read: atdd-flow message read M-message");
});

test("a Desk executable declaration resolves a named seat agent for every launch", () => {
  expect(resolveExecutable({ schema: "atdd-workflow/desk/v1", desk: "site", application: "herdr", executables: {
    claude: "claude",
    codex: "/opt/homebrew/bin/codex",
    pi: "pi",
    kimi: "kimi",
  } }, "codex")).toBe("/opt/homebrew/bin/codex");
  expect(resolveExecutable({ schema: "atdd-workflow/desk/v1", desk: "legacy", application: "herdr" }, "custom-agent")).toBe("custom-agent");
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
  const notice = await readFile(notificationLog, "utf8");
  expect(notice).toContain(`agent\nprompt\nw-test:p-old\nSYSTEM: Flow mail ${request}`);
  expect(notice).toContain(`thread ${thread} (Host-attached handoff)`);
  expect(notice).toContain(`Read: atdd-flow message read ${request}`);
  await run(site, "receipt", thread, request, "--from", driver);
  await run(site, "checkpoint", driver, "--status", "blocked", "--summary", "The first host reached its rate limit.", "--next", "Replacement host must complete the handoff.");

  await runWithEnvironment(site, host("w-test:p-replacement"), "attach", driver, "--application", "herdr");
  const resumed = await run(site, "open", driver);
  expect(resumed).toContain("herdr: w-test:p-replacement");
  expect(resumed).toContain("The first host reached its rate limit.");
  expect(resumed).toContain(thread);
  expect(await run(site, "status", "--all")).toContain(`${request}@${driver}`);

  await run(site, "result", thread, request, "--from", driver, "--body", "Replacement completed the handoff.");
  expect(await run(site, "status")).not.toContain("waiting:");
});

test("a native-wake runtime keeps durable mail but skips host text injection", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "coordination");
  const bin = join(root, "bin");
  const notificationLog = join(root, "herdr-notifications.txt");
  const fakeHerdr = join(bin, "herdr");
  await mkdir(bin);
  await writeFile(fakeHerdr, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${notificationLog}'\n`);
  await chmod(fakeHerdr, 0o755);
  const host = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, HERDR_PANE_ID: "w-test:p-native" };

  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "pi", "--worktree", "/tmp/demo-pi");
  const coordinator = "coordinator@demo";
  const driver = "driver.pi@demo";
  await runWithEnvironment(site, host, "attach", driver, "--application", "herdr", "--wake", "native");

  const thread = await run(site, "thread", "start", "--with", `${coordinator},${driver}`, "--subject", "Native wake");
  const message = await run(site, "post", thread, "--from", coordinator, "--to", driver, "--body", "Read native mail.");
  expect(await Bun.file(join(site, "threads", thread, `${message}.yaml`)).exists()).toBe(true);
  expect(await Bun.file(notificationLog).exists()).toBe(false);
  expect(await run(site, "open", driver)).toContain("wake: native");
});

test("binding an existing seat may update its legacy launch agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await rm(join(site, "models.yaml"));
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "driver", "receiver", "--worktree", "/tmp/demo-receiver");

  const replacement = join(root, "replacement-worktree");
  await mkdir(replacement);
  await run(site, "bind", "driver.receiver@demo", "--application", "herdr", "--address", "w-test:p-pi", "--agent", "pi", "--worktree", replacement, "--wake", "native");

  const opened = await run(site, "open", "driver.receiver@demo");
  expect(opened).toContain("agent: pi");
  expect(opened).toContain(`worktree: ${replacement}`);
  expect(opened).toContain("wake: native");
});

test("legacy Desks may still pin a seat executable when no model portfolio exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await rm(join(site, "models.yaml"));
  await run(site, "project", "init", "demo");
  expect(await readFile(join(site, "work", "demo", "project.yaml"), "utf8")).toContain("agent: pi");
  await run(site, "spawn", "demo", "driver", "receiver", "--worktree", "/tmp/demo-receiver", "--agent", "cat");
  expect(await run(site, "open", "driver.receiver@demo")).toContain("agent: cat");
});

test("portfolio Desks reject static model pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  expect(await fail(site, "spawn", "demo", "driver", "receiver", "--worktree", "/tmp/demo-receiver", "--agent", "cat")).toContain("models.yaml owns model allocation");
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

test("status gives an operator one view of seats, tasks, and threads", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "runtime", "--worktree", "/tmp/demo-runtime");
  await run(site, "task", "add", "demo", "W-runtime", "--title", "Run runtime work", "--coordinator", "coordinator@demo", "--assignee", "driver.runtime@demo", "--done-when", "Coordinator accepts evidence.");
  const thread = await run(site, "thread", "start", "--with", "coordinator@demo,driver.runtime@demo", "--subject", "Runtime handoff");
  const dashboard = await run(site, "status");
  expect(dashboard).toContain("DESK");
  expect(dashboard).toContain("WORKSTREAM");
  expect(dashboard).toContain("atdd-flow task open demo W-runtime");
  const projectDashboard = await run(site, "status", "project", "demo");
  expect(projectDashboard).toContain("DESK / demo");
  expect(projectDashboard).toContain("WORKSTREAM");
  expect(await run(site, "status", "task", "demo", "W-runtime")).toContain("TASK / demo/W-runtime");
  expect(await run(site, "status", "seat", "driver.runtime@demo")).toContain("SEAT / driver.runtime@demo");
  expect(await run(site, "status", "thread", thread)).toContain("THREAD / ");
  expect(await run(site, "thread", "open", thread)).toContain("Runtime handoff");
  const output = await run(site, "status", "project", "demo", "--all");
  expect(output).toContain("SEATS");
  expect(output).toContain("driver.runtime@demo");
  expect(output).toContain("TASKS");
  expect(output).toContain("demo/W-runtime  todo");
  expect(output).toContain("THREADS");
  expect(output).toContain("Runtime handoff");
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


test("only a task coordinator can atomically assign an unassigned todo task", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "one", "--worktree", "/tmp/demo-one");
  await run(site, "spawn", "demo", "driver", "two", "--worktree", "/tmp/demo-two");
  const coordinator = "coordinator@demo";
  const firstDriver = "driver.one@demo";
  const secondDriver = "driver.two@demo";
  await run(site, "task", "add", "demo", "W-staff", "--title", "Staff delivery", "--coordinator", coordinator, "--body", "Preserve this body.", "--source", "repo@sha:program#row", "--done-when", "Coordinator accepts evidence.");
  const before = Bun.YAML.parse(await readFile(join(site, "work", "demo", "tasks", "W-staff.yaml"), "utf8"));

  expect(await run(site, "--help")).toContain("task assign <project> <task-id> --assignee <address> --by <coordinator-address>");
  expect(await fail(site, "task", "assign", "demo", "W-staff", "--assignee", firstDriver, "--by", firstDriver)).toContain(`Only ${coordinator} may assign`);
  expect(await fail(site, "task", "assign", "demo", "W-staff", "--assignee", "driver.missing@demo", "--by", coordinator)).toContain("ENOENT");
  expect(Bun.YAML.parse(await readFile(join(site, "work", "demo", "tasks", "W-staff.yaml"), "utf8"))).toEqual(before);

  expect(await run(site, "task", "assign", "demo", "W-staff", "--assignee", firstDriver, "--by", coordinator)).toBe(`W-staff  assigned  ${firstDriver}`);
  expect(Bun.YAML.parse(await readFile(join(site, "work", "demo", "tasks", "W-staff.yaml"), "utf8"))).toEqual({ ...before, assignee: firstDriver });
  expect(await fail(site, "task", "assign", "demo", "W-staff", "--assignee", secondDriver, "--by", coordinator)).toContain(`already assigned to ${firstDriver}`);

  await run(site, "task", "start", "demo", "W-staff", "--by", firstDriver);
  expect(await fail(site, "task", "assign", "demo", "W-staff", "--assignee", secondDriver, "--by", coordinator)).toContain("can only be assigned while todo");
});

test("only a task coordinator can clear an in-progress blocker without changing task state", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(site, "spawn", "demo", "driver", "runtime", "--worktree", "/tmp/demo-runtime");
  const coordinator = "coordinator@demo";
  const driver = "driver.runtime@demo";
  await run(site, "task", "add", "demo", "W-prerequisite", "--title", "Finished prerequisite", "--coordinator", coordinator, "--done-when", "Historic proof.");
  await run(site, "task", "import", "demo", "W-prerequisite", "--proof", "https://example.test/prerequisite");
  await run(site, "task", "add", "demo", "W-unblock", "--title", "Blocked delivery", "--coordinator", coordinator, "--assignee", driver, "--body", "Preserve this body.", "--source", "repo@sha:program#row", "--depends-on", "W-prerequisite", "--done-when", "Coordinator accepts evidence.");
  expect(await fail(site, "task", "unblock", "demo", "W-unblock", "--by", coordinator)).toContain("can only be unblocked while in_progress");
  await run(site, "task", "start", "demo", "W-unblock", "--by", driver);
  await run(site, "task", "prove", "demo", "W-unblock", "--by", driver, "--item", "1", "--proof", "CI run 42");
  await run(site, "task", "block", "demo", "W-unblock", "--by", driver, "--reason", "Awaiting authorized recovery.");
  const before = Bun.YAML.parse(await readFile(join(site, "work", "demo", "tasks", "W-unblock.yaml"), "utf8"));

  expect(await run(site, "--help")).toContain("task unblock <project> <task-id> --by <coordinator-address>");
  expect(await fail(site, "task", "unblock", "demo", "W-unblock", "--by", driver)).toContain(`Only ${coordinator} may unblock`);
  expect(await run(site, "task", "unblock", "demo", "W-unblock", "--by", coordinator)).toBe("W-unblock  unblocked");
  const { blocker: _blocker, ...expected } = before;
  expect(Bun.YAML.parse(await readFile(join(site, "work", "demo", "tasks", "W-unblock.yaml"), "utf8"))).toEqual(expected);
  expect(await fail(site, "task", "unblock", "demo", "W-unblock", "--by", coordinator)).toContain("has no blocker to clear");

  await run(site, "task", "review", "demo", "W-unblock", "--by", driver);
  expect(await fail(site, "task", "unblock", "demo", "W-unblock", "--by", coordinator)).toContain("can only be unblocked while in_progress");
  await run(site, "task", "done", "demo", "W-unblock", "--by", coordinator);
  expect(await fail(site, "task", "unblock", "demo", "W-unblock", "--by", coordinator)).toContain("can only be unblocked while in_progress");
});

test("new project roles leave model allocation to the Desk portfolio", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-"));
  roots.push(root);
  const site = join(root, "site");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  const project = await readFile(join(site, "work", "demo", "project.yaml"), "utf8");
  expect(project).not.toContain("agent:");
  await run(site, "spawn", "demo", "driver", "runtime", "--worktree", "/tmp/demo-runtime");
  const seat = await readFile(join(site, "work", "demo", "seats", "driver.runtime", "seat.yaml"), "utf8");
  expect(seat).not.toContain("agent:");
});
