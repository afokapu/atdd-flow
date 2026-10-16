// URN: test:atdd-flow:host-attach-native-activation
// Acceptance: acc:flow:E003-UNIT-001
// Phase: UNIT
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml } from "../src/core";
import installFlowExtension from "../extensions/pi/index";

const seat = "driver.pi@demo";
const session = "01a12345-6789-7abc-8def-0123456789ab";
const sessionPath = `/Users/test/.pi/agent/sessions/demo/run_${session}.jsonl`;
const names = ["ATDD_WORKFLOW_ROOT", "ATDD_WORKFLOW_SEAT", "ATDD_FLOW_PI_SESSION", "ATDD_FLOW_HERDR_SESSION", "ATDD_FLOW_HERDR_PANE", "HERDR_SESSION", "HERDR_PANE_ID"] as const;

type Sent = { customType?: string; content?: string };
type Runtime = Record<string, unknown>;
type Options = { host?: { session: string; pane: string } | null; launcher?: boolean; mail?: "before" | "after" | "none" };

async function queueMail(root: string, message: string, created_at: string) {
  const thread = `T-${message}`, segment = `S-${message}`, inbox = join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(seat));
  await atomicYaml(join(root, "threads", thread, "thread.yaml"), { schema: "atdd-workflow/thread/v1", id: thread, participants: ["main@demo", seat], subject: "Host attach", state: "open" });
  await atomicYaml(join(root, "threads", thread, `${message}.yaml`), { schema: "atdd-workflow/message/v1", id: message, from: "main@demo", to: [seat], created_at, body: "wake" });
  await atomicYaml(join(inbox, "queue.yaml"), { schema: "atdd-flow/pi-inbox-queue/v1", head: segment, tail: segment });
  await atomicYaml(join(inbox, "pending", `${segment}.yaml`), { schema: "atdd-flow/pi-inbox-segment/v1", entries: [{ thread, message, created_at, published: true }] });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function hostAttach(runtime: Runtime | undefined, options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-host-attach-"));
  const saved = names.map((name) => [name, process.env[name]] as const);
  const sent: Sent[] = [];
  let start: ((event: unknown, context: unknown) => Promise<void>) | undefined;
  let shutdown: (() => void) | undefined;
  try {
    for (const name of names) delete process.env[name];
    const host = options.host === undefined ? { session: "forge", pane: "w1:p2" } : options.host;
    Object.assign(process.env, { ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: seat });
    if (host) Object.assign(process.env, { HERDR_SESSION: host.session, HERDR_PANE_ID: host.pane });
    if (options.launcher) Object.assign(process.env, { ATDD_FLOW_PI_SESSION: session, ATDD_FLOW_HERDR_SESSION: "forge", ATDD_FLOW_HERDR_PANE: "w1:p2" });
    if (runtime) {
      await atomicYaml(join(root, "work", "demo", "seats", "driver.pi", "seat.yaml"), {
        schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/pi",
        runtime: options.launcher ? { ...runtime, pi_session: session, pi_session_path: sessionPath, launch_receipt: join(root, "receipt.yaml") } : runtime,
      });
      if (options.launcher) await atomicYaml(join(root, "receipt.yaml"), { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: session, pi_session_path: sessionPath, herdr_session: "forge", pane: "w1:p2" });
    }
    if (options.mail !== "none") await queueMail(root, "M-before", "2026-10-15T12:00:00.000Z");
    installFlowExtension({
      on(event: string, listener: unknown) {
        if (event === "session_start") start = listener as typeof start;
        if (event === "session_shutdown") shutdown = listener as typeof shutdown;
      },
      sendMessage(value: Sent) { sent.push(value); },
    } as never);
    await start?.({}, { hasUI: false, sessionManager: { getSessionId: () => session, getSessionFile: () => sessionPath } });
    if (options.mail === "after") { await pause(5); await queueMail(root, "M-after", new Date().toISOString()); }
    await pause(200);
    shutdown?.();
    await pause(10);
    return { delivered: sent.filter((value) => value.customType === "atdd-flow-mail").length, sent };
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  }
}

const exact = (overrides: Runtime = {}): Runtime => ({ application: "herdr", wake: "native", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, ...overrides });
const notice = (sent: Sent[]) => sent.filter((value) => value.customType === "atdd-flow-start");

test("RED: host-attached seat with exact scoped session and pane activates native delivery once", async () => {
  expect((await hostAttach(exact(), { mail: "after" })).delivered).toBe(1);
  expect((await hostAttach(exact({ pi_session: session, pi_session_path: sessionPath }), { mail: "after" })).delivered).toBe(1);
});

test("RED: host-attach consumes pre-activation backlog without prompts and sends exactly one notice", async () => {
  const { delivered, sent } = await hostAttach(exact(), { mail: "before" });
  expect(delivered).toBe(0);
  expect(notice(sent)).toHaveLength(1);
  expect(notice(sent)[0].content).toBe(`Native mail active for ${seat} (host-attached). Notices created before this session were not replayed; run atdd-flow status seat ${seat} for unanswered mail.`);
});

test("RED: host-attach prompts once for mail created after activation while the backlog is consumed", async () => {
  const { delivered, sent } = await hostAttach(exact(), { mail: "after" });
  expect(delivered).toBe(1);
  expect(notice(sent)).toHaveLength(1);
});

test("RED: host-attach fallback refuses wrong pane, wrong session, scalar locator, host wake, receipt, mismatched session, and absent Herdr env", async () => {
  const refused: Array<[string, Runtime | undefined, Options?]> = [
    ["wrong pane", exact({ addresses: { herdr: { session: "forge", pane: "w1:p9" } } })],
    ["wrong session", exact({ addresses: { herdr: { session: "other", pane: "w1:p2" } } })],
    ["scalar locator", exact({ addresses: { herdr: "w1:p2" } })],
    ["wake host", exact({ wake: "host" })],
    ["wake absent", { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } } }],
    ["not herdr", exact({ application: "tmux" })],
    ["launch receipt present", exact({ launch_receipt: "/desk/.atdd-flow/runtime-launch/r.yaml" })],
    ["pi_session mismatch", exact({ pi_session: "other-session" })],
    ["pi_session_path mismatch", exact({ pi_session_path: "/other/run.jsonl" })],
    ["no seat runtime", undefined],
    ["no HERDR env", exact(), { host: null }],
  ];
  for (const [label, runtime, options] of refused) {
    const { delivered, sent } = await hostAttach(runtime, { mail: "after", ...options });
    expect(delivered, label).toBe(0);
    expect(notice(sent), label).toHaveLength(0);
  }
});

test("RED: launcher environment keeps the receipt-gated path, replays old mail, and ignores the host fallback", async () => {
  expect((await hostAttach(exact({ launch_receipt: undefined }), { launcher: true, mail: "before" })).delivered).toBe(1);
  expect((await hostAttach(undefined, { launcher: true, mail: "before" })).delivered).toBe(0);
});
