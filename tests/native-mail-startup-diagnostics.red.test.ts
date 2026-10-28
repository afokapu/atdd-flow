// URN: test:flow:native-mail-startup-diagnostics
// Acceptance: acc:flow:E010-RED-001
// Phase: UNIT
import { afterEach, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { atomicYaml, paths } from "../src/core";
import installFlowExtension from "../extensions/pi/index";

// Contract under test (RED), task native-mail-startup-canonical-launch-20261028:
// 1 NODE     Pi loads the extension through Node/jiti, where import.meta.dir is undefined; a canonical launch must still send the startup handoff and report no startup failure.
// 2 PHASE    A failing post-activation startup step is reported as 'phase=<name>' with the error stack while the transport stays ACTIVE.
// 3 REPLAY   A fresh successor never re-notifies a reference its predecessor already delivered, delivers genuinely unread mail exactly once, then the new canary.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const seat = "driver.pi@demo";
const predecessor = "01a00000-0000-7000-8000-00000000000a";
const successor = "01a00000-0000-7000-8000-00000000000b";
const pathFor = (id: string) => `/Users/test/.pi/agent/sessions/demo/2026-10-28T09-41-00-000Z_${id}.jsonl`;
const extension = join(import.meta.dir, "..", "extensions", "pi", "index.ts");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Sent = { customType?: string; content?: string; details?: { message?: string } };

/** A Desk whose seat is bound, with a matching launch receipt, to the given Pi session. */
async function bind(root: string, session: string) {
  const receipt = join(root, ".atdd-flow", "runtime-launch", `${session}.yaml`);
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: session, pi_session_path: pathFor(session), herdr_session: "forge", pane: "w1:p2" });
  await atomicYaml(paths(root).seatFile(seat), {
    schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/pi",
    runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, wake: "native", pi_session: session, pi_session_path: pathFor(session), launch_receipt: receipt },
  });
}

async function desk(session: string) {
  const root = await mkdtemp(join(tmpdir(), "atdd-startup-diagnostics-"));
  roots.push(root);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr" });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", repository: "/work/primary", roles: {} });
  await bind(root, session);
  return root;
}

/** Locates the jiti that Pi itself bundles; ATDD_FLOW_JITI overrides it. Absence is a failure, never a skip. */
function jitiPath() {
  const override = process.env.ATDD_FLOW_JITI;
  if (override) return override;
  const pi = Bun.which("pi");
  if (pi) {
    for (let directory = dirname(realpathSync(pi)); directory !== dirname(directory); directory = dirname(directory)) {
      const candidate = join(directory, "node_modules", "jiti", "lib", "jiti.cjs");
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("Pi's bundled jiti was not found; set ATDD_FLOW_JITI to its lib/jiti.cjs path.");
}

// The host runs under Node with Pi's loader, exactly as Pi loads extensions, so import.meta.dir is undefined.
const nodeHost = `
const { createJiti } = require(process.argv[1]);
(async () => {
  const install = (await createJiti(process.cwd() + "/host.cjs", { moduleCache: false }).import(process.argv[2])).default;
  const sent = []; const listeners = {};
  install({ on(event, listener) { (listeners[event] ??= []).push(listener); }, sendMessage(message) { sent.push(message); } });
  await listeners.session_start[0]({}, { hasUI: false });
  await new Promise((resolve) => setTimeout(resolve, 600));
  for (const listener of listeners.session_shutdown ?? []) await listener({}, {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(JSON.stringify(sent));
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });`;

test("RED 1 NODE: a canonical launch loaded through Node/jiti sends the startup handoff and reports no startup failure", async () => {
  const root = await desk(successor);
  const env = { ...process.env, ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: seat, ATDD_FLOW_PI_SESSION: successor, ATDD_FLOW_HERDR_SESSION: "forge", ATDD_FLOW_HERDR_PANE: "w1:p2", HERDR_SESSION: undefined, HERDR_PANE_ID: undefined };
  const child = Bun.spawn(["node", "-e", nodeHost, jitiPath(), extension], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  const sent = JSON.parse(stdout.trim().split("\n").at(-1)!) as Sent[];
  expect(sent.filter((message) => message.customType === "atdd-flow-mail-startup-failed").map((message) => message.content)).toEqual([]);
  const start = sent.filter((message) => message.customType === "atdd-flow-start");
  expect(start).toHaveLength(1);
  expect(start[0]?.content).toContain(`SYSTEM: you are ${seat}.`);
});

const names = ["ATDD_WORKFLOW_ROOT", "ATDD_WORKFLOW_SEAT", "ATDD_FLOW_PI_SESSION", "ATDD_FLOW_HERDR_SESSION", "ATDD_FLOW_HERDR_PANE", "HERDR_SESSION", "HERDR_PANE_ID"] as const;

/** Installs the real extension as a canonical launch of `session`; sendMessage may be overridden to inject a failing step. */
async function launch(root: string, session: string, failOn?: string) {
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  Object.assign(process.env, { ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: seat, ATDD_FLOW_PI_SESSION: session, ATDD_FLOW_HERDR_SESSION: "forge", ATDD_FLOW_HERDR_PANE: "w1:p2" });
  await bind(root, session);
  const sent: Sent[] = [];
  let start: ((event: unknown, context: unknown) => Promise<void>) | undefined;
  let shutdown: (() => void) | undefined;
  installFlowExtension({
    on(event: string, listener: unknown) {
      if (event === "session_start") start = listener as typeof start;
      if (event === "session_shutdown") shutdown = listener as typeof shutdown;
    },
    sendMessage(message: Sent) {
      if (failOn && message.customType === failOn) throw new Error("injected startup handoff failure");
      sent.push(message);
    },
  } as never);
  await start?.({}, { hasUI: false });
  return {
    sent,
    mail: () => sent.filter((message) => message.customType === "atdd-flow-mail").map((message) => message.details?.message),
    stop: async () => {
      shutdown?.();
      await pause(30);
      for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    },
  };
}

test("RED 2 PHASE: a failing post-activation startup step names its phase and stack while mail stays ACTIVE", async () => {
  const root = await desk(successor);
  const run = await launch(root, successor, "atdd-flow-start");
  await pause(400);
  await run.stop();
  const failed = run.sent.filter((message) => message.customType === "atdd-flow-mail-startup-failed");
  expect(failed).toHaveLength(1);
  const content = failed[0]?.content ?? "";
  expect(content).toContain("native Flow mail is ACTIVE");
  expect(content).toContain("injected startup handoff failure");
  expect(content).toContain("phase=startup-handoff");
  expect(content).toMatch(/\n\s+at /);
});

/** Persists one immutable message and queues it as a single durable segment, as Flow does when posting. */
async function enqueue(root: string, ids: string[]) {
  const inbox = join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(seat));
  const entries = [];
  for (const [index, id] of ids.entries()) {
    const thread = `T-${id}`, created_at = new Date(Date.now() + index).toISOString();
    await atomicYaml(join(root, "threads", thread, "thread.yaml"), { schema: "atdd-workflow/thread/v1", id: thread, participants: ["main@demo", seat], subject: id, state: "open" });
    await atomicYaml(join(root, "threads", thread, `${id}.yaml`), { schema: "atdd-workflow/message/v1", id, from: "main@demo", to: [seat], created_at, body: "wake" });
    entries.push({ thread, message: id, created_at, published: true });
  }
  await atomicYaml(join(inbox, "pending", "S-1.yaml"), { schema: "atdd-flow/pi-inbox-segment/v1", entries });
  await atomicYaml(join(inbox, "queue.yaml"), { schema: "atdd-flow/pi-inbox-queue/v1", head: "S-1", tail: "S-1" });
  return join(inbox, "queue.yaml");
}

async function until(condition: () => boolean, ms = 3_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline && !condition();) await pause(25);
}

test("RED 3 REPLAY: a fresh successor skips references its predecessor delivered, delivers unread mail once, then the new canary", async () => {
  const root = await desk(predecessor);
  const queue = await enqueue(root, ["M-seen"]);
  const first = await launch(root, predecessor);
  await until(() => first.mail().includes("M-seen") && !existsSync(queue));
  await first.stop();
  expect(first.mail()).toEqual(["M-seen"]);

  // The predecessor ended after delivery but before its durable reference was consumed; a genuinely unread message follows it.
  const requeued = await enqueue(root, ["M-seen", "M-unread"]);
  const second = await launch(root, successor);
  await until(() => second.mail().includes("M-unread") && !existsSync(requeued));
  await enqueue(root, ["M-canary"]);
  await until(() => second.mail().includes("M-canary"));
  await pause(200);
  await second.stop();
  expect(second.mail()).toEqual(["M-unread", "M-canary"]);
});
