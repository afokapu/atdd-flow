// URN: test:flow:continuation:E012-UNIT-001
// Acceptance: acc:flow:E012-UNIT-001
// Phase: UNIT
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml } from "../src/core";
import { reconcileOnce } from "../src/reconcile";
import { heartbeatRuntimeState, registerRuntimeState } from "../src/runtime-state";
import { createNoticeState, refreshDelivered, sendSettledDirective, sendTaskDirective } from "../src/next-action-notices";

const roots: string[] = [];
const clock = new Date("2026-10-27T12:00:00.000Z");
const session = "01a12345-6789-7abc-8def-0123456789ab";
const driver = "driver.delivery@demo", coordinator = "coordinator@demo";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flow-continuation-"));
  roots.push(root);
  await atomicYaml(join(root, "desk.yaml"), { schema: "atdd-workflow/desk/v1", desk: "test", application: "herdr" });
  await atomicYaml(join(root, "work/demo/project.yaml"), { schema: "atdd-workflow/project/v1", project: "demo", vcs: "jj" });
  for (const [address, role, pane] of [[driver, "driver", "w1:p1"], [coordinator, "coordinator", "w1:p2"]] as const) {
    await atomicYaml(join(root, "work/demo/seats", address.split("@")[0], "seat.yaml"), {
      schema: "atdd-workflow/seat/v2", address, project: "demo", role, branch: role === "driver" ? "delivery/delivery" : "integration/demo", worktree: "/work/demo",
      runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane } }, pi_session: session, wake: "native" },
    });
    await registerRuntimeState(root, { seat: address, owner_token: address, pid: process.pid, model: "pi", cwd: "/work/demo", pi_session: session }, clock.toISOString());
  }
  return root;
}
async function task(root: string, fields: Record<string, unknown> = {}) {
  await atomicYaml(join(root, "work/demo/tasks/work.yaml"), {
    schema: "atdd-workflow/task/v1", title: "Finish work", coordinator, assignee: driver,
    status: "in_progress", phase: "red", done_when: [{ text: "All checks pass" }], ...fields,
  });
}
const options = (woken: string[], now = clock) => ({
  now, cooldownMs: 5 * 60_000,
  inspect: async (_: unknown, address: string) => address === driver ? "idle" : "idle",
  wake: async (_: unknown, notice: string) => { woken.push(notice); },
});

test("handoff wakes its coordinator, not the waiting driver, and does not mutate the task", async () => {
  const root = await fixture();
  await task(root, { handoff: { state: "awaiting_coordinator", evidence: "M-red", submitted_phase: "red", updated_at: clock.toISOString() } });
  const woken: string[] = [];
  const result = await reconcileOnce(root, options(woken));
  expect(result).toEqual([{ seat: coordinator, task: "demo/work", outcome: "woke" }]);
  expect(woken).toHaveLength(1);
  expect(woken[0]).toContain("Accept or return");
  expect((await Bun.file(join(root, "work/demo/tasks/work.yaml")).text())).toContain("awaiting_coordinator");
});

test("same obligation is rate-limited, eventually exhausted, and a changed obligation can be reawakened", async () => {
  const root = await fixture();
  await task(root);
  const woken: string[] = [];
  expect((await reconcileOnce(root, options(woken))).map((x) => x.outcome)).toEqual(["woke"]);
  expect((await reconcileOnce(root, options(woken))).map((x) => x.outcome)).toEqual(["cooldown"]);
  await heartbeatRuntimeState(root, driver, driver, new Date(clock.getTime() + 6 * 60_000).toISOString());
  expect((await reconcileOnce(root, options(woken, new Date(clock.getTime() + 6 * 60_000)))).map((x) => x.outcome)).toEqual(["woke"]);
  await heartbeatRuntimeState(root, driver, driver, new Date(clock.getTime() + 12 * 60_000).toISOString());
  expect((await reconcileOnce(root, options(woken, new Date(clock.getTime() + 12 * 60_000)))).map((x) => x.outcome)).toEqual(["exhausted"]);
  expect(woken).toHaveLength(2);
  await task(root, { phase: "green" });
  await heartbeatRuntimeState(root, driver, driver, new Date(clock.getTime() + 13 * 60_000).toISOString());
  expect((await reconcileOnce(root, options(woken, new Date(clock.getTime() + 13 * 60_000)))).map((x) => x.outcome)).toEqual(["woke"]);
});

test("never wakes productive, terminal, deferred or unverified work; dry-run is side-effect free", async () => {
  const root = await fixture();
  await task(root);
  const woken: string[] = [];
  const running = { ...options(woken), inspect: async () => "working" };
  expect((await reconcileOnce(root, running)).map((x) => x.outcome)).toEqual(["busy"]);
  expect((await reconcileOnce(root, { ...options(woken), dryRun: true })).map((x) => x.outcome)).toEqual(["dry_run"]);
  expect((await reconcileOnce(root, options(woken))).map((x) => x.outcome)).toEqual(["woke"]);
  await task(root, { status: "done" });
  expect(await reconcileOnce(root, options(woken))).toEqual([]);
  await task(root, { deferred: { by: coordinator, at: clock.toISOString(), owner: coordinator, trigger: "review", review_at: clock.toISOString(), reason: "genuine wait" } });
  expect(await reconcileOnce(root, options(woken))).toEqual([]);
  await task(root);
  const unverified = await reconcileOnce(root, { ...options(woken), inspect: async () => "unverified" });
  expect(unverified.map((x) => x.outcome)).toEqual(["unverified"]);
  expect(woken).toHaveLength(1);
});

test("runtime replacement between inspection and wake is fenced", async () => {
  const root = await fixture();
  await task(root);
  const woken: string[] = [];
  const result = await reconcileOnce(root, {
    ...options(woken),
    inspect: async (_locator, address) => {
      await registerRuntimeState(root, { seat: address, owner_token: "successor", pid: process.pid,
        model: "pi", cwd: "/work/demo", pi_session: session }, clock.toISOString());
      return "idle";
    },
  });
  expect(result.map((x) => x.outcome)).toEqual(["replaced"]);
  expect(woken).toHaveLength(0);
});

test("a settled turn re-arms after an actionable directive changes and returns", async () => {
  const root = await fixture();
  await task(root);
  const state = createNoticeState();
  const sent: Array<{ customType: string; content: string; details: Record<string, unknown> }> = [];
  const host = { sendMessage(message: (typeof sent)[number]) { sent.push(message); } };
  const delivered = async () => refreshDelivered(root, driver, state, { role: "custom", ...sent.at(-1)! });

  await sendTaskDirective(host, root, driver, state);
  await delivered();
  await sendSettledDirective(host, root, driver, state);
  await delivered();

  await task(root, { phase: "green" });
  await sendSettledDirective(host, root, driver, state);
  await delivered();

  await task(root);
  await sendSettledDirective(host, root, driver, state);
  await delivered();
  await sendSettledDirective(host, root, driver, state);

  expect(sent).toHaveLength(5);
  expect(sent.at(-1)?.details.continuation).toBe(true);
});

test("a settled turn nudges an unchanged actionable task once; awaiting an authority does not loop", async () => {
  const root = await fixture();
  await task(root);
  const state = createNoticeState();
  const sent: Array<{ customType: string; content: string; details: Record<string, unknown> }> = [];
  const host = { sendMessage(message: (typeof sent)[number]) { sent.push(message); } };
  await sendTaskDirective(host, root, driver, state);
  expect(sent).toHaveLength(1);
  const initial = await refreshDelivered(root, driver, state, { role: "custom", ...sent[0] });
  expect(initial?.content).toContain("Commit focused");
  await sendSettledDirective(host, root, driver, state);
  expect(sent).toHaveLength(2);
  const nudged = await refreshDelivered(root, driver, state, { role: "custom", ...sent[1] });
  expect(nudged?.content).toContain("task remains open");
  await sendSettledDirective(host, root, driver, state);
  expect(sent).toHaveLength(2);
  await task(root, { handoff: { state: "awaiting_coordinator", evidence: "M-red", submitted_phase: "red", updated_at: clock.toISOString() } });
  await sendSettledDirective(host, root, driver, state);
  expect(sent).toHaveLength(2);
});
