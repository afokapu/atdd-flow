// URN: test:flow:stale-binding-adoption-in-place
// Acceptance: acc:flow:E031-UNIT-001
// Phase: UNIT
// Runtime: bun
// Purpose: An operator-authorized Pi already occupying the target pane is reconciled in place, without a second launch, and every tuple, authorization, writer and task guard stays strict.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, readYaml } from "../src/core";
import { type Fixture, type Name, expectRefused, fixture, herdrSession, noRequest, reconcile, readyTask, receipts, seatFile, selectEconomy, args, targets } from "./stale-adopt-fixtures";
import { launchPiRuntime } from "../src/seats";

for (const name of Object.keys(targets) as Name[]) {
  test(`dry-run shape: authorized Pi occupying ${targets[name].pane} for main@${name} is reconciled in place with no launch command`, async () => {
    const value = await fixture(name);
    const before = await seatFile(value);
    const plan = await reconcile(value, ["--in-place", "--dry-run"]);
    expect(plan).toMatchObject({ dryRun: true, inPlace: true, piSession: targets[name].session, pane: targets[name].pane, herdrSession, command: [] });
    expect(await seatFile(value)).toBe(before);
    expect(await receipts(value.root)).toEqual([]);
    expect(value.runtime.mutations()).toBe(0);
  });
}

test("live in-place reconcile binds the existing Pi and records authorization provenance without a second launch", async () => {
  const value = await fixture("atdd-flow");
  const plan = await reconcile(value);
  const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(value.address));
  expect(seat.runtime).toMatchObject({ application: "herdr", addresses: { herdr: { session: herdrSession, pane: value.target.pane } }, wake: "native",
    pi_session: value.target.session, pi_session_path: value.livePath, launch_receipt: plan.receipt });
  const receipt = await readYaml<Record<string, any>>(plan.receipt);
  expect(receipt).toMatchObject({ seat: value.address, tasks: ["takeover-1"], pi_session: value.target.session, pi_session_path: value.livePath,
    pane: value.target.pane, relocation: { source_pane: value.target.pane, authorization: { id: value.authorizationId } },
    launch_basis: { kind: "exact-adoption", task: "takeover-1", in_place: true } });
  expect(receipt.handover_replacement).toBeUndefined();
  expect(await readFile(receipt.relocation.backup, "utf8")).toBe(await readFile(value.livePath, "utf8"));
  expect(value.runtime.mutations()).toBe(0);
  expect(value.runtime.calls.some((call) => call[4] === "run" || call[4] === "start")).toBe(false);
});

test("without --in-place an occupied target is still refused as before", async () => {
  const value = await fixture("atdd-flow");
  await expectRefused(value, "New launch requires an available shell pane", []);
});

test("the authorization is one-shot for in-place reconcile", async () => {
  const value = await fixture("atdd-flow");
  await reconcile(value);
  await expect(reconcile(value)).rejects.toThrow("already used");
});

test("guard: the authorized Pi must actually be live in the target pane", async () => {
  await expectRefused(await fixture("atdd-flow", { live: { path: undefined } }), "In-place adoption requires the authorized Pi to be live");
});

test("guard: a different Pi session or working directory in the pane is refused", async () => {
  const other = await fixture("atdd-flow");
  other.runtime.live.path = join(other.root, "2026-11-04T05-00-00-000Z_01a19f3a-0000-7000-8000-000000000000.jsonl");
  await expectRefused(other, /authorized source tuple|does not match/);
  const moved = await fixture("atdd-flow");
  moved.runtime.live.cwd = "/elsewhere";
  await expectRefused(moved, /authorized source tuple|does not match/);
});

test("guard: more than one Pi writer in the pane is refused", async () => {
  await expectRefused(await fixture("atdd-flow", { live: { pi: 2 } }), "exactly one live Pi writer");
});

test("guard: the authorized Pi also live in another pane, or the stale recorded Pi still live, is refused", async () => {
  const dup = await fixture("atdd-flow");
  dup.runtime.live.others = [{ pane: "w7:p7", path: dup.livePath }];
  await expectRefused(dup, /another pane|more than one|duplicate|exactly once/i);
  const stale = await fixture("decision-os");
  stale.runtime.live.others = [{ pane: "w7:p7", path: stale.stalePath }];
  await expectRefused(stale, "still a live Pi agent");
});

test("guard: in-place requires the authorized source pane to be the target pane", async () => {
  await expectRefused(await fixture("atdd-flow", { authorizedSourcePane: "w5:pZ" }), /exact adoption tuple|same pane|source pane/i);
});

test("guard: missing authorization, ambiguous or evidence-bearing tasks and non-adoption use refuse", async () => {
  await expectRefused(await fixture("atdd-flow", { authorize: false }), "immutable operator authorization");
  for (const tasks of [[], [readyTask, readyTask], [{ ...readyTask, status: "in_progress", handoff: { phase: "red", evidence: "M-1" } }]]) {
    await expectRefused(await fixture("atdd-flow", { tasks }), noRequest("main@atdd-flow"));
  }
  const value = await fixture("atdd-flow");
  await expect(launchPiRuntime(value.root, value.address, ["--pane", value.target.pane, "--herdr-session", herdrSession, "--in-place"],
    { command: value.runtime.command, select: selectEconomy })).rejects.toThrow(/--in-place|adopt/);
  await expect(launchPiRuntime(value.root, value.address, args(value, ["--in-place", "--resume"]), { command: value.runtime.command, select: selectEconomy })).rejects.toThrow();
});
