// URN: test:atdd-flow:seat-recovery-injection
// Acceptance: acc:flow:E004-UNIT-001
// Phase: UNIT
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicYaml } from "../src/core";
import { handoverReplacementPath } from "../src/handover";
import { recoveryBundle } from "../src/recovery-bundle";
import { installCleanup, now, seat, session, temp, git, repository, fakeGh, prJson, desk, seatRecord, task, thread, message, call, outcome, sessionFile, lines, field, snapshot, populated } from "./seat-recovery-fixtures";

installCleanup();

type Sent = { customType?: string; content?: string };
const extension = join(import.meta.dir, "..", "extensions", "pi", "index.ts");
// The extension reads Flow identity from process.env; a child process receives it explicitly so this test never mutates shared env.
const driver = `
import installFlowExtension from ${JSON.stringify(extension)};
const sent = []; const listeners = {};
installFlowExtension({ on(event, listener) { (listeners[event] ??= []).push(listener); }, sendMessage(message) { sent.push(message); } });
await listeners.session_start[0]({}, { hasUI: false });
for (let attempt = 0; attempt < 400 && !sent.some((entry) => entry.customType === "atdd-flow-start"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
for (const listener of listeners.turn_end ?? []) await listener({}, { getContextUsage: () => ({ percent: 85 }), shutdown() { sent.push({ customType: "shutdown-called" }); } });
await listeners.session_shutdown?.[0]?.({}, {});
console.log(JSON.stringify(sent));
process.exit(0);`;

async function drivePi(setup: (root: string) => Promise<void> = async () => {}) {
  const { root, worktree } = await populated();
  const receipt = join(root, ".atdd-flow", "runtime-launch", "verified.yaml");
  const seatFile = join(root, "work", "demo", "seats", "driver.pi", "seat.yaml");
  const record = Bun.YAML.parse(await readFile(seatFile, "utf8")) as { runtime: Record<string, unknown> };
  record.runtime.launch_receipt = receipt;
  await atomicYaml(seatFile, record);
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: session, pi_session_path: record.runtime.pi_session_path, herdr_session: "forge", pane: "w1:p2" });
  await setup(root);
  const env = { ...process.env, ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: seat, ATDD_FLOW_PI_SESSION: session, ATDD_FLOW_HERDR_SESSION: "forge", ATDD_FLOW_HERDR_PANE: "w1:p2" };
  const child = Bun.spawn([process.execPath, "-e", driver], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exitCode).toBe(0);
  return { sent: JSON.parse(stdout.trim().split("\n").at(-1)!) as Sent[], worktree };
}

test("RED: the Flow extension injects the bundle at session start and at the 80% handover threshold", async () => {
  const { sent, worktree } = await drivePi();
  const start = sent.find((entry) => entry.customType === "atdd-flow-start")!;
  expect(start.content).toContain("RECOVERY BUNDLE driver.pi@demo");
  expect(start.content).toContain(git(worktree, "rev-parse", "--short", "HEAD"));
  const threshold = sent.find((entry) => entry.customType === "atdd-flow-context-handover-replacement" && entry.content?.includes("85%"))!;
  expect(threshold.content).toContain("RECOVERY BUNDLE driver.pi@demo");
});

test("RED: the Flow extension injects the bundle into the Path-A successor prompt", async () => {
  const source = "/sessions/predecessor.jsonl";
  const { sent } = await drivePi(async (root) => {
    await atomicYaml(handoverReplacementPath(root, seat), {
      schema: "atdd-flow/context-handover-replacement-request/v1", seat, task: "t", handover: { id: "H-9", sha256: "x" }, authorization: { id: "A", hash: "h" },
      source: { pi_session: "predecessor", pi_session_path: source, herdr_session: "forge", pane: "w1:p2" }, target: { herdr_session: "forge", pane: "w1:p2", cwd: "/tmp" }, created_at: "2026-10-15T09:00:00.000Z",
    });
  });
  const successor = sent.find((entry) => entry.customType === "atdd-flow-context-handover-replacement" && entry.content?.includes("H-9"))!;
  expect(successor.content).toContain("RECOVERY BUNDLE driver.pi@demo");
  expect(successor.content).toContain(source);
});

const sourceNotice = (sent: Sent[]) => sent.filter((entry) => entry.content?.includes("Validated Path-A request"));

/** An active request whose source is this very Pi; `embedded` records it (or another request) in the Pi's own launcher receipt. */
async function liveSourceRequest(root: string, embedded: "exact" | "other" | "none") {
  const receipt = join(root, ".atdd-flow", "runtime-launch", "verified.yaml");
  const launched = Bun.YAML.parse(await readFile(receipt, "utf8")) as Record<string, unknown>;
  const request = {
    schema: "atdd-flow/context-handover-replacement-request/v1", seat, task: "t", handover: { id: "H-9", sha256: "x" }, authorization: { id: "A", hash: "h" },
    source: { pi_session: session, pi_session_path: launched.pi_session_path, herdr_session: "forge", pane: "w1:p2" }, target: { herdr_session: "forge", pane: "w1:p2", cwd: "/tmp" }, created_at: "2026-10-15T09:00:00.000Z",
  };
  await atomicYaml(handoverReplacementPath(root, seat), request);
  if (embedded !== "none") await atomicYaml(receipt, { ...launched, handover_replacement: { request: embedded === "exact" ? request : { ...request, task: "other" }, successor_session: session } });
}

test("RED: a Pi whose launcher receipt embeds the exact active request is not told to shut down; a genuine unconsumed source request still is", async () => {
  // Consumed: the request is the one that launched this Pi, so the successor/adopted Pi must not be shut down by its own request.
  const consumed = await drivePi((root) => liveSourceRequest(root, "exact"));
  expect(sourceNotice(consumed.sent)).toEqual([]);
  expect(consumed.sent.some((entry) => entry.customType === "shutdown-called")).toBe(false);
  // Unconsumed: the live Pi is the request source and no receipt embeds it, so the shutdown notice and shutdown are unchanged.
  const unconsumed = await drivePi((root) => liveSourceRequest(root, "none"));
  expect(sourceNotice(unconsumed.sent)).toHaveLength(1);
  expect(unconsumed.sent.some((entry) => entry.customType === "shutdown-called")).toBe(true);
  // Identity stays fail-closed: a receipt embedding a different request does not suppress the notice.
  const mismatched = await drivePi((root) => liveSourceRequest(root, "other"));
  expect(sourceNotice(mismatched.sent)).toHaveLength(1);
  expect(mismatched.sent.some((entry) => entry.customType === "shutdown-called")).toBe(true);
});

test("RED: `atdd-flow recover <address>` prints the bundle read-only", async () => {
  const { base, root, worktree } = await populated();
  const before = [...await snapshot(root), ...await snapshot(worktree)];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "--root", root, "recover", seat], { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("RECOVERY BUNDLE driver.pi@demo");
  expect(stdout).toContain("task alpha");
  expect([...await snapshot(root), ...await snapshot(worktree)]).toEqual(before);
  expect(base).toBeTruthy();
});

test("RED: a main seat coordinating 40 tasks and 30 threads lists actionable items first with totals inside the cap", async () => {
  const base = await temp("main");
  const root = join(base, "desk");
  await desk(root);
  await seatRecord(root, "main@demo", base);
  await seatRecord(root, seat, base);
  await fakeGh(base, "exit 1");
  const id = (index: number) => `t${String(index).padStart(2, "0")}`;
  for (let index = 1; index <= 20; index += 1) await task(root, id(index), { coordinator: "main@demo", assignee: seat, handoff: { state: "executing", evidence: "M-x", updated_at: "2026-10-15T00:00:00.000Z" } });
  for (let index = 21; index <= 37; index += 1) await task(root, id(index), { coordinator: "main@demo", assignee: seat, status: "todo" });
  await task(root, "t38", { phase: "red", handoff: { state: "awaiting_coordinator", evidence: "M-red", updated_at: "2026-10-15T00:00:00.000Z" } });
  await task(root, "t39", { status: "review" });
  await task(root, "t40", { blocker: "needs owner decision" });
  for (let index = 1; index <= 25; index += 1) {
    const threadId = `T-${String(index).padStart(2, "0")}-out`;
    await thread(root, threadId, `Outbound ${index}`);
    await message(root, threadId, `M-out-${index}`, { from: "main@demo", to: [seat], expects_result: true });
  }
  for (let index = 26; index <= 30; index += 1) {
    const threadId = `T-${index}-in`;
    await thread(root, threadId, `Inbound ${index}`);
    await message(root, threadId, `M-in-${index}`, {
      from: seat, to: ["main@demo"], expects_result: true,
      created_at: index === 26 ? "2026-10-01T00:00:00.000Z" : `2026-10-15T00:00:0${index - 26}.000Z`,
    });
  }
  const bundle = await recoveryBundle(root, "main@demo", { now });
  expect(lines(bundle.trimEnd()).length).toBeLessThanOrEqual(50);
  expect(new TextEncoder().encode(bundle).length).toBeLessThanOrEqual(5120);
  for (const needing of ["t38", "t39", "t40"]) {
    expect(bundle.indexOf(`task ${needing}`), needing).toBeGreaterThan(-1);
    expect(bundle.indexOf(`task ${needing}`)).toBeLessThan(bundle.indexOf("task t01"));
  }
  expect(bundle).toContain("task t01");
  expect(bundle).not.toContain("task t37");
  expect(field(bundle, "tasks:")).toMatch(/40 open.*3 need you.*20 in progress.*17 todo/);
  expect(field(bundle, "unanswered:")).toMatch(/5 inbound.*25 outbound/);
  expect(bundle.indexOf("inbound M-in-30")).toBeGreaterThan(-1);
  expect(bundle).not.toContain("inbound M-in-26");
  expect(bundle.indexOf("inbound M-in-30")).toBeLessThan(bundle.indexOf("outbound M-out-9"));
  expect(bundle).toMatch(/\+\d+ more, run atdd-flow status seat main@demo/);
});
