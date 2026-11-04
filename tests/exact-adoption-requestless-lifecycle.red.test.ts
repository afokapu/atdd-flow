// URN: test:flow:exact-adoption-requestless-lifecycle
// Acceptance: acc:flow:E037-UNIT-001
// Phase: UNIT
// Runtime: bun
// Purpose: A request-less exact adoption stays RESUMED 6/6 as its task lifecycle advances.
import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { registerRuntimeState } from "../src/runtime-state";
import { type Fixture, fixture, reconcile } from "./stale-adopt-fixtures";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const done = "RESUMED; verified 6/6; discrepancies: none.";
const named = (n: number) => `RESUMED; verified ${n}/6; discrepancies: exact-adoption receipt and task.`;

async function resumed(value: Fixture) {
  const child = Bun.spawn([process.execPath, cli, "handover", "resumed", value.address], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, ATDD_WORKFLOW_ROOT: value.root },
  });
  const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${out}${err}` };
}

/** Adopt in place, start a post-receipt heartbeat, then let the task lifecycle change. */
async function adoptedThen(change?: Record<string, unknown>) {
  const value = await fixture("atdd-flow");
  await reconcile(value);
  await registerRuntimeState(value.root, { seat: value.address, owner_token: "owner", pid: 84314, model: "economy", cwd: value.cwd, pi_session: value.target.session }, "2026-11-04T08:01:00.000Z");
  const file = paths(value.root).taskFile("atdd-flow", "takeover-1");
  if (change) await atomicYaml(file, { ...(await readYaml<Record<string, any>>(file)), ...change });
  return { value, file };
}

const lifecycle: Array<[string, Record<string, unknown>]> = [
  ["blocked", { status: "in_progress", blocker: "waiting on owner" }],
  ["in progress with handoff and proof", { status: "in_progress", handoff: { state: "awaiting_coordinator", evidence: "M-1", submitted_phase: "red" }, done_when: [{ text: "Successor resumes.", proof: "pr#1" }] }],
  ["in review", { status: "review" }],
];

for (const [name, change] of lifecycle) {
  test(`a valid receipt still reaches RESUMED 6/6 when its task is ${name}`, async () => {
    const { value } = await adoptedThen(change);
    expect(await resumed(value)).toMatchObject({ exitCode: 0, output: expect.stringContaining(done) });
  }, 60_000);
}

test("a missing, foreign or terminal task is refused by name", async () => {
  const missing = await adoptedThen();
  await rm(missing.file);
  expect(await resumed(missing.value)).toMatchObject({ exitCode: 1, output: expect.stringContaining(named(5)) });
  for (const change of [{ assignee: "driver.x@atdd-flow" }, { coordinator: "main@elsewhere" }, { status: "done" }, { status: "superseded" }, { status: "rejected" }, { schema: "other/v1" }]) {
    const { value } = await adoptedThen(change);
    expect(await resumed(value)).toMatchObject({ exitCode: 1, output: expect.stringContaining(named(5)) });
  }
}, 120_000);
