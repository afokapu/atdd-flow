// URN: test:flow:main-mail-repair:E015-UNIT-001
// Acceptance: acc:flow:E015-UNIT-001
// Phase: UNIT
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { heartbeatRuntimeState, recordMailActivation, registerRuntimeState } from "../src/runtime-state";
import { reconcileMainMailRepairs } from "../src/main-mail-repair";

const roots: string[] = [];
const address = "main@demo";
const bound = "01a00000-0000-7000-8000-00000000000a";
const live = "01a00000-0000-7000-8000-00000000000b";
const pathFor = (id: string) => `/tmp/run_${id}.jsonl`;
const start = new Date();
const calls: Array<{ session: string; pane: string; notice: string }> = [];
afterEach(async () => { calls.length = 0; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "main-mail-repair-"));
  roots.push(root);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr" });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1",
    project: "demo", repository: root, roles: {} });
  const receipt = join(root, ".atdd-flow", "runtime-launch", "bound.yaml");
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1",
    seat: address, pi_session: bound, pi_session_path: pathFor(bound), herdr_session: "forge", pane: "w1:p2" });
  await atomicYaml(paths(root).seatFile(address), { schema: "atdd-workflow/seat/v2",
    address, role: "main", project: "demo", worktree: root, branch: "main",
    runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } },
      wake: "native", pi_session: bound, pi_session_path: pathFor(bound), launch_receipt: receipt } });
  await registerRuntimeState(root, { seat: address, owner_token: "live-pi", pid: process.pid,
    model: "pi", cwd: root, pi_session: live }, start.toISOString());
  await recordMailActivation(root, address, "live-pi", {
    at: start.toISOString(), transport: "inactive",
    bound: { pi_session: bound, herdr_session: "forge", pane: "w1:p2", receipt: "present" },
    live: { pi_session: live, herdr_session: "forge", pane: "w1:p2" }, differs: ["session"],
  });
  return root;
}
const config = (root: string, at = start) => ({
  now: at,
  inspect: async (_session: string, pane: string, name: string) =>
    ({ name, pane, cwd: root, sessionPath: pathFor(live) }),
  deliver: async (session: string, pane: string, notice: string) => { calls.push({ session, pane, notice }); },
});

test("a mismatched live main receives an accountable repair task via exact Herdr prompt", async () => {
  const root = await fixture();
  const report = await reconcileMainMailRepairs(root, config(root));
  expect(report).toHaveLength(1);
  expect(report[0]?.outcome).toBe("reached");
  const id = report[0]?.task;
  expect(id).toStartWith("mail-repair-");
  const record = await readYaml<Record<string, any>>(paths(root).taskFile("demo", id!));
  expect(record).toMatchObject({ schema: "atdd-workflow/task/v1", coordinator: address, assignee: address, status: "todo" });
  expect(record.done_when[0].text).toContain("native mail active");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ session: "forge", pane: "w1:p2" });
  expect(calls[0]!.notice).toContain("operator-authorized exact-session recovery");
  const seat = await readYaml<Record<string, any>>(paths(root).seatFile(address));
  expect(seat.runtime.pi_session).toBe(bound);
});

test("dry-run has no side effects; notice is bounded by cooldown and retry ceiling", async () => {
  const root = await fixture(), options = config(root);
  expect((await reconcileMainMailRepairs(root, { ...options, dryRun: true }))[0]?.outcome).toBe("ready");
  expect(calls).toHaveLength(0);
  expect((await reconcileMainMailRepairs(root, options))[0]?.outcome).toBe("reached");
  expect((await reconcileMainMailRepairs(root, options))[0]?.outcome).toBe("cooldown");
  const next = new Date(start.getTime() + 6 * 60_000);
  await heartbeatRuntimeState(root, address, "live-pi", next.toISOString());
  expect((await reconcileMainMailRepairs(root, config(root, next)))[0]?.outcome).toBe("reached");
  const later = new Date(start.getTime() + 7 * 60_000);
  await heartbeatRuntimeState(root, address, "live-pi", later.toISOString());
  expect((await reconcileMainMailRepairs(root, config(root, later)))[0]?.outcome).toBe("exhausted");
  expect(calls).toHaveLength(2);
});

test("wrong worktree, agent identity, or live session never receives a prompt", async () => {
  const root = await fixture(), options = config(root);
  for (const patch of [
    { name: "some-other-agent" }, { cwd: "/tmp/wrong-worktree" }, { sessionPath: pathFor(bound) }, { pane: "w1:p8" },
  ]) {
    const result = await reconcileMainMailRepairs(root, { ...options,
      inspect: async (_session, pane, name) => ({ name, pane, cwd: root, sessionPath: pathFor(live), ...patch }) });
    expect(result[0]?.outcome).toBe("unverified");
  }
  expect(calls).toHaveLength(0);
});

test("healthy mail and non-main roles never generate repair tasks", async () => {
  const root = await fixture();
  const state = await readYaml<Record<string, any>>(paths(root).seatFile(address));
  await recordMailActivation(root, address, "live-pi", {
    at: start.toISOString(), transport: "active",
    bound: { pi_session: bound, herdr_session: "forge", pane: "w1:p2", receipt: "present" },
    live: { pi_session: live, herdr_session: "forge", pane: "w1:p2" }, differs: ["session"],
  });
  expect(await reconcileMainMailRepairs(root, config(root))).toEqual([]);
  await atomicYaml(paths(root).seatFile(address), { ...state, role: "driver" });
  expect(await reconcileMainMailRepairs(root, config(root))).toEqual([]);
});
