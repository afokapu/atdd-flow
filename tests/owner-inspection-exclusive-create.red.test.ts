// URN: test:atdd-flow:owner-inspection-exclusive-create
// Acceptance: acc:flow:E041-UNIT-001
// Phase: UNIT
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeOwnerInspection, ownerInspectionFile, publishOwnerInspection, readOwnerInspection } from "../src/owner-inspection";

// Review finding O1: exists()-then-write is a TOCTOU, so concurrent publish/ack could lose writes or overwrite a record.
// Records and acknowledgements must be created exclusively so write-once and append-only hold under concurrency.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function seat(root: string, project: string, local: string, address: string, role: string) {
  await mkdir(join(root, "work", project, "seats", local), { recursive: true });
  await writeFile(join(root, "work", project, "seats", local, "seat.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/seat/v2", address, role, project, worktree: `/tmp/${local}`, branch: "main",
  }));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-owner-inspection-race-"));
  roots.push(root);
  await mkdir(join(root, "work", "demo", "tasks"), { recursive: true });
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await seat(root, "desk", "operator", "operator@desk", "operator");
  await seat(root, "demo", "driver.delivery", "driver.delivery@demo", "driver");
  await writeFile(join(root, "work", "demo", "tasks", "feature.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/task/v1", title: "feature", status: "review", coordinator: "coordinator@demo",
    assignee: "driver.delivery@demo", done_when: [{ text: "fixture" }],
  }));
  return root;
}

const ref = (kind: string, name: string) => ({ kind, locator: `evidence/${name}`, sha256: "a".repeat(64) });
const packet = (overrides: Record<string, unknown> = {}) => ({
  id: "OI-race-1", stage: "candidate", parent: { project: "demo", task: "feature" }, owner: "driver.delivery@demo",
  surface: { kind: "web", name: "Demo" }, scenario: "Scenario A", data_classification: "synthetic",
  target: { kind: "local", locator: "http://localhost:4173" }, provenance: { task: "demo/feature", commit: "b".repeat(40) },
  evidence: { health: ref("health", "h"), smoke: ref("smoke", "s"), teardown: ref("teardown", "t"), rendered: ref("rendered", "r") },
  ...overrides,
});
const publisher = { by: "driver.delivery@demo" };

test("RED: concurrent publishes of one id admit exactly one payload and never overwrite it", async () => {
  const root = await fixture();
  const attempts = Array.from({ length: 12 }, (_, index) => publishOwnerInspection(root, packet({ scenario: `Scenario ${index}` }), publisher));
  const settled = await Promise.allSettled(attempts);

  expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
  expect(settled.filter((entry) => entry.status === "rejected").every((entry) => /immutable|already/i.test(String((entry as PromiseRejectedResult).reason)))).toBe(true);
  const winner = settled.findIndex((entry) => entry.status === "fulfilled");
  expect((await readOwnerInspection(root, "OI-race-1")).scenario).toBe(`Scenario ${winner}`);
});

test("RED: concurrent identical publishes are all idempotent successes over one record", async () => {
  const root = await fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => publishOwnerInspection(root, packet(), publisher)));
  expect(results.every((entry) => entry.id === "OI-race-1")).toBe(true);
  expect((await readOwnerInspection(root, "OI-race-1")).scenario).toBe("Scenario A");
});

test("RED: concurrent acknowledgements all persist under distinct sequences with none lost or overwritten", async () => {
  const root = await fixture();
  await publishOwnerInspection(root, packet(), publisher);
  const before = await readFile(ownerInspectionFile(root, "OI-race-1"), "utf8");

  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => acknowledgeOwnerInspection(root, "OI-race-1", { by: "operator@desk", note: `note ${index}` })));
  expect(new Set(results.map((entry) => entry.sequence)).size).toBe(10);
  const history = (await readOwnerInspection(root, "OI-race-1")).acknowledgements ?? [];
  expect(history).toHaveLength(10);
  expect(history.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(new Set(history.map((entry) => entry.note)).size).toBe(10);
  expect(await readFile(ownerInspectionFile(root, "OI-race-1"), "utf8")).toBe(before);
});
