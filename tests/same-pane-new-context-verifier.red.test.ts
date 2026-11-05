// URN: test:atdd-flow:same-pane-new-context-verifier
// Acceptance: acc:flow:E003-UNIT-001
// Phase: UNIT
//
// RED contract for task same-pane-new-context-verifier-20261104 (owner fleet procedure M-20261104T182609Z-owner-decision_ecd3938c):
// source-authored handover -> `/new` in the same bound pane and Pi process -> fresh context resumes from `handover show`.
// `/new` mints a new Pi session id and JSONL (feasibility M-20261104T180404Z), so the stale launcher env and the seat's recorded
// pi_session/pi_session_path no longer match the live Pi. The Flow extension must, on session_start reason "new", verify the lineage
// and refresh the durable runtime binding itself, with no Path-A request, no launch, no bind, no pane change and no compaction.
//
// Quiescence (returned RED M-20261104T202408Z): `/new` is allowed only from a quiescent point, meaning no in-flight push, rebase,
// review submission or test run. The supported signals GREEN must verify, each fail-closed when false OR unavailable/unknown:
//   (1) live Pi: on `session_before_switch` (reason "new") ctx.isIdle() === true and ctx.hasPendingMessages() === false. Both functions
//       must exist; a host that lacks either is "quiescence unknown" and refuses. A tool call (push, rebase, review, test) keeps the agent
//       non-idle, so this is the Pi-visible proof that none is running.
//   (2) source-authored: the recorded handover's section 2 declares exactly `- IN-FLIGHT: none`; any other IN-FLIGHT operation, or no
//       IN-FLIGHT line at all, is not quiescent.
//   (3) the gate leaves a durable attestation, so session_start (a reloaded extension instance in the same process) refuses a `/new` that
//       never passed the gate. A refused gate returns { cancel: true } from session_before_switch, so the switch does not happen.
import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicYaml, paths } from "../src/core";
import { handoverReplacementPath } from "../src/handover";
import { installCleanup, populated, seatRecord, session } from "./seat-recovery-fixtures";

installCleanup();

const extension = join(import.meta.dir, "..", "extensions", "pi", "index.ts");
const handoverId = "H-newctx";
const newSession = "01a2aaaa-1111-4111-8111-111111111111";
const secondSession = "01a2bbbb-2222-4222-8222-222222222222";
const otherSession = "99999999-9999-4999-8999-999999999999";

type Sent = { customType?: string; content?: string; options?: { triggerTurn?: boolean } };
type Scenario = {
  role?: "driver" | "main";
  handover?: "valid" | "none" | "malformed" | "other-seat" | "third-party" | "in-flight" | "no-inflight-line";
  /** Pi-visible quiescence at session_before_switch; "unknown" means the host exposes neither isIdle nor hasPendingMessages. */
  quiescence?: "idle" | "busy" | "pending" | "unknown";
  /** false: the switch reaches session_start without passing the session_before_switch gate. */
  gate?: boolean;
  /** Live Herdr pane / session when it differs from the bound pane. */
  pane?: string;
  herdrSession?: string;
  /** Pi's reported previous session file: the bound one, or an unrelated one. */
  previous?: "bound" | "other";
  /** The live session id equals the bound one, so `/new` did not happen. */
  sameSession?: boolean;
  /** An active Path-A request names this seat. */
  request?: boolean;
  /** The seat has no native Herdr binding. */
  unbound?: boolean;
  /** A second `/new` in the same process reusing the first handover. */
  replay?: boolean;
  /** session_start reason; only "new" may refresh the binding. */
  reason?: string;
};
type Outcome = {
  sent: Sent[];
  forbidden: string[];
  /** The session_before_switch gate returned { cancel: true }, so Pi never switched sessions. */
  cancelled: boolean;
  herdrCalls: string[];
  before: string;
  after: string;
  seat: string;
  newPath: string;
  receipt: Record<string, any> | undefined;
};

const inFlight = { valid: "- IN-FLIGHT: none", "in-flight": "- IN-FLIGHT: git push origin delivery/x | started 2026-10-15T10:59:00Z | check: git status | retry-safe: yes", "no-inflight-line": "- no operations listed" };
const handoverText = (seat: string, writer: string, runtimeSession: string, flight: string = inFlight.valid) =>
  `HANDOVER ${writer} | 2026-10-15T11:00:00Z | handover-id ${handoverId} | supersedes none\nRuntime: herdr forge:w1:p2 | pi session ${runtimeSession} | model test/pi | context 85%\n\n1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS\n- exact ${seat}\n\n2. OPEN WORK AND IN-FLIGHT OPERATIONS\n- task alpha\n${flight}\n\n3. DEPENDENCIES (both directions)\n- none\n\n4. RESUME PROCEDURE AND NEXT ACTIONS\n- run bun test\n`;

// Fake Pi host. Session replacement, compaction and reload are never legitimate here, so any call is recorded as forbidden.
// The launcher env is deliberately stale after `/new`: it still names the original session.
const driver = `
import installFlowExtension from ${JSON.stringify(extension)};
const scenario = JSON.parse(process.env.NEW_SCENARIO);
const sent = []; const listeners = {}; const forbidden = [];
installFlowExtension({
  on(event, listener) { (listeners[event] ??= []).push(listener); },
  sendMessage(message, options) { sent.push({ ...message, options }); },
  sendUserMessage() {},
});
const trap = (ctx) => { for (const name of ["compact", "newSession", "fork", "switchSession", "navigateTree", "reload"]) ctx[name] = () => { forbidden.push(name); throw new Error(name + " is not allowed"); }; return ctx; };
const context = (id, path) => trap({ hasUI: false, getContextUsage: () => ({ percent: 5 }), shutdown() { forbidden.push("shutdown"); }, sessionManager: { getSessionId: () => id, getSessionFile: () => path, getBranch: () => [] } });
const quiescence = scenario.quiescence ?? "idle";
const gateContext = (id, path) => { const ctx = context(id, path); if (quiescence !== "unknown") { ctx.isIdle = () => quiescence !== "busy"; ctx.hasPendingMessages = () => quiescence === "pending"; } return ctx; };
let cancelled = false;
// Pi calls session_before_switch first; a { cancel: true } result stops the switch, so session_start never follows.
const gate = async (id, path, target) => { if (scenario.gate === false) return; for (const listener of listeners.session_before_switch ?? []) { const result = await listener({ type: "session_before_switch", reason: "new", targetSessionFile: target }, gateContext(id, path)); if (result?.cancel === true) cancelled = true; } };
const done = new Set(["atdd-flow-same-pane-new-resumed", "atdd-flow-same-pane-new-refused"]);
const settle = async (count) => { for (let i = 0; i < 600 && sent.filter((entry) => done.has(entry.customType)).length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); await new Promise((resolve) => setTimeout(resolve, 60)); };
const emit = async (event, payload, ctx) => { for (const listener of listeners[event] ?? []) await listener(payload, ctx); };
const live = scenario.sameSession ? process.env.NEW_BOUND_SESSION : process.env.NEW_SESSION;
const livePath = scenario.sameSession ? process.env.NEW_BOUND_PATH : process.env.NEW_PATH;
const previous = scenario.previous === "other" ? process.env.NEW_OTHER_PATH : process.env.NEW_BOUND_PATH;
const isNew = !scenario.reason || scenario.reason === "new";
if (isNew) await gate(process.env.NEW_BOUND_SESSION, process.env.NEW_BOUND_PATH, livePath);
if (!cancelled) await emit("session_start", { reason: scenario.reason ?? "new", previousSessionFile: previous }, context(live, livePath));
await settle(isNew ? 1 : 0);
if (scenario.replay) {
  await emit("session_shutdown", { reason: "new" }, {});
  await gate(process.env.NEW_SESSION, process.env.NEW_PATH, process.env.NEW_SECOND_PATH);
  await emit("session_start", { reason: "new", previousSessionFile: process.env.NEW_PATH }, context(process.env.NEW_SECOND_SESSION, process.env.NEW_SECOND_PATH));
  await settle(2);
}
await emit("session_shutdown", { reason: "quit" }, {});
console.log(JSON.stringify({ sent, forbidden, cancelled }));
process.exit(0);`;

async function run(scenario: Scenario): Promise<Outcome> {
  const { root, worktree } = await populated();
  const role = scenario.role ?? "driver";
  const seat = role === "main" ? "main@demo" : "driver.pi@demo";
  const seatFile = join(root, "work", "demo", "seats", role === "main" ? "main" : "driver.pi", "seat.yaml");
  const boundPath = join(root, "sessions", `bound_${session}.jsonl`);
  const otherPath = join(root, "sessions", `other_${otherSession}.jsonl`);
  const newPath = join(root, "sessions", `new_${newSession}.jsonl`);
  const secondPath = join(root, "sessions", `second_${secondSession}.jsonl`);
  await mkdir(join(root, "sessions"), { recursive: true });
  for (const file of [boundPath, otherPath, newPath, secondPath]) await writeFile(file, '{"type":"session"}\n');
  const runtime = scenario.unbound ? undefined : { application: "herdr", wake: "native", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, pi_session: session, pi_session_path: boundPath };
  await seatRecord(root, seat, worktree, runtime);
  const bin = join(root, "bin"), log = join(root, "herdr.log");
  await mkdir(bin);
  await writeFile(join(bin, "herdr"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit 1\n`);
  await chmod(join(bin, "herdr"), 0o755);
  const source = scenario.handover === "third-party" ? otherSession : session;
  if (scenario.handover && scenario.handover !== "none") {
    const flight = scenario.handover === "in-flight" || scenario.handover === "no-inflight-line" ? inFlight[scenario.handover] : inFlight.valid;
    const text = scenario.handover === "malformed" ? "not a handover\n" : handoverText(seat, scenario.handover === "other-seat" ? "driver.other@demo" : seat, source, flight);
    await atomicYaml(paths(root).handoverFile(seat), { schema: "atdd-workflow/handover/v1", seat, handover_id: handoverId, supersedes: "none", recorded_at: "2026-10-15T11:00:00.000Z", text });
  }
  if (scenario.request) {
    await atomicYaml(handoverReplacementPath(root, seat), {
      schema: "atdd-flow/context-handover-replacement-request/v1", seat, task: "t", handover: { id: handoverId, sha256: "x" }, authorization: { id: "A", hash: "h" },
      source: { pi_session: session, pi_session_path: boundPath, herdr_session: "forge", pane: "w1:p2" }, target: { herdr_session: "forge", pane: "w1:p2", cwd: "/tmp" }, created_at: "2026-10-15T09:00:00.000Z",
    });
  }
  const before = await readFile(seatFile, "utf8");
  const pane = scenario.pane ?? "w1:p2", herdrSession = scenario.herdrSession ?? "forge";
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: seat,
    ATDD_FLOW_PI_SESSION: session, ATDD_FLOW_HERDR_SESSION: herdrSession, ATDD_FLOW_HERDR_PANE: pane, HERDR_SESSION: herdrSession, HERDR_PANE_ID: pane,
    NEW_SCENARIO: JSON.stringify(scenario), NEW_SESSION: newSession, NEW_PATH: newPath, NEW_BOUND_SESSION: session, NEW_BOUND_PATH: boundPath,
    NEW_OTHER_PATH: otherPath, NEW_SECOND_SESSION: secondSession, NEW_SECOND_PATH: secondPath,
  };
  const child = Bun.spawn([process.execPath, "-e", driver], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(`${exitCode} ${exitCode ? stderr : ""}`.trim()).toBe("0");
  const { sent, forbidden, cancelled } = JSON.parse(stdout.trim().split("\n").at(-1)!) as { sent: Sent[]; forbidden: string[]; cancelled: boolean };
  const after = await readFile(seatFile, "utf8");
  const record = Bun.YAML.parse(after) as { runtime?: { launch_receipt?: string } };
  const receiptPath = record.runtime?.launch_receipt;
  const receipt = receiptPath && receiptPath !== (Bun.YAML.parse(before) as any).runtime?.launch_receipt ? Bun.YAML.parse(await readFile(receiptPath, "utf8")) as Record<string, any> : undefined;
  const herdrCalls = await readFile(log, "utf8").then((text) => text.split("\n").filter(Boolean), () => []);
  return { sent, forbidden, cancelled, herdrCalls, before, after, seat, newPath, receipt };
}

const resumed = (outcome: Outcome) => outcome.sent.filter((entry) => entry.customType === "atdd-flow-same-pane-new-resumed");
const refused = (outcome: Outcome) => outcome.sent.filter((entry) => entry.customType === "atdd-flow-same-pane-new-refused");
const runtimeOf = (text: string) => (Bun.YAML.parse(text) as { runtime: Record<string, any> }).runtime;

for (const role of ["driver", "main"] as const) {
  test(`RED: a source-authored handover then /new in the same pane refreshes the ${role} binding and resumes without Path-A`, async () => {
    const outcome = await run({ role, handover: "valid" });
    // Durable binding now names the fresh Pi; the seat, application, Herdr pane and wake mode are exactly the lineage that was bound.
    const before = runtimeOf(outcome.before), after = runtimeOf(outcome.after);
    expect(after).toMatchObject({ application: "herdr", wake: "native", addresses: before.addresses, pi_session: newSession, pi_session_path: outcome.newPath });
    // A receipt records the exact lineage so recovery and wake can verify the refreshed session.
    expect(outcome.receipt).toMatchObject({
      schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: outcome.seat, pi_session: newSession, pi_session_path: outcome.newPath, herdr_session: "forge", pane: "w1:p2",
      same_pane_new: { handover: handoverId, previous_pi_session: session },
    });
    // One resume turn through the normal handover contract, in this same process.
    expect(resumed(outcome)).toHaveLength(1);
    expect(refused(outcome)).toHaveLength(0);
    const [prompt] = resumed(outcome);
    expect(prompt!.content).toContain("RESUMED");
    expect(prompt!.content).toContain(handoverId);
    expect(prompt!.content).toContain(`atdd-flow handover show ${outcome.seat}`);
    expect(prompt!.options).toMatchObject({ triggerTurn: true });
    // No launch, bind, pane change, compaction or session replacement was needed or attempted.
    expect(outcome.herdrCalls).toEqual([]);
    expect(outcome.forbidden).toEqual([]);
  });
}

const refusals: [string, Scenario, string][] = [
  ["no handover is recorded", { handover: "none" }, "no recorded handover"],
  ["the recorded handover is malformed", { handover: "malformed" }, "invalid handover"],
  ["the handover header names a different seat", { handover: "other-seat" }, "invalid handover"],
  ["the handover was reconstructed by a third party (its Runtime line names a Pi session the seat never bound)", { handover: "third-party" }, "different pi session"],
  ["the live Herdr pane changed", { handover: "valid", pane: "w9:p9" }, "pane"],
  ["the live Herdr session changed", { handover: "valid", herdrSession: "other" }, "pane"],
  ["Pi reports a previous session file that is not the bound one", { handover: "valid", previous: "other" }, "previous session"],
  ["the live session id is the bound one, so no /new happened", { handover: "valid", sameSession: true }, "not a new session"],
  ["an active Path-A request exists for the seat", { handover: "valid", request: true }, "path-a"],
  ["the seat has no native Herdr binding", { handover: "valid", unbound: true }, "native binding"],
];

for (const [label, scenario, reason] of refusals) {
  test(`RED: fail closed, binding untouched, no resume turn when ${label}`, async () => {
    const outcome = await run(scenario);
    expect(outcome.after).toBe(outcome.before);
    expect(outcome.receipt).toBeUndefined();
    expect(resumed(outcome)).toHaveLength(0);
    expect(outcome.sent.some((entry) => entry.options?.triggerTurn === true && entry.customType === "atdd-flow-same-pane-new-refused")).toBe(false);
    // A refusal is never silent: one display-only notice names the reason.
    expect(refused(outcome)).toHaveLength(1);
    expect(refused(outcome)[0]!.content!.toLowerCase()).toContain(reason);
    expect(outcome.herdrCalls).toEqual([]);
    expect(outcome.forbidden).toEqual([]);
  });
}

test("RED: the handover is single-use; a second /new reusing it is refused and the first refresh stays", async () => {
  const outcome = await run({ handover: "valid", replay: true });
  expect(resumed(outcome)).toHaveLength(1);
  expect(refused(outcome)).toHaveLength(1);
  expect(runtimeOf(outcome.after)).toMatchObject({ pi_session: newSession, pi_session_path: outcome.newPath });
  expect(outcome.forbidden).toEqual([]);
});

test("GUARD: only session_start reason new may refresh the binding", async () => {
  for (const reason of ["startup", "reload", "resume", "fork"]) {
    const outcome = await run({ handover: "valid", reason });
    expect({ reason, unchanged: outcome.after === outcome.before, resumed: resumed(outcome).length, forbidden: outcome.forbidden }).toEqual({ reason, unchanged: true, resumed: 0, forbidden: [] });
  }
});

// Quiescence. Each case must refuse with exactly one display-only notice, leave seat.yaml byte-identical, and never launch, bind,
// change a pane, compact or replace the session. `cancel` says whether the refusal happens at the gate (the switch is cancelled)
// or, for a switch that bypassed the gate, at session_start.
const quiescence: [string, Scenario, string, boolean][] = [
  ["the agent is not idle (a push, rebase, review submission or test run may be running)", { handover: "valid", quiescence: "busy" }, "not quiescent", true],
  ["messages are pending delivery", { handover: "valid", quiescence: "pending" }, "not quiescent", true],
  ["the host exposes no isIdle/hasPendingMessages, so quiescence is unknown", { handover: "valid", quiescence: "unknown" }, "quiescence unknown", true],
  ["the handover declares an IN-FLIGHT operation", { handover: "in-flight" }, "in-flight", true],
  ["the handover has no IN-FLIGHT declaration", { handover: "no-inflight-line" }, "in-flight", true],
  ["the switch reached session_start without passing the session_before_switch gate", { handover: "valid", gate: false }, "quiescence", false],
];

for (const [label, scenario, reason, cancel] of quiescence) {
  test(`RED: fail closed when quiescence is not proven: ${label}`, async () => {
    const outcome = await run(scenario);
    expect(outcome.cancelled).toBe(cancel);
    expect(outcome.after).toBe(outcome.before);
    expect(outcome.receipt).toBeUndefined();
    expect(resumed(outcome)).toHaveLength(0);
    expect(refused(outcome)).toHaveLength(1);
    expect(refused(outcome)[0]!.content!.toLowerCase()).toContain(reason);
    expect(refused(outcome)[0]!.options?.triggerTurn).not.toBe(true);
    expect(outcome.herdrCalls).toEqual([]);
    expect(outcome.forbidden).toEqual([]);
  });
}

test("RED: a quiescent seat passes the gate (not cancelled) and is refreshed", async () => {
  const outcome = await run({ handover: "valid", quiescence: "idle" });
  expect(outcome.cancelled).toBe(false);
  expect(runtimeOf(outcome.after)).toMatchObject({ pi_session: newSession, pi_session_path: outcome.newPath });
  expect(resumed(outcome)).toHaveLength(1);
});
