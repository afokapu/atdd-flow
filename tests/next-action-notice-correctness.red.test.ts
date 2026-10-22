// URN: test:flow:next-action-notice-correctness
// Acceptance: acc:flow:E007-RED-001
// Phase: UNIT
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml } from "../src/core";
import installFlowExtension from "../extensions/pi/index";
import { nextDirective, respondToHandoff, submitHandoff } from "../src/tasks";

// Contract under test (RED), one failing test per task body item:
// 1 TERMINAL  done/superseded/rejected/deferred tasks yield no directive for any role.
// 2 BLOCKED   a blocked assignee gets no directive (a self-coordinated seat falls through to the coordinator notice);
//             a blocked coordinator is notified once per unchanged blocker.
// 3 STALE     the directive is re-derived at delivery (message_end), at most one is pending, unchanged repeats are not enqueued.
// 4 ACCEPTED  awaiting_assignee after a same-phase accept directs to the next phase, then to proofs/review.
// 5 MAIL      a mail already answered by this seat (reply/receipt citing it) is not notified again.

type Sent = { role?: string; customType?: string; content?: string; details?: Record<string, unknown> };
type Listener = (event: unknown, context: unknown) => unknown;

const driver = "driver.pi@demo";
const coordinator = "main@demo";
const taskId = "directive";
const session = "01a12345-6789-7abc-8def-0123456789ab";
const sessionPath = `/Users/test/.pi/agent/sessions/demo/run_${session}.jsonl`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type TaskOptions = Record<string, unknown> & { assignee?: string; coordinator?: string };

async function desk(task: TaskOptions = {}, seatAddress = driver) {
  const root = await mkdtemp(join(tmpdir(), "atdd-next-action-notice-"));
  roots.push(root);
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await atomicYaml(join(root, "work", "demo", "project.yaml"), { schema: "atdd-workflow/project/v1", project: "demo" });
  const receipt = join(root, ".atdd-flow", "runtime-launch", "verified.yaml");
  await atomicYaml(join(root, "work", "demo", "seats", "driver.pi", "seat.yaml"), {
    schema: "atdd-workflow/seat/v2", address: driver, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/pi",
    runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane: seatAddress === driver ? "w1:p2" : "w1:p9" } }, pi_session: session, pi_session_path: sessionPath, launch_receipt: receipt },
  });
  await atomicYaml(join(root, "work", "demo", "seats", "main", "seat.yaml"), {
    schema: "atdd-workflow/seat/v2", address: coordinator, role: "main", project: "demo", worktree: "/work/demo-main", branch: "main",
    runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane: seatAddress === coordinator ? "w1:p2" : "w1:p3" } }, pi_session: session, pi_session_path: sessionPath, launch_receipt: receipt },
  });
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: seatAddress, pi_session: session, pi_session_path: sessionPath, herdr_session: "forge", pane: "w1:p2" });
  await atomicYaml(taskPath(root), taskRecord(task));
  return root;
}

const taskPath = (root: string) => join(root, "work", "demo", "tasks", `${taskId}.yaml`);
const taskRecord = (task: TaskOptions) => ({
  schema: "atdd-workflow/task/v1", title: "Directive", coordinator, assignee: driver, status: "in_progress", done_when: [{ text: "Deliver the directive." }], ...task,
});

const extension = join(import.meta.dir, "..", "extensions", "pi", "index.ts");
const core = join(import.meta.dir, "..", "src", "core.ts");
// Pi host fake run in a child process with an explicit environment, so no test mutates shared process.env.
// `autoDeliver` runs message_end for each queued follow-up like Pi does for a drained one; `mutate` rewrites the task
// after the first next-action follow-up is queued and before it is delivered (the agent was mid-turn).
const hostScript = `
import installFlowExtension from ${JSON.stringify(extension)};
import { atomicYaml } from ${JSON.stringify(core)};
const options = JSON.parse(process.env.NOTICE_TEST_OPTIONS);
const sent = []; const delivered = []; const listeners = {};
const deliver = async (message) => {
  let current = message;
  for (const listener of listeners.message_end ?? []) {
    const result = await listener({ type: "message_end", message: current }, {});
    if (result?.message) current = result.message;
  }
  delivered.push(current);
};
installFlowExtension({
  on(event, listener) { (listeners[event] ??= []).push(listener); },
  sendMessage(message) { const queued = { role: "custom", ...message }; sent.push(queued); if (options.autoDeliver) void deliver(queued); },
});
const count = (type) => sent.filter((message) => message.customType === type).length;
const wait = async (condition) => { for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };
await listeners.session_start[0]({}, { hasUI: false });
if (options.mutate) {
  await wait(() => count("atdd-flow-next-action") >= 1);
  await atomicYaml(options.mutate.path, options.mutate.task);
  await deliver(sent.find((message) => message.customType === "atdd-flow-next-action"));
}
await wait(() => count("atdd-flow-mail") >= options.expectMail);
await new Promise((resolve) => setTimeout(resolve, 150));
for (const listener of listeners.session_shutdown ?? []) await listener({}, {});
await new Promise((resolve) => setTimeout(resolve, 100));
console.log(JSON.stringify({ sent, delivered }));
process.exit(0);`;

type RunOptions = { autoDeliver?: boolean; expectMail?: number; mutate?: { path: string; task: TaskOptions } };

async function runPi(root: string, seatAddress: string, options: RunOptions = {}) {
  const env = {
    ...process.env, ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: seatAddress, ATDD_FLOW_PI_SESSION: session,
    ATDD_FLOW_HERDR_SESSION: "forge", ATDD_FLOW_HERDR_PANE: "w1:p2", NOTICE_TEST_OPTIONS: JSON.stringify({ expectMail: 0, ...options }),
  };
  const child = Bun.spawn([process.execPath, "-e", hostScript], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as { sent: Sent[]; delivered: Sent[] };
  return {
    ...result,
    nextActions: result.sent.filter((message) => message.customType === "atdd-flow-next-action"),
    mail: result.sent.filter((message) => message.customType === "atdd-flow-mail"),
  };
}

async function queueMail(root: string, seatAddress: string, ids: string[], answered: string[] = []) {
  const thread = "T-notice";
  const sender = seatAddress === coordinator ? driver : coordinator;
  await atomicYaml(join(root, "threads", thread, "thread.yaml"), {
    schema: "atdd-workflow/thread/v1", id: thread, participants: [sender, seatAddress], subject: "Notice thread", state: "open",
  });
  const created_at = "2026-10-10T12:00:00.000Z";
  for (const id of ids) {
    await atomicYaml(join(root, "threads", thread, `${id}.yaml`), {
      schema: "atdd-workflow/message/v1", id, from: sender, to: [seatAddress], created_at, body: `Body of ${id}.`,
    });
  }
  for (const id of answered) {
    await atomicYaml(join(root, "threads", thread, `M-receipt-${id}.yaml`), {
      schema: "atdd-workflow/message/v1", id: `M-receipt-${id}`, from: seatAddress, to: [sender], kind: "receipt", in_reply_to: id,
      created_at: "2026-10-10T12:05:00.000Z", body: "Handled.",
    });
  }
  await atomicYaml(join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(seatAddress), "pending", "S-notice.yaml"), {
    schema: "atdd-flow/pi-inbox-segment/v1", entries: ids.map((id) => ({ thread, message: id, created_at, published: true })),
  });
  await atomicYaml(join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(seatAddress), "queue.yaml"), {
    schema: "atdd-flow/pi-inbox-queue/v1", head: "S-notice", tail: "S-notice",
  });
}

const reviewer = "2026-10-12T00:00:00.000Z";
const terminalCases: [string, TaskOptions][] = [
  ["done", { status: "done" }],
  ["superseded", { status: "superseded", disposition: { kind: "superseded", by: coordinator, at: reviewer, reason: "Replaced." } }],
  ["rejected", { status: "rejected", disposition: { kind: "rejected", by: coordinator, at: reviewer, reason: "Declined." } }],
  ["deferred", { status: "in_progress", blocker: "Deferred until 2026-12-01T00:00:00.000Z: Later.", deferred: { by: coordinator, at: reviewer, reason: "Later.", owner: coordinator, trigger: "Owner returns.", review_at: "2026-12-01T00:00:00.000Z" } }],
];

test("RED 1 TERMINAL: done, superseded, rejected and deferred tasks yield no directive for the assignee or the coordinator", async () => {
  for (const [name, task] of terminalCases) {
    const root = await desk(task);
    expect(await nextDirective(root, driver), `${name} assignee`).toBeUndefined();
    expect(await nextDirective(root, coordinator), `${name} coordinator`).toBeUndefined();
  }
});

test("RED 2 BLOCKED: a blocked assignee gets no directive, a blocked coordinator gets the resolve-blocker notice", async () => {
  const root = await desk({ blocker: "Await owner decision." });
  expect(await nextDirective(root, driver)).toBeUndefined();
  expect(await nextDirective(root, coordinator)).toMatchObject({ role: "coordinator", lifecycle: "BLOCKED", command: expect.stringContaining("task unblock demo directive") });
});

test("RED 2 BLOCKED: a self-coordinated seat falls through from the silent assignee role to the coordinator notice", async () => {
  const root = await desk({ blocker: "Await owner decision.", coordinator: driver });
  expect(await nextDirective(root, driver)).toMatchObject({ role: "coordinator", lifecycle: "BLOCKED", command: expect.stringContaining("task unblock demo directive") });
});

test("RED 2 BLOCKED: repeated wakes notify the blocked coordinator once per unchanged blocker", async () => {
  const root = await desk({ blocker: "Await owner decision." }, coordinator);
  await queueMail(root, coordinator, ["M-one", "M-two", "M-three"]);
  const pi = await runPi(root, coordinator, { autoDeliver: true, expectMail: 3 });
  expect(pi.mail).toHaveLength(3);
  expect(pi.nextActions.filter((message) => message.details?.lifecycle === "BLOCKED")).toHaveLength(1);
});

test("RED 3 STALE: a directive queued before a state change is re-derived from current task state when it is delivered", async () => {
  const root = await desk({ phase: "green", handoff: { state: "awaiting_assignee", evidence: "M-phase", updated_at: reviewer } });
  // The task advances while Pi is mid-turn and the queued follow-up is still held; it is delivered afterwards.
  const mutate = { path: taskPath(root), task: taskRecord({ phase: "refactor", handoff: { state: "awaiting_assignee", evidence: "M-phase", updated_at: reviewer } }) };
  const pi = await runPi(root, driver, { mutate });
  expect(pi.nextActions[0]?.content).toContain("Implement the accepted GREEN scope");
  const replaced = pi.delivered[0]!;
  expect(replaced.content).toContain("Refactor only after GREEN acceptance");
  expect(replaced.content).not.toContain("Implement the accepted GREEN scope");
  expect(replaced.details).toMatchObject({ lifecycle: "REFACTOR", authority: "task" });
});

test("RED 3 STALE: wakes while a next-action follow-up is pending enqueue no second one", async () => {
  const root = await desk({ phase: "green", handoff: { state: "awaiting_assignee", evidence: "M-phase", updated_at: reviewer } });
  await queueMail(root, driver, ["M-one", "M-two", "M-three"]);
  const pi = await runPi(root, driver, { expectMail: 3 });
  expect(pi.mail).toHaveLength(3);
  expect(pi.nextActions).toHaveLength(1);
});

test("RED 3 STALE: an unchanged directive is not enqueued again after it was delivered", async () => {
  const root = await desk({ phase: "green", handoff: { state: "awaiting_assignee", evidence: "M-phase", updated_at: reviewer } });
  await queueMail(root, driver, ["M-one", "M-two", "M-three"]);
  const pi = await runPi(root, driver, { autoDeliver: true, expectMail: 3 });
  expect(pi.mail).toHaveLength(3);
  expect(pi.nextActions).toHaveLength(1);
});

async function accepted(submitted: string, acceptedAs: string) {
  const root = await desk({});
  await submitHandoff(root, "demo", taskId, ["--by", driver, "--phase", submitted, "--evidence", "M-evidence"]);
  await respondToHandoff(root, "demo", taskId, ["--by", coordinator, "--outcome", "accept", "--phase", acceptedAs]);
  return nextDirective(root, driver);
}

test("RED 4 ACCEPTED: a same-phase accept directs the assignee to the next phase, never to resubmit the same phase", async () => {
  expect(await accepted("plan", "plan")).toMatchObject({ lifecycle: "RED", action: expect.stringContaining("RED"), command: expect.stringContaining("--phase red") });
  expect(await accepted("red", "red")).toMatchObject({ lifecycle: "GREEN", action: expect.stringContaining("GREEN") });
  expect(await accepted("green", "green")).toMatchObject({ lifecycle: "REFACTOR", action: expect.stringContaining("REFACTOR") });
  expect((await accepted("plan", "plan"))?.action).not.toContain("Prepare and submit PLAN handoff");
});

test("RED 4 ACCEPTED: an accepted REFACTOR directs to done_when proofs and task review", async () => {
  const directive = await accepted("refactor", "refactor");
  expect(directive?.action).toContain("done_when");
  expect(directive?.command).toContain("atdd-flow task review demo directive --by driver.pi@demo");
});

test("RED 4 ACCEPTED: an accept that names the next phase keeps that phase's action (regression guard)", async () => {
  expect(await accepted("plan", "red")).toMatchObject({ lifecycle: "RED", action: expect.stringContaining("Commit focused test-only RED handoff") });
});

test("RED 5 MAIL: mail this seat already answered with a receipt or reply is not notified again", async () => {
  const root = await desk({ phase: "green", handoff: { state: "awaiting_assignee", evidence: "M-phase", updated_at: reviewer } });
  await queueMail(root, driver, ["M-answered", "M-open"], ["M-answered"]);
  const pi = await runPi(root, driver, { autoDeliver: true, expectMail: 1 });
  const notices = pi.mail.map((message) => message.details?.message);
  expect(notices).toContain("M-open");
  expect(notices).not.toContain("M-answered");
});

// GREEN guard behaviour of the notice state (pending flag, unchanged marker, withdrawn notice).
import { createNoticeState, refreshDelivered, sendTaskDirective } from "../src/next-action-notices";

const green = { phase: "green", handoff: { state: "awaiting_assignee", evidence: "M-phase", updated_at: reviewer } };

function recordingHost() {
  const queued: Sent[] = [];
  return { queued, host: { sendMessage: (message: unknown) => { queued.push({ role: "custom", ...(message as Sent) }); } } };
}

test("GREEN: a pending flag blocks a second enqueue until the queue settles, then a notice is queued again", async () => {
  const root = await desk(green);
  const state = createNoticeState();
  const { host, queued } = recordingHost();
  await sendTaskDirective(host, root, driver, state);
  await sendTaskDirective(host, root, driver, state);
  expect(queued).toHaveLength(1);
  state.pending = false; // what the agent_settled hook does when Pi's follow-up queue was cleared
  await sendTaskDirective(host, root, driver, state);
  expect(queued).toHaveLength(2);
});

test("GREEN: the extension registers agent_settled and message_end hooks", async () => {
  const root = await desk(green);
  const seen: string[] = [];
  // The factory only registers listeners; it reads identity at call time, so run it in a child to keep shared env untouched.
  const script = `import install from ${JSON.stringify(extension)}; const seen = []; install({ on(e) { seen.push(e); }, sendMessage() {} }); console.log(JSON.stringify(seen));`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: driver }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  seen.push(...(JSON.parse(out.trim().split("\n").at(-1)!) as string[]));
  expect(seen).toContain("message_end");
  expect(seen).toContain("agent_settled");
});

test("GREEN: a held duplicate notice becomes a one-line unchanged marker, and a notice for a vanished action is withdrawn", async () => {
  const root = await desk(green);
  const state = createNoticeState();
  const notice = { role: "custom", customType: "atdd-flow-next-action", content: "stale", details: {} };
  const first = await refreshDelivered(root, driver, state, notice);
  expect(first?.content).toContain("Implement the accepted GREEN scope");
  const second = await refreshDelivered(root, driver, state, notice);
  expect(second?.content).toContain("unchanged");
  expect(second?.content).not.toContain("Implement the accepted GREEN scope");
  await atomicYaml(taskPath(root), taskRecord({ status: "done" }));
  const third = await refreshDelivered(root, driver, state, notice);
  expect(third?.content).toContain("withdrawn");
  expect(state.lastDelivered).toBeUndefined();
});

test("GREEN: mail that was answered while held is replaced by a one-line already-answered notice", async () => {
  const root = await desk(green);
  await queueMail(root, driver, ["M-held"], ["M-held"]);
  const state = createNoticeState();
  const message = { role: "custom", customType: "atdd-flow-mail", content: "original", details: { thread: "T-notice", message: "M-held" } };
  expect((await refreshDelivered(root, driver, state, message))?.content).toContain("already answered");
  const open = { ...message, details: { thread: "T-notice", message: "M-other" } };
  expect(await refreshDelivered(root, driver, state, open)).toBeUndefined();
});
