// URN: test:flow:inactive-mail-notice-diagnosable
// Acceptance: acc:flow:E010-RED-001
// Phase: UNIT
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths } from "../src/core";
import { readRuntimeState } from "../src/runtime-state";

// Contract under test (RED):
// 1 NO WAKE   the inactive-mail notice is display only (triggerTurn false).
// 2 VALUES    the notice lists the compared live and bound values and names a field only when it differs.
// 3 ACTIVE    a startup step that throws after the transport started is reported as ACTIVE with its error, never INACTIVE.
// 4 ONCE      the launcher activation callback runs at most once, even when it throws.
// 5 ADVISORY  the advisory runtime state records the compared values and error, and status seat prints them.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const seat = "driver.pi@demo";
const bound = "01a00000-0000-7000-8000-00000000000a";
const live = "01a00000-0000-7000-8000-00000000000b";
const pathFor = (id: string) => `/Users/test/.pi/agent/sessions/demo/2026-10-22T09-41-00-000Z_${id}.jsonl`;
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const extension = join(import.meta.dir, "..", "extensions", "pi", "index.ts");

/** A Desk whose seat binding, launch receipt and pane all name the `bound` session. */
async function desk() {
  const root = await mkdtemp(join(tmpdir(), "atdd-inactive-notice-"));
  roots.push(root);
  const receipt = join(root, ".atdd-flow", "runtime-launch", "bound.yaml");
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr" });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", repository: "/work/primary", roles: {} });
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: bound, pi_session_path: pathFor(bound), herdr_session: "forge", pane: "w1:p2" });
  await atomicYaml(paths(root).seatFile(seat), {
    schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/pi",
    runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, wake: "native", pi_session: bound, pi_session_path: pathFor(bound), launch_receipt: receipt },
  });
  await atomicYaml(paths(root).taskFile("demo", "work"), { schema: "atdd-workflow/task/v1", title: "Work", status: "in_progress", coordinator: "coordinator@demo", assignee: seat, done_when: [{ text: "Done." }] });
  return root;
}

type Sent = { customType?: string; content?: string; details?: Record<string, unknown>; options?: { triggerTurn?: boolean; deliverAs?: string } };
type Options = { throwOn?: string; keepState?: boolean };

// The Pi host runs in a child process with an explicit environment so no test mutates shared process.env.
// `throwOn` makes sendMessage throw for that customType, which fails the launcher activation callback after the transport started.
// The window is given real time to loop before Date.now jumps past the 60 s activation timeout.
const hostScript = `
import install from ${JSON.stringify(extension)};
const options = JSON.parse(process.env.NOTICE_TEST_OPTIONS);
const sent = []; const listeners = {};
const real = Date.now; let jump = 0; Date.now = () => real() + jump;
install({
  on(event, listener) { (listeners[event] ??= []).push(listener); },
  sendMessage(message, sendOptions) {
    sent.push({ ...message, options: sendOptions });
    if (message.customType === options.throwOn) throw new Error("boom");
  },
});
await listeners.session_start[0]({}, { hasUI: false });
await new Promise((resolve) => setTimeout(resolve, 1200));
jump = 61_000;
await new Promise((resolve) => setTimeout(resolve, 400));
if (!options.keepState) {
  for (const listener of listeners.session_shutdown ?? []) await listener({}, {});
  await new Promise((resolve) => setTimeout(resolve, 100));
}
console.log(JSON.stringify(sent));
process.exit(0);`;

async function runPi(root: string, piSession: string, options: Options = {}) {
  const env = {
    ...process.env, ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: seat, ATDD_FLOW_PI_SESSION: piSession,
    ATDD_FLOW_HERDR_SESSION: "forge", ATDD_FLOW_HERDR_PANE: "w1:p2", NOTICE_TEST_OPTIONS: JSON.stringify(options),
  };
  const child = Bun.spawn([process.execPath, "-e", hostScript], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  const sent = JSON.parse(stdout.trim().split("\n").at(-1)!) as Sent[];
  return {
    sent,
    inactive: sent.filter((message) => message.customType === "atdd-flow-mail-inactive"),
    failed: sent.filter((message) => message.customType === "atdd-flow-mail-startup-failed"),
    starts: sent.filter((message) => message.customType === "atdd-flow-start"),
  };
}

test("RED 1 NO WAKE: the inactive-mail notice is display only and never triggers an agent turn", async () => {
  const root = await desk();
  const { inactive } = await runPi(root, live);
  expect(inactive).toHaveLength(1);
  expect(inactive[0]?.options?.triggerTurn).toBe(false);
});

test("RED 2 VALUES: a real session mismatch lists the compared live and bound values and names only the differing field", async () => {
  const root = await desk();
  const { inactive } = await runPi(root, live);
  const content = inactive[0]?.content ?? "";
  for (const part of [`live session=${live}`, `bound session=${bound}`, "herdr=forge", "pane=w1:p2", "receipt=present", "Differs: session", "does not match"]) expect(content).toContain(part);
  expect(content).not.toContain("Differs: session, ");
  expect(content).toContain("INACTIVE");
});

test("RED 3 ACTIVE: a startup step that throws after the transport started is reported ACTIVE with its error, never INACTIVE", async () => {
  const root = await desk();
  const { inactive, failed } = await runPi(root, bound, { throwOn: "atdd-flow-start" });
  expect(inactive).toHaveLength(0);
  expect(failed).toHaveLength(1);
  const content = failed[0]?.content ?? "";
  expect(content).toContain(`native Flow mail is ACTIVE for ${seat}`);
  expect(content).toContain("a startup step failed: boom");
  expect(content).toContain(`live session=${bound}`);
  expect(content).not.toContain("INACTIVE");
  expect(content).not.toContain("does not match");
  expect(failed[0]?.options?.triggerTurn).toBe(false);
});

test("RED 4 ONCE: a persistently throwing activation callback runs once, not on every poll until the window ends", async () => {
  const root = await desk();
  const { starts } = await runPi(root, bound, { throwOn: "atdd-flow-start" });
  expect(starts).toHaveLength(1);
});

test("RED 5 ADVISORY: the advisory runtime state records the compared values and error, and status seat prints them", async () => {
  const root = await desk();
  await runPi(root, bound, { throwOn: "atdd-flow-start", keepState: true });
  const state = await readRuntimeState(root, seat) as { mail_activation?: unknown } | undefined;
  expect(state?.mail_activation).toMatchObject({
    live: { pi_session: bound, herdr_session: "forge", pane: "w1:p2" },
    bound: { pi_session: bound, herdr_session: "forge", pane: "w1:p2", receipt: "present" },
    differs: [],
    error: expect.stringContaining("boom"),
  });
  const child = Bun.spawn([process.execPath, cli, "--root", root, "status", "seat", seat], { cwd: root, env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(`${stdout}${stderr}`).toContain("boom");
});

test("RED guard: a healthy launcher start sends no diagnostic notice and the mismatch notice appears once", async () => {
  const healthy = await runPi(await desk(), bound);
  expect(healthy.inactive).toHaveLength(0);
  expect(healthy.failed).toHaveLength(0);
  expect(healthy.starts).toHaveLength(1);
  expect((await runPi(await desk(), live)).inactive).toHaveLength(1);
});

test("GREEN guard: a session mismatch records transport inactive with the differing field, and status seat keeps its bound/live line", async () => {
  const root = await desk();
  await runPi(root, live, { keepState: true });
  const state = await readRuntimeState(root, seat) as { mail_activation?: unknown } | undefined;
  expect(state?.mail_activation).toMatchObject({ transport: "inactive", differs: ["session"], live: { pi_session: live }, bound: { pi_session: bound, receipt: "present" } });
  const child = Bun.spawn([process.execPath, cli, "--root", root, "status", "seat", seat], { cwd: root, env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(stdout).toContain(`native mail inactive (bound ${bound}, live ${live})`);
  expect(stdout).toContain("differs session");
});
