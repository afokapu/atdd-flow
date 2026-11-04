// URN: test:flow:in-place-adoption-native-mail
// Acceptance: acc:flow:E034-UNIT-001
// Phase: UNIT
// Runtime: bun
// Purpose: A Pi reconciled in place stays reachable by host-attached native mail; nothing else gains that.
import { expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { hostAttachedActivation } from "../extensions/pi/index";
import { type Fixture, fixture, herdrSession, reconcile } from "./stale-adopt-fixtures";

/** Herdr's injected pane identity plus the live Pi's own session, exactly what a hand-started Pi can observe. */
const attach = (value: Fixture, change: Partial<{ pane: string; piSession: string; piSessionPath: string }> = {}) => hostAttachedActivation({
  root: value.root, seat: value.address, herdrSession, pane: value.target.pane, piSession: value.target.session, piSessionPath: value.livePath, ...change,
});

test("the receipt of an exact in-place adoption activates host-attached native mail", async () => {
  const value = await fixture("atdd-flow");
  expect(await attach(value)).toBe(false);
  await reconcile(value);
  expect(await attach(value)).toBe(true);
});

test("a mismatched live pane, session or path still refuses", async () => {
  const value = await fixture("atdd-flow");
  await reconcile(value);
  expect(await attach(value, { pane: "w5:pZ" })).toBe(false);
  expect(await attach(value, { piSession: "01a19f3a-0000-7000-8000-000000000000" })).toBe(false);
  expect(await attach(value, { piSessionPath: join(value.root, "other.jsonl") })).toBe(false);
  expect(await attach(value, { piSession: undefined, piSessionPath: undefined })).toBe(false);
});

test("a tampered authorization record, a non-in-place receipt or a foreign receipt still refuses", async () => {
  const tampered = await fixture("atdd-flow");
  await reconcile(tampered);
  await appendFile(join(tampered.root, ".atdd-flow", "exact-session-adoption-authorizations", `${tampered.authorizationId}.yaml`), "# edited\n");
  expect(await attach(tampered)).toBe(false);

  const launcher = await fixture("decision-os", { live: { path: undefined, startable: true } });
  await reconcile(launcher, []);
  expect(await attach(launcher)).toBe(false);

  const foreign = await fixture("frg-workstation");
  const plan = await reconcile(foreign);
  const receipt = await readYaml<Record<string, any>>(plan.receipt);
  await atomicYaml(plan.receipt, { ...receipt, seat: "main@someone-else" });
  expect(await attach(foreign)).toBe(false);
  expect((await readYaml<Record<string, any>>(paths(foreign.root).seatFile(foreign.address))).runtime.launch_receipt).toBe(plan.receipt);
});
