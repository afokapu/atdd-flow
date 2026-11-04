// URN: test:flow:same-session-compaction-wiring
// Acceptance: acc:flow:E032-UNIT-001
// Phase: UNIT
// Layer: integration
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fixture, handover, installFixtureCleanup, live, seatAddress } from "./compaction-fixtures";

/**
 * The real Flow Pi extension is installed into a fake Pi in a child process; the child runs the real CLI to record
 * the handover, exactly as a seat would. Throwaway Desk only: no live seat, session, pane, binding or Desk is touched.
 */
installFixtureCleanup();

const repo = join(import.meta.dir, "..");
const extension = join(repo, "extensions", "pi", "index.ts");
const cli = join(repo, "src", "cli.ts");
const header = (root: string) => `
import installFlowExtension from ${JSON.stringify(extension)};
import { writeFileSync, readFileSync } from "node:fs";
const sent = []; const listeners = {}; const results = {};
installFlowExtension({ on(event, listener) { (listeners[event] ??= []).push(listener); }, sendMessage(message, options) { sent.push({ ...message, options }); } });
const ctxAt = (percent) => ({ getContextUsage: () => (percent === null ? null : { percent }), sessionManager: { getBranch: () => [{ id: "e1" }, { id: "e2" }] }, shutdown() { sent.push({ customType: "shutdown-called" }); } });
const fire = async (event, payload = {}, ctx = ctxAt(null)) => { const out = []; for (const listener of listeners[event] ?? []) { const value = await listener(payload, ctx); if (value !== undefined) out.push(value); } return out; };
const record = (file) => { const run = Bun.spawnSync([process.execPath, ${JSON.stringify(cli)}, "--root", ${JSON.stringify(root)}, "handover", ${JSON.stringify(seatAddress)}, "--file", file], { env: process.env }); if (run.exitCode) throw new Error(run.stderr.toString()); };
const goodEntry = () => ({ id: "c1", firstKeptEntryId: "c1", summary: results.settle?.[0]?.entries?.[0]?.summary ?? "" });
`;

type Message = { customType?: string; content?: string; options?: { triggerTurn?: boolean; deliverAs?: string }; details?: { path?: string; reason?: string } };
type Run = { sent: Message[]; results: Record<string, any> };

async function run(f: Awaited<ReturnType<typeof fixture>>, body: string, env: Record<string, string | undefined> = {}) {
  const input = join(f.root, "handover-input.txt");
  await writeFile(input, handover("H-wire-1"));
  const base: Record<string, string | undefined> = {
    ...process.env, ATDD_WORKFLOW_ROOT: f.root, ATDD_WORKFLOW_SEAT: seatAddress, ATDD_FLOW_PI_SESSION: live.pi_session,
    ATDD_FLOW_HERDR_SESSION: live.herdr_session, ATDD_FLOW_HERDR_PANE: live.pane,
  };
  const merged = { ...base, ...env };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  const script = `${header(f.root)}\nconst input = ${JSON.stringify(input)};\nawait (async () => {\n${body}\n})();\nconsole.log(JSON.stringify({ sent, results }));\nprocess.exit(0);`;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: f.root, env: merged as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`driver failed: ${stderr}`);
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as Run;
}

const paths = (sent: Message[]) => sent.filter((m) => m.details?.path).map((m) => m.details!.path);
const reasons = (sent: Message[]) => sent.map((m) => m.details?.reason).filter(Boolean);
const quiet = async (f: Awaited<ReturnType<typeof fixture>>) => {
  expect(existsSync(f.checkpointFile)).toBe(false);
  expect(existsSync(join(f.root, ".atdd-flow", "handover-replacements"))).toBe(false);
  expect((await readdir(join(f.root, ".atdd-flow"))).sort()).toEqual(["runtime-launch"]);
};

test("in the window the seat is asked once per session for a same-session compaction handover carrying the bundle", async () => {
  const f = await fixture();
  const { sent } = await run(f, `
    await fire("turn_end", {}, ctxAt(79));
    await fire("turn_end", {}, ctxAt(85));
    await fire("turn_end", {}, ctxAt(86));
    await fire("turn_end", {}, ctxAt(null));`);
  expect(paths(sent)).toEqual(["compaction"]);
  const message = sent.find((m) => m.details?.path)!;
  expect(message.customType).toBe("atdd-flow-context-handover-replacement");
  expect(message.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  expect(message.content).toContain("85%");
  expect(message.content).toContain("same-session compaction");
  expect(message.content).toContain("RECOVERY BUNDLE driver.delivery@demo");
  expect(message.content).not.toContain("do not compact");
  await quiet(f);
});

test("settling after the seat recorded its handover returns one self-retaining compaction entry with continue and writes the checkpoint", async () => {
  const f = await fixture();
  const { sent, results } = await run(f, `
    await fire("turn_end", {}, ctxAt(85));
    record(input);
    results.settle = await fire("agent_before_settle", { entries: [], continue: false }, ctxAt(85));`);
  expect(results.settle).toHaveLength(1);
  expect(results.settle[0].continue).toBe(true);
  expect(results.settle[0].entries).toHaveLength(1);
  const draft = results.settle[0].entries[0];
  expect(draft).toMatchObject({ type: "compaction", firstKeptEntryId: null, details: { seat: seatAddress, handover_id: "H-wire-1" } });
  expect(draft.summary).toContain("H-wire-1");
  expect(draft.summary).toContain("4. RESUME PROCEDURE AND NEXT ACTIONS");
  expect(draft.summary).toContain("RECOVERY BUNDLE driver.delivery@demo");
  expect(reasons(sent)).toEqual([]);
  expect(paths(sent)).toEqual(["compaction"]);
  const checkpoint = Bun.YAML.parse(await readFile(f.checkpointFile, "utf8")) as { seat: string; status: string; summary: string; next_action: string };
  expect(checkpoint).toMatchObject({ seat: seatAddress, status: "active" });
  expect(checkpoint.summary).toContain("H-wire-1");
  expect(checkpoint.next_action).toContain("handover show");
  expect(existsSync(join(f.root, ".atdd-flow", "handover-replacements"))).toBe(false);
});

test("a verified session_compact re-arms the session; the one-shot gate otherwise holds", async () => {
  const f = await fixture();
  const { sent, results } = await run(f, `
    await fire("turn_end", {}, ctxAt(85));
    record(input);
    results.settle = await fire("agent_before_settle", {}, ctxAt(85));
    await fire("session_compact", { compactionEntry: goodEntry(), fromExtension: true, reason: "threshold", willRetry: false });
    await fire("turn_end", {}, ctxAt(30));
    await fire("turn_end", {}, ctxAt(85));`);
  expect(reasons(sent)).toEqual([]);
  expect(paths(sent)).toEqual(["compaction", "compaction"]);
});

test("settling with nothing pending, or a compaction nobody asked for, does nothing", async () => {
  const f = await fixture();
  const { sent, results } = await run(f, `
    results.settle = await fire("agent_before_settle", {}, ctxAt(70));
    await fire("session_compact", { compactionEntry: { id: "m1", firstKeptEntryId: "x", summary: "manual" }, fromExtension: false, reason: "manual", willRetry: false });
    await fire("session_compact_failed", { reason: "manual", aborted: true, willRetry: false, fromExtension: false });`);
  expect(results.settle).toEqual([]);
  expect(sent).toEqual([]);
  await quiet(f);
});

test("above 90% fails closed to the Path-A fallback, records nothing, and never compacts even after a handover", async () => {
  const f = await fixture();
  const { sent, results } = await run(f, `
    await fire("turn_end", {}, ctxAt(91));
    record(input);
    results.settle = await fire("agent_before_settle", {}, ctxAt(91));`);
  expect(results.settle).toEqual([]);
  expect(paths(sent)).toEqual(["fallback"]);
  expect(reasons(sent)).toEqual(["above-window"]);
  const message = sent[0]!;
  expect(message.content).toContain("above-window");
  expect(message.content).toContain("do not compact");
  expect(message.content).toContain("Path-A");
  expect(existsSync(f.checkpointFile)).toBe(false);
  expect(existsSync(join(f.root, ".atdd-flow", "handover-replacements"))).toBe(false);
});

test("without a live Flow identity the primary path is unavailable and the fallback is sent once", async () => {
  const f = await fixture();
  const { sent } = await run(f, `
    await fire("turn_end", {}, ctxAt(85));
    await fire("turn_end", {}, ctxAt(86));`, { ATDD_FLOW_HERDR_PANE: undefined });
  expect(paths(sent)).toEqual(["fallback"]);
  expect(reasons(sent)).toEqual(["identity-unavailable"]);
  await quiet(f);
});

test("a run that settles with no handover recorded after the prompt fails closed and writes no checkpoint", async () => {
  const f = await fixture();
  const { sent, results } = await run(f, `
    await fire("turn_end", {}, ctxAt(85));
    results.settle = await fire("agent_before_settle", {}, ctxAt(85));
    results.again = await fire("agent_before_settle", {}, ctxAt(85));
    await fire("turn_end", {}, ctxAt(86));`);
  expect(results.settle).toEqual([]);
  expect(results.again).toEqual([]);
  expect(paths(sent)).toEqual(["compaction", "fallback"]);
  expect(reasons(sent)).toEqual(["handover-not-recorded"]);
  expect(sent[1]!.content).toContain("do not compact");
  await quiet(f);
});

test("a handover recorded before the prompt is stale and is not adopted", async () => {
  const f = await fixture();
  const input = join(f.root, "handover-before.txt");
  await writeFile(input, handover("H-before"));
  const recorded = Bun.spawnSync([process.execPath, cli, "--root", f.root, "handover", seatAddress, "--file", input]);
  expect(recorded.exitCode).toBe(0);
  await Bun.sleep(20);
  const { sent, results } = await run(f, `
    await fire("turn_end", {}, ctxAt(85));
    results.settle = await fire("agent_before_settle", {}, ctxAt(85));`);
  expect(results.settle).toEqual([]);
  expect(reasons(sent)).toEqual(["handover-not-recorded"]);
  expect(existsSync(f.checkpointFile)).toBe(false);
});

test("a recorded handover that no longer validates fails closed", async () => {
  const f = await fixture();
  const { sent, results } = await run(f, `
    await fire("turn_end", {}, ctxAt(85));
    writeFileSync(${JSON.stringify(f.handoverFile)}, JSON.stringify({ schema: "atdd-workflow/handover/v1", seat: ${JSON.stringify(seatAddress)}, handover_id: "H-bad", supersedes: "none", recorded_at: new Date().toISOString(), text: "garbage" }));
    results.settle = await fire("agent_before_settle", {}, ctxAt(85));`);
  expect(results.settle).toEqual([]);
  expect(reasons(sent)).toEqual(["invalid-handover"]);
  expect(existsSync(f.checkpointFile)).toBe(false);
});

test("identity drift between the prompt and the settle fails closed before any draft exists", async () => {
  const f = await fixture();
  const { sent, results } = await run(f, `
    await fire("turn_end", {}, ctxAt(85));
    record(input);
    writeFileSync(${JSON.stringify(f.seatFile)}, readFileSync(${JSON.stringify(f.seatFile)}, "utf8").replace("pane: ${live.pane}", "pane: w9:p9"));
    results.settle = await fire("agent_before_settle", {}, ctxAt(85));`);
  expect(results.settle).toEqual([]);
  expect(reasons(sent)).toEqual(["identity-drift"]);
});

test("a compaction that is not self-retaining, drifts identity, or fails routes to the fallback and keeps the session disarmed", async () => {
  const cases: [string, string, string][] = [
    ["postcondition", `await fire("session_compact", { compactionEntry: { id: "c1", firstKeptEntryId: "deadbeef", summary: "x" }, fromExtension: true, reason: "threshold", willRetry: false });`, "postcondition"],
    ["identity", `writeFileSync(SEAT, readFileSync(SEAT, "utf8").replace("pane: ${live.pane}", "pane: w9:p9")); await fire("session_compact", { compactionEntry: goodEntry(), fromExtension: true, reason: "threshold", willRetry: false });`, "identity-drift"],
    ["failed", `await fire("session_compact_failed", { reason: "threshold", errorMessage: "boom", aborted: false, willRetry: false, fromExtension: true });`, "compaction-failed"],
    ["aborted", `await fire("session_compact_failed", { reason: "threshold", aborted: true, willRetry: false, fromExtension: true });`, "compaction-failed"],
  ];
  for (const [, step, reason] of cases) {
    const f = await fixture();
    const { sent, results } = await run(f, `
      const SEAT = ${JSON.stringify(f.seatFile)};
      await fire("turn_end", {}, ctxAt(85));
      record(input);
      results.settle = await fire("agent_before_settle", {}, ctxAt(85));
      ${step}
      await fire("turn_end", {}, ctxAt(30));
      await fire("turn_end", {}, ctxAt(85));`);
    expect(results.settle).toHaveLength(1);
    expect(reasons(sent)).toEqual([reason]);
    expect(paths(sent)).toEqual(["compaction", "fallback"]);
    expect(sent[1]!.content).toContain("do not compact");
    expect(existsSync(join(f.root, ".atdd-flow", "handover-replacements"))).toBe(false);
  }
});

test("production reachability: the extension entry point imports the engine and registers its boundary handlers", async () => {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/^import[^;]*?from "(\.[^"]+)";/gms)) {
      for (const candidate of [resolve(dirname(file), `${match[1]}.ts`), resolve(dirname(file), match[1]!)]) if (existsSync(candidate) && candidate.endsWith(".ts")) { walk(candidate); break; }
    }
  };
  walk(extension);
  expect(seen.has(join(repo, "src", "compaction-handover.ts"))).toBe(true);
  const f = await fixture();
  const { results } = await run(f, `results.events = Object.keys(listeners).sort();`);
  for (const event of ["agent_before_settle", "session_compact", "session_compact_failed", "turn_end"]) expect(results.events).toContain(event);
});

test("the wiring layer, like the engine, imports no launch, multiplexer or replacement code", async () => {
  for (const file of ["compaction-handover.ts", "compaction-session.ts"]) {
    const source = await readFile(join(repo, "src", file), "utf8");
    for (const forbidden of ["pi-runtime-launch", "stale-main-recovery", "multiplexer", "requestHandoverReplacement", "Bun.spawn", "node:child_process"]) expect(source).not.toContain(forbidden);
  }
});
