// URN: test:flow:reconcile-empty-seat-dir
// Acceptance: acc:flow:E020-UNIT-001
// Phase: UNIT
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml } from "../src/core";
import { reconcileOnce } from "../src/reconcile";
import { registerRuntimeState } from "../src/runtime-state";

// Contract under test (RED):
// 1 TOLERATE  an entirely empty seat directory is skipped; reconcile completes for the valid seat.
// 2 WARN      the skipped directory is reported once as a warning naming its path.
// 3 SAFE      nothing is deleted, and the empty directory is left in place.
// 4 CLOSED    a directory with content (even hidden) but no seat.yaml still fails closed.
const roots: string[] = [];
const clock = new Date("2026-10-27T12:00:00.000Z");
const session = "01a12345-6789-7abc-8def-0123456789ab";
const driver = "driver.delivery@demo", coordinator = "coordinator@demo";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flow-empty-seat-"));
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
  await atomicYaml(join(root, "work/demo/tasks/work.yaml"), {
    schema: "atdd-workflow/task/v1", title: "Finish work", coordinator, assignee: driver,
    status: "in_progress", phase: "red", done_when: [{ text: "All checks pass" }],
  });
  return root;
}
const options = (warnings: string[]) => ({
  now: clock, dryRun: true,
  inspect: async () => "idle",
  wake: async () => {},
  warn: (message: string) => { warnings.push(message); },
});

test("an empty seat directory is skipped with one warning naming its path, and nothing is deleted", async () => {
  const root = await fixture();
  const ghost = join(root, "work/demo/seats/operator");
  await mkdir(ghost, { recursive: true });
  const warnings: string[] = [];
  const result = await reconcileOnce(root, options(warnings));
  expect(result).toEqual([{ seat: driver, task: "demo/work", outcome: "dry_run" }]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(ghost);
  expect(await readdir(ghost)).toEqual([]);
});

test("a seat directory with only a hidden entry and no seat.yaml still fails closed", async () => {
  const root = await fixture();
  const stray = join(root, "work/demo/seats/operator");
  await mkdir(stray, { recursive: true });
  await writeFile(join(stray, ".keep"), "");
  const warnings: string[] = [];
  await expect(reconcileOnce(root, options(warnings))).rejects.toThrow();
  expect(warnings).toEqual([]);
});

test("a seat directory with content but no seat.yaml still fails closed", async () => {
  const root = await fixture();
  const stray = join(root, "work/demo/seats/operator");
  await mkdir(stray, { recursive: true });
  await writeFile(join(stray, "notes.txt"), "stray");
  await expect(reconcileOnce(root, options([]))).rejects.toThrow();
});
