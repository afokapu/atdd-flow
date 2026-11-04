// URN: test:flow:same-session-compaction-engine
// Acceptance: acc:flow:E037-UNIT-001
// Phase: UNIT
// Layer: integration
import { expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  compactionDecision, createCompactionGate, planSameSessionCompaction, prepareHandover, buildCompactionDraft,
  requestCompaction, snapshotIdentity, compareIdentity, verifyCompaction,
} from "../src/compaction-handover";
import { branch, fixture, handover, installFixtureCleanup, live, note, seatAddress } from "./compaction-fixtures";

/**
 * Isolated contract for the T1-derived same-session compaction engine. Every test runs against a throwaway
 * Desk and an in-memory fake Pi `ctx`; nothing live (seat, session, pane, binding, Desk) is touched.
 */
installFixtureCleanup();

async function planInput(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return { root: f.root, seat: seatAddress, actor: seatAddress, live, percent: 85, gate: createCompactionGate(), handoverText: handover(), checkpoint: note, branchEntries: branch, bundle: "RECOVERY BUNDLE driver.delivery@demo | x", ...overrides };
}

test("decision window: threshold through 90 inclusive compacts, below waits, above 90 is typed fallback", () => {
  expect(compactionDecision(79, 80)).toBe("wait");
  expect(compactionDecision(80, 80)).toBe("compact");
  expect(compactionDecision(90, 80)).toBe("compact");
  expect(compactionDecision(91, 80)).toBe("fallback");
  expect(compactionDecision(84, 85)).toBe("wait");
  expect(compactionDecision(85, 85)).toBe("compact");
});

test("gate is one-shot per session and re-armed only by an explicit rearm", () => {
  const gate = createCompactionGate();
  expect(gate.arm("s1")).toBe(true);
  expect(gate.arm("s1")).toBe(false);
  expect(gate.arm("s2")).toBe(true);
  gate.rearm("s1");
  expect(gate.arm("s1")).toBe(true);
});

test("an invalid handover is a typed fallback and records neither handover nor checkpoint", async () => {
  const f = await fixture();
  const result = await prepareHandover({ root: f.root, seat: seatAddress, actor: seatAddress, handoverText: handover("H-1", { broken: true }), checkpoint: note });
  expect(result).toMatchObject({ ok: false, fallback: true, reason: "invalid-handover" });
  expect(existsSync(f.handoverFile)).toBe(false);
  expect(existsSync(f.checkpointFile)).toBe(false);
});

test("a valid handover records the handover and checkpoint for the seat", async () => {
  const f = await fixture();
  const result = await prepareHandover({ root: f.root, seat: seatAddress, actor: seatAddress, handoverText: handover("H-2"), checkpoint: note });
  expect(result).toMatchObject({ ok: true, handover_id: "H-2", seat: seatAddress });
  const recorded = Bun.YAML.parse(await readFile(f.handoverFile, "utf8")) as { handover_id: string; text: string; seat: string };
  expect(recorded).toMatchObject({ handover_id: "H-2", seat: seatAddress, text: handover("H-2") });
  const checkpoint = Bun.YAML.parse(await readFile(f.checkpointFile, "utf8")) as { status: string; summary: string; next_action: string; seat: string };
  expect(checkpoint).toMatchObject({ seat: seatAddress, status: "active", summary: note.summary, next_action: note.next_action });
});

test("self-service is limited to the seat's own address", async () => {
  const f = await fixture();
  const result = await prepareHandover({ root: f.root, seat: seatAddress, actor: "driver.other@demo", handoverText: handover("H-3"), checkpoint: note });
  expect(result).toMatchObject({ ok: false, fallback: true, reason: "foreign-seat" });
  expect(existsSync(f.handoverFile)).toBe(false);
  expect(existsSync(f.checkpointFile)).toBe(false);
});

test("the draft is self-retaining (firstKeptEntryId null) and its summary carries handover and bundle", async () => {
  const f = await fixture();
  const prepared = await prepareHandover({ root: f.root, seat: seatAddress, actor: seatAddress, handoverText: handover("H-4"), checkpoint: note });
  if (!prepared.ok) throw new Error("expected prepared");
  const built = buildCompactionDraft({ prepared, bundle: "RECOVERY BUNDLE marker", branchEntries: branch });
  if (!built.ok) throw new Error("expected draft");
  expect(built.draft).toMatchObject({ type: "compaction", firstKeptEntryId: null, details: { seat: seatAddress, handover_id: "H-4" } });
  expect(built.draft.summary).toContain("H-4");
  expect(built.draft.summary).toContain("2. OPEN WORK AND IN-FLIGHT OPERATIONS");
  expect(built.draft.summary).toContain("RECOVERY BUNDLE marker");
});

test("an explicit firstKeptEntryId must be a branch entry; unknown ids are refused", async () => {
  const f = await fixture();
  const prepared = await prepareHandover({ root: f.root, seat: seatAddress, actor: seatAddress, handoverText: handover("H-5"), checkpoint: note });
  if (!prepared.ok) throw new Error("expected prepared");
  expect(buildCompactionDraft({ prepared, branchEntries: branch, firstKeptEntryId: "deadbeef" })).toMatchObject({ ok: false, fallback: true, reason: "unknown-first-kept-entry" });
  const known = buildCompactionDraft({ prepared, branchEntries: branch, firstKeptEntryId: "e3" });
  expect(known.ok && known.draft.firstKeptEntryId).toBe("e3");
});

test("identity snapshot is stable across the primary path and any drift is a typed failure naming the field", async () => {
  const f = await fixture();
  const before = await snapshotIdentity(f.root, seatAddress, live);
  expect(compareIdentity(before, await snapshotIdentity(f.root, seatAddress, live))).toEqual({ ok: true });
  const drifts: [string, (text: string) => string, LiveIdentity?][] = [
    ["pi_session", (text) => text.replace(`pi_session: ${live.pi_session}`, "pi_session: other")],
    ["pi_session_path", (text) => text.replace("/tmp/pi/session.jsonl", "/tmp/pi/other.jsonl")],
    ["pane", (text) => text.replace(`pane: ${live.pane}`, "pane: w9:p9")],
    ["herdr_session", (text) => text.replace(`session: ${live.herdr_session}`, "session: other")],
  ];
  for (const [field, edit] of drifts) {
    const original = await readFile(f.seatFile, "utf8");
    await writeFile(f.seatFile, edit(original));
    const after = await snapshotIdentity(f.root, seatAddress, live);
    expect(compareIdentity(before, after)).toMatchObject({ ok: false, fallback: true, reason: "identity-drift" });
    expect(JSON.stringify(compareIdentity(before, after))).toContain(field);
    await writeFile(f.seatFile, original);
  }
  await writeFile(f.receipt, "schema: changed\n");
  expect(compareIdentity(before, await snapshotIdentity(f.root, seatAddress, live))).toMatchObject({ ok: false, reason: "identity-drift" });
  expect(compareIdentity(before, await snapshotIdentity(f.root, seatAddress, { ...live, pane: "w9:p9" }))).toMatchObject({ ok: false, reason: "identity-drift" });
});

test("postcondition: self-retaining entry, recorded handover and unchanged identity pass; anything else is a typed fallback", async () => {
  const f = await fixture();
  const planned = await planSameSessionCompaction(await planInput(f));
  if (!planned.ok || planned.action !== "compact") throw new Error("expected compact plan");
  const good = { compactionEntry: { id: "c1", firstKeptEntryId: "c1", summary: planned.entries[0].summary } };
  expect(await verifyCompaction({ root: f.root, seat: seatAddress, live, before: planned.identity, handover_id: planned.handover_id, event: good })).toEqual({ ok: true });
  const dangling = { compactionEntry: { id: "c1", firstKeptEntryId: "deadbeef", summary: "x" } };
  expect(await verifyCompaction({ root: f.root, seat: seatAddress, live, before: planned.identity, handover_id: planned.handover_id, event: dangling })).toMatchObject({ ok: false, fallback: true, reason: "postcondition" });
  expect(await verifyCompaction({ root: f.root, seat: seatAddress, live, before: planned.identity, handover_id: "H-other", event: good })).toMatchObject({ ok: false, reason: "postcondition" });
  expect(await verifyCompaction({ root: f.root, seat: seatAddress, live: { ...live, pane: "w9:p9" }, before: planned.identity, handover_id: planned.handover_id, event: good })).toMatchObject({ ok: false, reason: "identity-drift" });
});

test("ctx.compact refusals and failures are typed fallbacks; success is never assumed", async () => {
  const outcome = (run: (options: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void; customInstructions?: string }) => void) =>
    requestCompaction({ compact: run }, { customInstructions: "handover" });
  expect(await outcome((options) => options.onError?.(new Error("Nothing to compact (session too small)")))).toMatchObject({ ok: false, fallback: true, reason: "nothing-to-compact" });
  expect(await outcome((options) => options.onError?.(new Error("Already compacted")))).toMatchObject({ ok: false, reason: "already-compacted" });
  expect(await outcome((options) => options.onError?.(new Error("boom")))).toMatchObject({ ok: false, reason: "compaction-failed" });
  expect(await outcome(() => { throw new Error("sync boom"); })).toMatchObject({ ok: false, reason: "compaction-failed" });
  expect(await outcome((options) => options.onComplete?.({ summary: "s", firstKeptEntryId: null }))).toMatchObject({ ok: true, result: { summary: "s" } });
  let seen: string | undefined;
  await requestCompaction({ compact: (options) => { seen = options.customInstructions; options.onComplete?.({}); } }, { customInstructions: "forwarded" });
  expect(seen).toBe("forwarded");
});

test("the planner fires once inside the window, waits below it, and falls back above 90 recording nothing", async () => {
  const f = await fixture();
  const gate = createCompactionGate();
  expect(await planSameSessionCompaction(await planInput(f, { gate, percent: 79 }))).toMatchObject({ ok: true, action: "skip", reason: "below-threshold" });
  const fired = await planSameSessionCompaction(await planInput(f, { gate, percent: 85 }));
  expect(fired).toMatchObject({ ok: true, action: "compact", continue: true, handover_id: "H-20261104T070000Z-compaction" });
  if (fired.ok && fired.action === "compact") expect(fired.entries[0]).toMatchObject({ type: "compaction", firstKeptEntryId: null });
  expect(await planSameSessionCompaction(await planInput(f, { gate, percent: 86, handoverText: handover("H-next", { supersedes: "H-20261104T070000Z-compaction" }) }))).toMatchObject({ ok: true, action: "skip", reason: "already-armed" });
  const g = await fixture();
  expect(await planSameSessionCompaction(await planInput(g, { percent: 91 }))).toMatchObject({ ok: false, fallback: true, reason: "above-window" });
  expect(existsSync(g.handoverFile)).toBe(false);
  expect(existsSync(g.checkpointFile)).toBe(false);
});

test("the planner honours the Desk threshold", async () => {
  const f = await fixture({ threshold: 85 });
  expect(await planSameSessionCompaction(await planInput(f, { percent: 84 }))).toMatchObject({ ok: true, action: "skip", reason: "below-threshold" });
  expect(await planSameSessionCompaction(await planInput(f, { percent: 85 }))).toMatchObject({ ok: true, action: "compact" });
});

test("an invalid handover or foreign actor makes the planner fall back before any draft exists", async () => {
  const f = await fixture();
  expect(await planSameSessionCompaction(await planInput(f, { handoverText: handover("H-6", { broken: true }) }))).toMatchObject({ ok: false, reason: "invalid-handover" });
  expect(await planSameSessionCompaction(await planInput(f, { actor: "main@demo" }))).toMatchObject({ ok: false, reason: "foreign-seat" });
});

test("primary path leaves the seat record byte-identical and creates no session, pane, binding or replacement request", async () => {
  const f = await fixture();
  const seatBefore = await readFile(f.seatFile, "utf8");
  const planned = await planSameSessionCompaction(await planInput(f));
  if (!planned.ok || planned.action !== "compact") throw new Error("expected compact plan");
  await verifyCompaction({ root: f.root, seat: seatAddress, live, before: planned.identity, handover_id: planned.handover_id, event: { compactionEntry: { id: "c1", firstKeptEntryId: "c1", summary: "x" } } });
  expect(await readFile(f.seatFile, "utf8")).toBe(seatBefore);
  expect(existsSync(join(f.root, ".atdd-flow", "handover-replacements"))).toBe(false);
  expect((await readdir(join(f.root, ".atdd-flow"))).sort()).toEqual(["runtime-launch"]);
  const source = await readFile(join(import.meta.dir, "..", "src", "compaction-handover.ts"), "utf8");
  for (const forbidden of ["pi-runtime-launch", "stale-main-recovery", "multiplexer", "requestHandoverReplacement", "Bun.spawn", "node:child_process"]) expect(source).not.toContain(forbidden);
});
