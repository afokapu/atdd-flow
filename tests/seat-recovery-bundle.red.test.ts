// URN: test:atdd-flow:seat-recovery-bundle
// Acceptance: acc:flow:E004-RED-001
// Phase: RED
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalCollaborationPolicy, handoverThresholdInstruction, runtimeStartupInstruction, successorInstruction } from "../src/collaboration-policy";
import { atomicYaml } from "../src/core";
import { handoverReplacementPath } from "../src/handover";
import { previousSessionPath, recoveryBundle } from "../src/recovery-bundle";
import { installCleanup, now, seat, session, temp, git, repository, fakeGh, prJson, desk, seatRecord, task, thread, message, call, outcome, sessionFile, lines, field, snapshot, populated } from "./seat-recovery-fixtures";

installCleanup();

test("RED: today's startup, 80% handover and Path-A successor prompts carry no computed recovery bundle", async () => {
  expect(runtimeStartupInstruction(seat)).not.toContain("RECOVERY BUNDLE");
  const bundle = "RECOVERY BUNDLE driver.pi@demo | marker";
  expect(runtimeStartupInstruction(seat, bundle)).toContain(bundle);
  expect(handoverThresholdInstruction(85, 80, bundle)).toContain(bundle);
  expect(handoverThresholdInstruction(85, 80, bundle)).toContain("85%");
  expect(successorInstruction(seat, "H-1", bundle)).toContain(bundle);
  expect(successorInstruction(seat, "H-1", bundle)).toContain("H-1");
  expect.fail("Not implemented: src/recovery-bundle.ts"); // RED marker; removed when GREEN carries the proof
});

test("RED: the bundle renders every field from git, Desk and the previous Pi session, with pointers and no bodies", async () => {
  const { root, worktree, sessionPath } = await populated();
  const bundle = await recoveryBundle(root, seat, { sessionPath, now });
  expect(lines(bundle)[0]).toMatch(/^RECOVERY BUNDLE driver\.pi@demo \| 2026-10-15T12:00:00/);
  expect(bundle).toContain("driver");
  expect(bundle).toContain("demo");
  expect(field(bundle, "worktree:")).toContain(worktree);
  expect(field(bundle, "branch:")).toContain("main");
  expect(field(bundle, "head:")).toContain(git(worktree, "rev-parse", "--short", "HEAD"));
  expect(field(bundle, "upstream:")).toMatch(/ahead 1.*behind 0/);
  expect(field(bundle, "changed:")).toContain("a.txt");
  expect(field(bundle, "changed:")).toContain("new.txt");
  expect(field(bundle, "last commit:")).toBeDefined();
  expect(field(bundle, "checkpoint:")).toMatch(/active.*Halfway through RED tests.*2h/);
  const alpha = lines(bundle).find((line) => line.startsWith("task alpha"))!;
  for (const part of ["in_progress", "red", "awaiting_coordinator", "M-red-ev", "1/2", "waiting on owner", "dep-task"]) expect(alpha).toContain(part);
  expect(bundle).not.toContain("finished-task");
  expect(field(bundle, "next:")).toContain("alpha");
  expect(lines(bundle).find((line) => line.startsWith("inbound M-in1"))).toMatch(/main@demo -> driver\.pi@demo.*3d/);
  expect(lines(bundle).find((line) => line.startsWith("outbound M-out1"))).toMatch(/driver\.pi@demo -> main@demo/);
  expect(bundle).not.toContain("M-ans");
  expect(field(bundle, "pr:")).toMatch(/PR #42 OPEN https:\/\/example\.test\/pr\/42.*checks 1 pass \/ 1 fail \/ 1 pending/);
  expect(field(bundle, "gate:")).toMatch(/bun run check.*ok/);
  expect(field(bundle, "session:")).toContain(sessionPath);
  expect(field(bundle, "runtime:")).toContain("forge");
  expect(field(bundle, "runtime:")).toContain("w1:p2");
  expect(field(bundle, "runtime:")).toContain(session);
  const recent = lines(bundle).filter((line) => line.startsWith("recent M-"));
  expect(recent).toHaveLength(5);
  expect(recent.every((line) => line.includes("Own Thread"))).toBe(true);
  expect(bundle).not.toContain("M-own-1");
  expect(bundle).toContain("M-own-6");
  expect(bundle).not.toContain("SECRETBODY");
  expect(bundle).not.toContain("TRANSCRIPT-SECRET");
});

test("RED: missing sources render explicit 'unavailable' and never fail", async () => {
  const base = await temp("missing");
  const root = join(base, "desk");
  await desk(root);
  await seatRecord(root, seat, join(base, "does-not-exist"));
  await fakeGh(base, "echo boom >&2; exit 1");
  const bundle = await recoveryBundle(root, seat, { now });
  for (const prefix of ["head:", "upstream:", "changed:", "checkpoint:", "pr:", "gate:", "session:", "runtime:"]) {
    expect(field(bundle, prefix), prefix).toContain("unavailable");
  }
  expect(lines(bundle)[0]).toStartWith("RECOVERY BUNDLE");
});

test("RED: generating the bundle writes nothing to the Desk, git worktree, refs or session files", async () => {
  const { base, root, worktree, sessionPath } = await populated();
  const before = [...await snapshot(root), ...await snapshot(worktree), ...await snapshot(join(base, "origin.git")), ...await snapshot(join(base, "sessions"))];
  await recoveryBundle(root, seat, { sessionPath, now });
  await recoveryBundle(root, seat, { sessionPath, now });
  expect([...await snapshot(root), ...await snapshot(worktree), ...await snapshot(join(base, "origin.git")), ...await snapshot(join(base, "sessions"))]).toEqual(before);
});

test("RED: the bundle is capped at 50 lines / 5KB and never includes transcript content, even with a huge session and 500 changed files", async () => {
  const base = await temp("cap");
  const root = join(base, "desk");
  const worktree = await repository(base, 500);
  const sessionPath = await sessionFile(base, [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "TRANSCRIPT-SECRET ".repeat(300_000) }] } },
    call("c1", "bun test"), outcome("c1", false, "fine"),
  ]);
  await desk(root);
  await seatRecord(root, seat, worktree);
  await fakeGh(base, `echo '${prJson}'`);
  const bundle = await recoveryBundle(root, seat, { sessionPath, now });
  expect(lines(bundle.trimEnd()).length).toBeLessThanOrEqual(50);
  expect(new TextEncoder().encode(bundle).length).toBeLessThanOrEqual(5120);
  expect(field(bundle, "changed:")).toMatch(/\+\d+ more/);
  expect(bundle).not.toContain("TRANSCRIPT-SECRET");
  expect(field(bundle, "gate:")).toContain("bun test");
});

test("RED: last test/gate command and its result are extracted mechanically from the session JSONL", async () => {
  const { base, root } = await populated();
  const failed = await sessionFile(base, [
    call("a", "bun run check"), outcome("a", false, "ok"),
    call("b", "bun test tests/x.test.ts"), outcome("b", true, "2 fail\nexited with code 2"),
    call("c", "git status"), outcome("c", false, "clean"),
  ], "failed.jsonl");
  expect(field(await recoveryBundle(root, seat, { sessionPath: failed, now }), "gate:")).toMatch(/bun test tests\/x\.test\.ts.*failed.*code 2/);
  const none = await sessionFile(base, [call("a", "ls"), outcome("a", false, "x")], "none.jsonl");
  expect(field(await recoveryBundle(root, seat, { sessionPath: none, now }), "gate:")).toContain("unavailable");
});

test("RED: previous session is the newest sibling at ordinary start, the own file at 80%, and the request source at Path-A", async () => {
  const base = await temp("prev");
  const root = join(base, "desk");
  await desk(root);
  const dir = join(base, "sessions");
  await mkdir(dir, { recursive: true });
  const older = join(dir, "2026-10-14T10-00-00-000Z_aaaa.jsonl");
  const newer = join(dir, "2026-10-14T11-00-00-000Z_bbbb.jsonl");
  const current = join(dir, `2026-10-15T10-00-00-000Z_${session}.jsonl`);
  for (const path of [older, newer, current]) await writeFile(path, "{}\n");
  await seatRecord(root, seat, base, { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, pi_session: session, pi_session_path: current });
  const source = join(base, "elsewhere", "source.jsonl");
  await atomicYaml(handoverReplacementPath(root, seat), {
    schema: "atdd-flow/context-handover-replacement-request/v1", seat, task: "t", handover: { id: "H-1", sha256: "x" }, authorization: { id: "A", hash: "h" },
    source: { pi_session: "src", pi_session_path: source, herdr_session: "forge", pane: "w1:p2" }, target: { herdr_session: "forge", pane: "w1:p3", cwd: base }, created_at: "2026-10-15T09:00:00.000Z",
  });
  expect(await previousSessionPath(root, seat, "start", session)).toBe(newer);
  expect(await previousSessionPath(root, seat, "threshold", session)).toBe(current);
  expect(await previousSessionPath(root, seat, "successor", "other")).toBe(source);
});

test("RED: collaboration policy carries the decide-then-post rule", () => {
  expect(canonicalCollaborationPolicy()).toContain("Post decisions and open questions as messages when they happen.");
});
