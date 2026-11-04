// URN: test:flow:in-place-live-target-verifier
// Acceptance: acc:flow:E035-UNIT-001
// Phase: UNIT
// Runtime: bun
// Purpose: In-place adoption checks the live target Pi against the authorized target tuple only.
import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { paths, readYaml } from "../src/core";
import { type Live, type Name, expectRefused, fixture, reconcile, targets } from "./stale-adopt-fixtures";

const names = Object.keys(targets) as Name[];

for (const name of names) {
  for (const agentGet of ["foreign", "unknown"] as const) {
    test(`a hand-started Pi whose agent record is ${agentGet} still reconciles in place for main@${name}`, async () => {
      const value = await fixture(name, { live: { agentGet } });
      const plan = await reconcile(value);
      expect(plan).toMatchObject({ inPlace: true, piSession: targets[name].session, pane: targets[name].pane });
      const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(value.address));
      expect(seat.runtime).toMatchObject({ pi_session: targets[name].session, launch_receipt: plan.receipt });
      expect(value.runtime.mutations()).toBe(0);
    });
  }
}

test("a pane cwd that is the same directory through a symlink is accepted", async () => {
  const value = await fixture("atdd-flow");
  value.runtime.live.cwd = await realpath(value.cwd);
  expect(await reconcile(value, ["--in-place", "--dry-run"])).toMatchObject({ inPlace: true, dryRun: true });
});

test("the target tuple stays strict without the legacy agent record", async () => {
  const live: Partial<Live> = { agentGet: "foreign" };
  const other = await fixture("atdd-flow", { live });
  other.runtime.live.path = join(other.root, "2026-11-04T05-00-00-000Z_01a19f3a-0000-7000-8000-000000000000.jsonl");
  await expectRefused(other, /does not match/);
  const moved = await fixture("atdd-flow", { live });
  moved.runtime.live.cwd = "/elsewhere";
  await expectRefused(moved, /does not match/);
  await expectRefused(await fixture("atdd-flow", { live: { ...live, pi: 2 } }), "exactly one live Pi writer");
  await expectRefused(await fixture("atdd-flow", { live: { ...live, path: undefined } }), "authorized Pi to be live");
  const dup = await fixture("atdd-flow", { live });
  dup.runtime.live.others = [{ pane: "w7:p7", path: dup.livePath }];
  await expectRefused(dup, /exactly once|another pane/);
  const stale = await fixture("decision-os", { live });
  stale.runtime.live.others = [{ pane: "w7:p7", path: stale.stalePath }];
  await expectRefused(stale, "still a live Pi agent");
});
