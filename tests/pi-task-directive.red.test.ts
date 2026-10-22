import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml } from "../src/core";
import installFlowExtension from "../extensions/pi/index";

type Lifecycle = "TODO" | "PLAN" | "RED" | "GREEN" | "REFACTOR" | "REVIEW" | "DONE" | "BLOCKED";
type Sent = { customType?: string; content?: string; details?: Record<string, unknown> };

const root = await mkdtemp(join(tmpdir(), "atdd-pi-task-directive-"));
const seat = "driver.pi@demo";
const taskId = "runtime-directive";
const session = "01a12345-6789-7abc-8def-0123456789ab";
const sessionPath = `/Users/test/.pi/agent/sessions/demo/run_${session}.jsonl`;
const receipt = join(root, ".atdd-flow", "runtime-launch", "verified.yaml");
const originalEnvironment = {
  root: process.env.ATDD_WORKFLOW_ROOT,
  seat: process.env.ATDD_WORKFLOW_SEAT,
  piSession: process.env.ATDD_FLOW_PI_SESSION,
  herdrSession: process.env.ATDD_FLOW_HERDR_SESSION,
  pane: process.env.ATDD_FLOW_HERDR_PANE,
};

function useEnvironment() {
  process.env.ATDD_WORKFLOW_ROOT = root;
  process.env.ATDD_WORKFLOW_SEAT = seat;
  process.env.ATDD_FLOW_PI_SESSION = session;
  process.env.ATDD_FLOW_HERDR_SESSION = "forge";
  process.env.ATDD_FLOW_HERDR_PANE = "w1:p2";
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["ATDD_WORKFLOW_ROOT", originalEnvironment.root], ["ATDD_WORKFLOW_SEAT", originalEnvironment.seat],
    ["ATDD_FLOW_PI_SESSION", originalEnvironment.piSession], ["ATDD_FLOW_HERDR_SESSION", originalEnvironment.herdrSession],
    ["ATDD_FLOW_HERDR_PANE", originalEnvironment.pane],
  ] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

async function taskFixture(lifecycle: Lifecycle) {
  const phase = lifecycle === "PLAN" ? "plan" : lifecycle === "RED" ? "red" : lifecycle === "GREEN" ? "green" : lifecycle === "REFACTOR" ? "refactor" : undefined;
  await atomicYaml(join(root, "work", "demo", "seats", "driver.pi", "seat.yaml"), {
    schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/pi",
    runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, pi_session: session, pi_session_path: sessionPath, launch_receipt: receipt },
  });
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: session, pi_session_path: sessionPath, herdr_session: "forge", pane: "w1:p2" });
  await atomicYaml(join(root, "work", "demo", "tasks", `${taskId}.yaml`), {
    schema: "atdd-workflow/task/v1", title: "Runtime directive", coordinator: "main@demo", assignee: seat,
    status: lifecycle === "TODO" ? "todo" : lifecycle === "REVIEW" ? "review" : lifecycle === "DONE" ? "done" : "in_progress",
    ...(phase ? { phase, handoff: { state: "awaiting_assignee", evidence: "M-phase", updated_at: "2026-10-10T12:00:00.000Z" } } : {}),
    ...(lifecycle === "BLOCKED" ? { blocker: "Await coordinator contract decision." } : {}),
    done_when: [{ text: "Deliver the runtime directive." }],
  });
}

async function queueStaleMail() {
  const thread = "T-stale-directive";
  const message = "M-stale-directive";
  await atomicYaml(join(root, "threads", thread, "thread.yaml"), {
    schema: "atdd-workflow/thread/v1", id: thread, participants: ["main@demo", seat], subject: "Stale native mail", state: "open",
  });
  await atomicYaml(join(root, "threads", thread, `${message}.yaml`), {
    schema: "atdd-workflow/message/v1", id: message, from: "main@demo", to: [seat], created_at: "2026-10-10T12:00:00.000Z", body: "Implement another task instead.",
  });
  await atomicYaml(join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(seat), "pending", "S-stale.yaml"), {
    schema: "atdd-flow/pi-inbox-segment/v1", entries: [{ thread, message, created_at: "2026-10-10T12:00:00.000Z", published: true }],
  });
  await atomicYaml(join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(seat), "queue.yaml"), {
    schema: "atdd-flow/pi-inbox-queue/v1", head: "S-stale", tail: "S-stale",
  });
}

async function startPi(lifecycle: Lifecycle, staleMail = false) {
  useEnvironment();
  await taskFixture(lifecycle);
  if (staleMail) await queueStaleMail();
  const sent: Sent[] = [];
  let start: ((event: unknown, context: { hasUI: boolean }) => Promise<void>) | undefined;
  let shutdown: (() => void) | undefined;
  installFlowExtension({
    on(event: string, listener: unknown) {
      if (event === "session_start") start = listener as typeof start;
      if (event === "session_shutdown") shutdown = listener as typeof shutdown;
    },
    sendMessage(message: Sent) { sent.push(message); },
  } as never);
  await start?.({}, { hasUI: false });
  // Startup injects one action; the queued mail wake must not add a second copy while it is pending.
  for (let attempt = 0; attempt < 100 && sent.filter((message) => message.customType === "atdd-flow-mail").length < (staleMail ? 1 : 0); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  shutdown?.();
  return sent;
}

const expected: Record<Lifecycle, string> = {
  TODO: "Start assigned ready task",
  PLAN: "Prepare and submit PLAN handoff",
  RED: "Commit focused test-only RED handoff",
  GREEN: "Implement the accepted GREEN scope",
  REFACTOR: "Refactor only after GREEN acceptance",
  REVIEW: "Await coordinator review; do not continue implementation",
  DONE: "",
  BLOCKED: "",
};

// Terminal tasks and blocked assignees receive no injected action (next-action-notice-correctness).
const silent: Lifecycle[] = ["DONE", "BLOCKED"];

test("RED: Pi startup and reconciliation inject the authoritative task-derived next action for every lifecycle state", async () => {
  for (const lifecycle of Object.keys(expected) as Lifecycle[]) {
    const sent = await startPi(lifecycle, true);
    const directives = sent.filter((message) => message.customType === "atdd-flow-next-action");
    // One action is injected at startup; the reconciliation wake coalesces into it while it is pending.
    expect(directives, lifecycle).toHaveLength(silent.includes(lifecycle) ? 0 : 1);
    for (const directive of directives) {
      expect(directive).toMatchObject({
        content: expect.stringContaining(expected[lifecycle]),
        details: { project: "demo", task: taskId, lifecycle, authority: "task" },
      });
    }
  }
});

test("RED: stale native mail is advisory and cannot become a second next-action authority", async () => {
  const sent = await startPi("GREEN", true);
  const directives = sent.filter((message) => message.customType === "atdd-flow-next-action");
  expect(directives).toHaveLength(1);
  expect(directives.every((directive) => directive.content?.includes(expected.GREEN) && directive.details?.authority === "task")).toBe(true);
  expect(directives.some((directive) => directive.content?.includes("another task"))).toBe(false);
});
