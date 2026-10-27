// URN: test:flow:assignment-dispatch:E018-UNIT-001
// Acceptance: acc:flow:E018-UNIT-001
// Phase: UNIT
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatRuntimeState, registerRuntimeState } from "../src/runtime-state";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const coordinator = "coordinator@demo";
const driver = "driver.delivery@demo";
const startCommand = `atdd-flow task start demo delivery --by ${driver}`;

async function fixture(options: { nativeQueue?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-assignment-dispatch-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, "threads"), { recursive: true }),
    mkdir(join(root, "work", "demo", "tasks"), { recursive: true }),
    mkdir(join(root, "work", "demo", "seats", "coordinator"), { recursive: true }),
    mkdir(join(root, "work", "demo", "seats", "driver.delivery"), { recursive: true }),
  ]);
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await writeFile(join(root, "work", "demo", "project.yaml"), "schema: atdd-workflow/project/v1\nproject: demo\n");
  await writeFile(join(root, "work", "demo", "seats", "coordinator", "seat.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/seat/v2", address: coordinator, role: "coordinator", project: "demo", worktree: "/tmp/coordinator", branch: "main",
  }));
  // A Pi-designated, offline assignee owns a durable native inbox queue
  // without any live process; a non-Pi seat without native wake owns none.
  await writeFile(join(root, "work", "demo", "seats", "driver.delivery", "seat.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/seat/v2", address: driver, role: "driver", project: "demo", worktree: "/tmp/delivery", branch: "delivery/test",
    ...(options.nativeQueue === false ? {} : { agent: "pi" }),
  }));
  await writeFile(taskFile(root), Bun.YAML.stringify({
    schema: "atdd-workflow/task/v1", title: "Immediate delivery", status: "todo", coordinator,
    done_when: [{ text: "Delivery works" }],
  }));
  return root;
}

const taskFile = (root: string) => join(root, "work", "demo", "tasks", "delivery.yaml");
const queueDirectory = (root: string) => join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(driver));

async function task(root: string) {
  return Bun.YAML.parse(await readFile(taskFile(root), "utf8")) as Record<string, any>;
}

async function invoke(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "--root", root, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: `${stdout}${stderr}` };
}

async function assignImmediately(root: string) {
  const assigned = await invoke(root, "task", "assign", "demo", "delivery", "--assignee", driver, "--by", coordinator,
    "--immediate", "--priority", "immediate", "--mutation-boundary", "PLAN ONLY");
  expect(assigned.code, assigned.output).toBe(0);
  const dispatch = (await task(root)).immediate_dispatch as { thread: string; message: string };
  return { ...dispatch, output: assigned.output };
}

async function threadMessages(root: string, thread: string) {
  return (await readdir(join(root, "threads", thread))).filter((file) => file.startsWith("M-")).sort();
}

async function observe(root: string) {
  const observed = await invoke(root, "task", "observe-assignment", "demo", "delivery", "--by", coordinator);
  expect(observed.code, observed.output).toBe(0);
  return (await task(root)).immediate_dispatch;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("RED: immediate assignment enqueues the exact dispatch M-id in the assignee native queue with the exact assignee-only start command", async () => {
  const root = await fixture();
  const { thread, message } = await assignImmediately(root);

  const record = await task(root);
  expect(record.status).toBe("todo");
  expect(record.assignee).toBe(driver);
  expect(record.immediate_dispatch).toMatchObject({
    thread: expect.stringMatching(/^T-/), message: expect.stringMatching(/^M-/),
    priority: "immediate", mutation_boundary: "PLAN ONLY", assignee: driver, status: "dispatched",
  });
  expect(record.immediate_dispatch.acknowledgement).toBeUndefined();
  expect(record.immediate_dispatch.start).toBeUndefined();

  const dispatch = Bun.YAML.parse(await readFile(join(root, "threads", thread, `${message}.yaml`), "utf8")) as Record<string, any>;
  expect(dispatch).toMatchObject({ id: message, from: coordinator, to: [driver] });
  expect(dispatch.body).toContain("demo/delivery");
  expect(dispatch.body).toContain("immediate");
  expect(dispatch.body).toContain("PLAN ONLY");
  expect(dispatch.body).toContain(startCommand);

  const queue = Bun.YAML.parse(await readFile(join(queueDirectory(root), "queue.yaml"), "utf8")) as { head: string };
  const segment = Bun.YAML.parse(await readFile(join(queueDirectory(root), "pending", `${queue.head}.yaml`), "utf8")) as { entries: { thread: string; message: string }[] };
  expect(segment.entries.filter((entry) => entry.message === message)).toEqual([expect.objectContaining({ thread, message })]);
});

test("RED: receipts, generic ACK/Canary messages, and runtime heartbeats cannot create an acknowledgement", async () => {
  const root = await fixture();
  const { thread, message } = await assignImmediately(root);

  for (const args of [
    ["receipt", thread, message, "--from", driver, "--body", "ACK"],
    ["post", thread, "--from", driver, "--to", coordinator, "--body", "Canary"],
    ["post", thread, "--from", driver, "--to", coordinator, "--body", `ACK ${message}`],
  ]) {
    const posted = await invoke(root, ...args);
    expect(posted.code, posted.output).toBe(0);
  }
  const owner = "owner-token";
  await registerRuntimeState(root, { seat: driver, owner_token: owner, pid: process.pid, model: "test/model", cwd: root });
  await heartbeatRuntimeState(root, driver, owner);

  expect((await task(root)).immediate_dispatch.acknowledgement).toBeUndefined();
  expect((await observe(root)).alerts).toEqual({
    missing_acknowledgement: expect.objectContaining({ key: `${message}/missing_acknowledgement` }),
  });
});

test("RED: unacknowledged and acknowledged-but-TODO dispatches each raise exactly one native alert", async () => {
  const root = await fixture();
  const { thread, message } = await assignImmediately(root);
  const dispatchOnly = await threadMessages(root, thread);

  const first = await observe(root);
  const missingAck = first.alerts.missing_acknowledgement;
  expect(structuredClone(missingAck)).toMatchObject({ key: `${message}/missing_acknowledgement`, message: expect.stringMatching(/^M-/), observed_at: expect.any(String) });
  expect(first.alerts.missing_start).toBeUndefined();
  expect(await threadMessages(root, thread)).toEqual([...dispatchOnly, `${missingAck.message}.yaml`].sort());
  const alert = Bun.YAML.parse(await readFile(join(root, "threads", thread, `${missingAck.message}.yaml`), "utf8")) as Record<string, any>;
  expect(alert).toMatchObject({ from: coordinator, to: [driver] });
  const queued = await readdir(join(queueDirectory(root), "pending"));
  const entries = (await Promise.all(queued.map(async (file) => (Bun.YAML.parse(await readFile(join(queueDirectory(root), "pending", file), "utf8")) as { entries: { message: string }[] }).entries))).flat();
  expect(entries.map((entry) => entry.message)).toContain(missingAck.message);

  const repeated = await observe(root);
  expect(repeated.alerts).toEqual(first.alerts);
  expect(await threadMessages(root, thread)).toHaveLength(dispatchOnly.length + 1);

  const acknowledged = await invoke(root, "task", "acknowledge", "demo", "delivery", "--dispatch", message, "--by", driver);
  expect(acknowledged.code, acknowledged.output).toBe(0);
  const afterAck = await observe(root);
  expect(afterAck.alerts.missing_acknowledgement).toEqual(missingAck);
  expect(structuredClone(afterAck.alerts.missing_start)).toMatchObject({ key: `${message}/missing_start`, message: expect.stringMatching(/^M-/), observed_at: expect.any(String) });
  expect(await threadMessages(root, thread)).toHaveLength(dispatchOnly.length + 2);

  expect((await observe(root)).alerts).toEqual(afterAck.alerts);
  expect(await threadMessages(root, thread)).toHaveLength(dispatchOnly.length + 2);

  const started = await invoke(root, "task", "start", "demo", "delivery", "--by", driver);
  expect(started.code, started.output).toBe(0);
  expect((await observe(root)).alerts).toEqual(afterAck.alerts);
  expect(await threadMessages(root, thread)).toHaveLength(dispatchOnly.length + 2);
});

test("RED: acknowledgement is bound to the exact dispatch and assignee, idempotent, immutable, and distinct from start", async () => {
  const root = await fixture();
  const { message } = await assignImmediately(root);

  const acknowledged = await invoke(root, "task", "acknowledge", "demo", "delivery", "--dispatch", message, "--by", driver);
  expect(acknowledged.code, acknowledged.output).toBe(0);
  const first = await task(root);
  expect(first.status).toBe("todo");
  expect(first.immediate_dispatch.acknowledgement).toEqual({ dispatch: message, by: driver, acknowledged_at: expect.any(String) });
  expect(first.immediate_dispatch.start).toBeUndefined();
  const persisted = await readFile(taskFile(root), "utf8");

  await Bun.sleep(5);
  const repeated = await invoke(root, "task", "acknowledge", "demo", "delivery", "--dispatch", message, "--by", driver);
  expect(repeated.code, repeated.output).toBe(0);
  expect(await readFile(taskFile(root), "utf8")).toBe(persisted);

  const wrongMessage = await invoke(root, "task", "acknowledge", "demo", "delivery", "--dispatch", "M-20261011T000000Z-other_00000000", "--by", driver);
  expect(wrongMessage.code).not.toBe(0);
  const wrongActor = await invoke(root, "task", "acknowledge", "demo", "delivery", "--dispatch", message, "--by", coordinator);
  expect(wrongActor.code).not.toBe(0);
  expect(await readFile(taskFile(root), "utf8")).toBe(persisted);

  const started = await invoke(root, "task", "start", "demo", "delivery", "--by", driver);
  expect(started.code, started.output).toBe(0);
  const afterStart = await task(root);
  expect(afterStart.status).toBe("in_progress");
  expect(afterStart.immediate_dispatch.start).toEqual({ by: driver, transitioned_at: expect.any(String) });
  expect(afterStart.immediate_dispatch.acknowledgement).toEqual(first.immediate_dispatch.acknowledgement);
});

test("RED: start without acknowledgement records start evidence but never fabricates an acknowledgement", async () => {
  const root = await fixture();
  const { message } = await assignImmediately(root);

  const started = await invoke(root, "task", "start", "demo", "delivery", "--by", driver);
  expect(started.code, started.output).toBe(0);
  const record = await task(root);
  expect(record.immediate_dispatch.start).toEqual({ by: driver, transitioned_at: expect.any(String) });
  expect(record.immediate_dispatch.acknowledgement).toBeUndefined();
  expect((await observe(root)).alerts).toEqual({
    missing_acknowledgement: expect.objectContaining({ key: `${message}/missing_acknowledgement` }),
  });
});

test("RED: an assignee without a native queue yields no dispatched or delivered claim and no persisted dispatch", async () => {
  const root = await fixture({ nativeQueue: false });
  const before = await readFile(taskFile(root), "utf8");

  const assigned = await invoke(root, "task", "assign", "demo", "delivery", "--assignee", driver, "--by", coordinator,
    "--immediate", "--priority", "immediate", "--mutation-boundary", "PLAN ONLY");
  expect(assigned.code).not.toBe(0);
  expect(assigned.output).toMatch(/native/i);
  expect(assigned.output).not.toMatch(/\bdispatched\b|\bdelivered\b/i);
  expect(await readFile(taskFile(root), "utf8")).toBe(before);
  expect(await readdir(join(root, "threads"))).toEqual([]);
  expect(await Bun.file(join(queueDirectory(root), "queue.yaml")).exists()).toBe(false);
});

test("guard: plain assignment without --immediate keeps today's behavior and creates no dispatch", async () => {
  const root = await fixture();
  const assigned = await invoke(root, "task", "assign", "demo", "delivery", "--assignee", driver, "--by", coordinator);
  expect(assigned.code, assigned.output).toBe(0);
  const record = await task(root);
  expect(record.assignee).toBe(driver);
  expect(record.immediate_dispatch).toBeUndefined();
  expect(await readdir(join(root, "threads"))).toEqual([]);
});
