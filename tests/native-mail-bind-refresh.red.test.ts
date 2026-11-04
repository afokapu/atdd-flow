// URN: test:flow:native-mail-bind-refresh
// Acceptance: acc:flow:E036-RED-001
// Phase: UNIT
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { recordMailActivation, registerRuntimeState } from "../src/runtime-state";

// Contract under test (RED), isolated temp Desks only; no live Desk or seat is touched:
// 1 STALE    status seat compares a recorded activation snapshot with the durable record at read time:
//            a snapshot that differed only before a supported same-session bind is reported stale, not as a live mismatch.
// 2 REAL     a genuine session or pane mismatch against the durable record is still reported as a mismatch.
// 3 REFRESH  after the supported bind makes the durable record match the running Pi, the same Pi activates native mail without restart.
// 4 REFUSE   a bind to a pane the running Pi is not in, or a different Pi session, never activates mail.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const seat = "driver.pi@demo";
const bound = "01a00000-0000-7000-8000-00000000000a";
const other = "01a00000-0000-7000-8000-00000000000b";
const pathFor = (id: string) => `/Users/test/.pi/agent/sessions/demo/2026-10-22T09-41-00-000Z_${id}.jsonl`;
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const extension = join(import.meta.dir, "..", "extensions", "pi", "index.ts");

/** A Desk whose seat, launch receipt and pane name the `bound` session in pane w1:p2. */
async function desk() {
  const root = await mkdtemp(join(tmpdir(), "atdd-mail-refresh-"));
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

const cleanEnv = { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, NO_COLOR: "1" };

async function flow(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "--root", root, ...args], { cwd: root, env: cleanEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out: `${stdout}${stderr}`, exitCode };
}

const rebind = (root: string, pane: string) => flow(root, "bind", seat, "--application", "herdr", "--address", pane, "--session", "forge");

/** A fresh advisory runtime whose recorded activation compared the live Pi in `livePane` with the binding that then named `boundPane`. */
async function snapshot(root: string, session: string, livePane: string, boundPane: string, differs: string[]) {
  const ownerToken = "owner-token";
  await registerRuntimeState(root, { seat, owner_token: ownerToken, pid: process.pid, model: "pi", cwd: root, pi_session: session });
  await recordMailActivation(root, seat, ownerToken, {
    at: "2026-11-03T16:59:30.000Z", transport: "inactive",
    live: { pi_session: session, herdr_session: "forge", pane: livePane },
    bound: { pi_session: bound, herdr_session: "forge", pane: boundPane, receipt: "present" },
    differs,
  });
}

test("RED 1 STALE: after a same-session bind that now matches the live Pi, status reports the snapshot stale, not a live mismatch", async () => {
  const root = await desk();
  await snapshot(root, bound, "w1:p9", "w1:p2", ["pane"]);
  expect((await rebind(root, "w1:p9")).exitCode).toBe(0);
  const { out } = await flow(root, "status", "seat", seat);
  expect(out).not.toContain("differs pane");
  expect(out).not.toContain("bound session=" + bound + " herdr=forge pane=w1:p2");
  expect(out).toContain("stale");
  expect(out).toContain("2026-11-03T16:59:30");
  expect(out).toContain("pane=w1:p9");
});

test("RED 2 REAL: a pane or session that still differs from the durable record is reported as a mismatch", async () => {
  const pane = await desk();
  await snapshot(pane, bound, "w1:p9", "w1:p2", ["pane"]);
  const stale = await flow(pane, "status", "seat", seat);
  expect(stale.out).toContain("differs pane");
  expect(stale.out).not.toContain("stale");
  const session = await desk();
  await snapshot(session, other, "w1:p2", "w1:p2", ["session"]);
  const mismatch = await flow(session, "status", "seat", seat);
  expect(mismatch.out).toContain(`native mail inactive (bound ${bound}, live ${other})`);
  expect(mismatch.out).toContain("differs session");
});

type Sent = { customType?: string; content?: string; options?: { triggerTurn?: boolean } };
type Run = { sent: Sent[]; activation?: { transport: string; differs: string[] } };

// The Pi host runs in a child process with an explicit environment. It is told to re-verify every 50 ms.
// `action` runs in the parent while the Pi is alive, standing for the operator's supported bind.
const hostScript = `
import install from ${JSON.stringify(extension)};
import { readRuntimeState } from ${JSON.stringify(join(import.meta.dir, "..", "src", "runtime-state"))};
const sent = []; const listeners = {};
install({ on(event, listener) { (listeners[event] ??= []).push(listener); }, sendMessage(message, options) { sent.push({ ...message, options }); } }, process.env, { refreshMs: 50 });
await listeners.session_start[0]({}, { hasUI: false });
await new Promise((resolve) => setTimeout(resolve, Number(process.env.REFRESH_TEST_WAIT_MS)));
const state = await readRuntimeState(process.env.ATDD_WORKFLOW_ROOT, process.env.ATDD_WORKFLOW_SEAT);
for (const listener of listeners.session_shutdown ?? []) await listener({}, {});
await new Promise((resolve) => setTimeout(resolve, 100));
console.log(JSON.stringify({ sent, activation: state?.mail_activation }));
process.exit(0);`;

/** Runs a launcher Pi for `session` in `pane`; `afterStart` fires once the pre-bind inactive notice exists. */
async function runPi(root: string, session: string, pane: string, afterStart: () => Promise<unknown>, hostAttached = false): Promise<Run> {
  // A host-attached Pi has no launcher variables; only Herdr's injected pane identity names it.
  const identity = hostAttached
    ? { ATDD_FLOW_PI_SESSION: undefined, ATDD_FLOW_HERDR_SESSION: undefined, ATDD_FLOW_HERDR_PANE: undefined, HERDR_SESSION: "forge", HERDR_PANE_ID: pane }
    : { ATDD_FLOW_PI_SESSION: session, ATDD_FLOW_HERDR_SESSION: "forge", ATDD_FLOW_HERDR_PANE: pane };
  const env = { ...process.env, ...identity, ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: seat, REFRESH_TEST_WAIT_MS: "3500" };
  const child = Bun.spawn([process.execPath, "-e", hostScript], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  // The launcher window polls only briefly for the first verdict, then the Pi is inactive and waiting for a binding that matches it.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await afterStart();
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as Run;
}

const kinds = (run: Run, type: string) => run.sent.filter((message) => message.customType === type);

test("RED 3 REFRESH: the supported bind to the running Pi's own pane activates native mail without restart", async () => {
  const root = await desk();
  const before = (await readYaml<{ runtime: { launch_receipt: string } }>(paths(root).seatFile(seat))).runtime.launch_receipt;
  const run = await runPi(root, bound, "w1:p9", async () => { expect((await rebind(root, "w1:p9")).exitCode).toBe(0); });
  expect(kinds(run, "atdd-flow-start")).toHaveLength(1);
  expect(run.activation).toMatchObject({ transport: "active", differs: [], live: { pane: "w1:p9" }, bound: { pane: "w1:p9", pi_session: bound } });
  expect(kinds(run, "atdd-flow-mail-inactive").every((message) => message.options?.triggerTurn === false)).toBe(true);
  // The receipt still names the launcher's pane and session; refresh never rewrites it.
  expect((await readYaml<{ runtime: { launch_receipt: string } }>(paths(root).seatFile(seat))).runtime.launch_receipt).toBe(before);
}, 20_000);

test("RED 4 REFUSE: a bind to another pane, or a Pi with a different session, never activates mail", async () => {
  const wrongPane = await desk();
  const paneRun = await runPi(wrongPane, bound, "w1:p9", async () => { await rebind(wrongPane, "w1:p7"); });
  expect(kinds(paneRun, "atdd-flow-start")).toHaveLength(0);
  expect(paneRun.activation?.transport).not.toBe("active");
  const wrongSession = await desk();
  const sessionRun = await runPi(wrongSession, other, "w1:p9", async () => { await rebind(wrongSession, "w1:p9"); });
  expect(kinds(sessionRun, "atdd-flow-start")).toHaveLength(0);
  expect(sessionRun.activation?.transport).not.toBe("active");
}, 30_000);

test("RED 5 HOST: a host-attached Pi with no launch receipt activates after bind to its own pane, and not after a bind to another pane", async () => {
  const unreceipted = async () => {
    const root = await desk();
    const record = await readYaml<{ runtime: Record<string, unknown> }>(paths(root).seatFile(seat));
    const { launch_receipt: _receipt, pi_session: _session, pi_session_path: _path, ...runtime } = record.runtime;
    await atomicYaml(paths(root).seatFile(seat), { ...record, runtime });
    return root;
  };
  const own = await unreceipted();
  const ownRun = await runPi(own, bound, "w1:p9", async () => { await rebind(own, "w1:p9"); }, true);
  expect(kinds(ownRun, "atdd-flow-start")).toHaveLength(1);
  expect(ownRun.activation).toMatchObject({ transport: "active", differs: [] });
  const elsewhere = await unreceipted();
  const elsewhereRun = await runPi(elsewhere, bound, "w1:p9", async () => { await rebind(elsewhere, "w1:p7"); }, true);
  expect(kinds(elsewhereRun, "atdd-flow-start")).toHaveLength(0);
  expect(elsewhereRun.activation?.transport).not.toBe("active");
}, 30_000);
