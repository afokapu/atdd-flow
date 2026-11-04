// URN: test:flow:exact-adoption-requestless-resumed
// Acceptance: acc:flow:E032-UNIT-001
// Phase: UNIT
// Runtime: bun
// Purpose: `handover resumed` verifies a request-less exact adoption from its own immutable receipt.
import { expect, test } from "bun:test";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { handoverReplacementPath } from "../src/handover";
import { registerRuntimeState } from "../src/runtime-state";
import { type Fixture, fixture, reconcile } from "./stale-adopt-fixtures";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const verified = (n: number, discrepancy = "none") => `RESUMED; verified ${n}/6; discrepancies: ${discrepancy}.`;

async function resumed(value: Fixture) {
  const child = Bun.spawn([process.execPath, cli, "handover", "resumed", value.address], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, ATDD_WORKFLOW_ROOT: value.root },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}
const heartbeat = (value: Fixture, at = "2026-11-04T08:01:00.000Z") => registerRuntimeState(value.root, {
  seat: value.address, owner_token: "owner", pid: 84314, model: "economy", cwd: value.cwd, pi_session: value.target.session,
}, at);
/** Adopt in place (the live shape) and return the receipt path. */
async function adopted(extra: Parameters<typeof fixture>[1] = {}) {
  const value = await fixture("atdd-flow", extra);
  return { value, plan: await reconcile(value) };
}

test("a request-less in-place adoption verifies RESUMED 6/6", async () => {
  const { value } = await adopted();
  await heartbeat(value);
  expect(await resumed(value)).toMatchObject({ exitCode: 0, output: expect.stringContaining(verified(6)) });
});

test("a request-less adoption into a vacated pane verifies RESUMED 6/6, and later JSONL growth does not break it", async () => {
  const value = await fixture("decision-os", { live: { path: undefined, startable: true } });
  await reconcile(value, []);
  await appendFile(value.livePath, '{"type":"message"}\n');
  await heartbeat(value);
  expect(await resumed(value)).toMatchObject({ exitCode: 0, output: expect.stringContaining(verified(6)) });
});

test("a stray invalid Path-A request neither blocks the verifier nor is rewritten", async () => {
  const { value } = await adopted();
  const stray = handoverReplacementPath(value.root, value.address);
  await mkdir(dirname(stray), { recursive: true });
  await writeFile(stray, "schema: nonsense\n");
  await heartbeat(value);
  expect(await resumed(value)).toMatchObject({ exitCode: 0 });
  expect(await readFile(stray, "utf8")).toBe("schema: nonsense\n");
});

test("a missing or pre-receipt heartbeat is a named discrepancy", async () => {
  const { value } = await adopted();
  expect(await resumed(value)).toMatchObject({ exitCode: 1, output: expect.stringContaining(verified(5, "fresh heartbeat")) });
  await heartbeat(value, "2026-11-04T07:00:00.000Z");
  expect(await resumed(value)).toMatchObject({ exitCode: 1, output: expect.stringContaining(verified(5, "fresh heartbeat")) });
});

test("a tampered authorization record or backup is a named discrepancy", async () => {
  const { value, plan } = await adopted();
  await heartbeat(value);
  const record = join(value.root, ".atdd-flow", "exact-session-adoption-authorizations", `${value.authorizationId}.yaml`);
  await appendFile(record, "# edited\n");
  expect(await resumed(value)).toMatchObject({ exitCode: 1, output: expect.stringContaining(verified(5, "immutable authorization, backup and single use")) });
  const second = await adopted();
  await heartbeat(second.value);
  const receipt = await readYaml<Record<string, any>>(second.plan.receipt);
  await writeFile(receipt.relocation.backup, "not the adopted transcript\n");
  expect(await resumed(second.value)).toMatchObject({ exitCode: 1, output: expect.stringContaining(verified(5, "immutable authorization, backup and single use")) });
  expect(plan.receipt).not.toBe(second.plan.receipt);
});

test("a seat rebound to another session or an ineligible task is a named discrepancy", async () => {
  const rebound = await adopted();
  await heartbeat(rebound.value);
  const file = paths(rebound.value.root).seatFile(rebound.value.address);
  const seat = await readYaml<Record<string, any>>(file);
  await atomicYaml(file, { ...seat, runtime: { ...seat.runtime, pi_session: "01a19f3a-0000-7000-8000-000000000000" } });
  expect(await resumed(rebound.value)).toMatchObject({ exitCode: 1, output: expect.stringContaining("Pi session/JSONL path") });
  const evidence = await adopted();
  await heartbeat(evidence.value);
  const task = paths(evidence.value.root).taskFile("atdd-flow", "takeover-1");
  await atomicYaml(task, { ...(await readYaml<Record<string, any>>(task)), status: "in_progress", handoff: { state: "awaiting_coordinator", evidence: "M-1", submitted_phase: "red" } });
  expect(await resumed(evidence.value)).toMatchObject({ exitCode: 1, output: expect.stringContaining("exact-adoption receipt and task") });
});
