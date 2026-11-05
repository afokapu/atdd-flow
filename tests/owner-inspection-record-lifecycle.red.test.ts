// URN: test:atdd-flow:owner-inspection-record-lifecycle
// Acceptance: acc:flow:E041-UNIT-001
// Phase: UNIT
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDependentsMayUnblock, assertParentMayComplete } from "../src/ephemeral-resources";

// Phase 1 RED: Flow owns the owner-inspection record lifecycle per docs/owner-inspection-shared-contract.adoc.
// The module is loaded dynamically so each test fails on its own missing behavior.
const load = () => import("../src/owner-inspection");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { operator?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-owner-inspection-"));
  roots.push(root);
  await mkdir(join(root, "work", "desk", "seats", "operator"), { recursive: true });
  await mkdir(join(root, "work", "demo", "seats", "coordinator"), { recursive: true });
  await mkdir(join(root, "work", "demo", "seats", "driver.delivery"), { recursive: true });
  await mkdir(join(root, "work", "demo", "tasks"), { recursive: true });
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await writeFile(join(root, "work", "desk", "project.yaml"), "schema: atdd-workflow/project/v1\nproject: desk\n");
  await writeFile(join(root, "work", "demo", "project.yaml"), "schema: atdd-workflow/project/v1\nproject: demo\n");
  if (options.operator !== false) await seat(root, "desk", "operator", "operator@desk", "operator");
  await seat(root, "demo", "coordinator", "coordinator@demo", "coordinator");
  await seat(root, "demo", "driver.delivery", "driver.delivery@demo", "driver");
  await writeFile(join(root, "work", "demo", "tasks", "feature.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/task/v1", title: "feature", status: "review", coordinator: "coordinator@demo",
    assignee: "driver.delivery@demo", done_when: [{ text: "fixture" }],
  }));
  return root;
}

async function seat(root: string, project: string, local: string, address: string, role: string) {
  await writeFile(join(root, "work", project, "seats", local, "seat.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/seat/v2", address, role, project, worktree: `/tmp/${local}`, branch: "main",
  }));
  await writeFile(join(root, "work", project, "seats", local, "checkpoint.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/checkpoint/v1", seat: address, status: "active",
    updated_at: "2026-11-04T19:00:00.000Z", summary: "fixture", next_action: "fixture",
  }));
}

const ref = (kind: string, name: string) => ({ kind, locator: `evidence/${name}`, sha256: "a".repeat(64) });

function packet(overrides: Record<string, unknown> = {}) {
  return {
    id: "OI-candidate-1",
    stage: "candidate",
    parent: { project: "demo", task: "feature" },
    owner: "driver.delivery@demo",
    surface: { kind: "web", name: "Demo dashboard" },
    scenario: "Owner opens the dashboard and sees the new panel with sample data.",
    data_classification: "synthetic",
    target: { kind: "local", locator: "http://localhost:4173" },
    provenance: { task: "demo/feature", pr: "demo#12", commit: "b".repeat(40) },
    evidence: {
      health: ref("health", "health.json"),
      smoke: ref("smoke", "smoke.json"),
      teardown: ref("teardown", "teardown.json"),
      rendered: ref("rendered", "dashboard.png"),
    },
    ...overrides,
  };
}

const without = (value: Record<string, any>, ...path: string[]) => {
  const copy = structuredClone(value);
  let cursor: any = copy;
  for (const key of path.slice(0, -1)) cursor = cursor[key];
  delete cursor[path.at(-1)!];
  return copy;
};

const publisher = { by: "driver.delivery@demo" };
const operator = { by: "operator@desk", note: "Inspected the candidate; matches the stated behavior." };

// ---------- positive lifecycle ----------

test("RED: a complete candidate packet publishes one immutable record that stores references only", async () => {
  const { publishOwnerInspection, readOwnerInspection, ownerInspectionFile } = await load();
  const root = await fixture();

  const published = await publishOwnerInspection(root, packet(), publisher);
  expect(published.id).toBe("OI-candidate-1");
  const stored = Bun.YAML.parse(await readFile(ownerInspectionFile(root, "OI-candidate-1"), "utf8")) as any;
  expect(stored.schema).toBe("atdd-workflow/owner-inspection/v1");
  expect(stored.stage).toBe("candidate");
  expect(stored.owner).toBe("driver.delivery@demo");
  expect(stored.evidence.rendered).toEqual(ref("rendered", "dashboard.png"));

  const read = await readOwnerInspection(root, "OI-candidate-1");
  expect(read.parent).toEqual({ project: "demo", task: "feature" });
  expect(read.provenance.commit).toBe("b".repeat(40));
  expect(JSON.stringify(read)).not.toContain("content");
});

test("RED: a merge packet publishes when it cites a published candidate record", async () => {
  const { publishOwnerInspection, readOwnerInspection } = await load();
  const root = await fixture();
  await publishOwnerInspection(root, packet(), publisher);

  await publishOwnerInspection(root, packet({ id: "OI-merge-1", stage: "merge", candidate: "OI-candidate-1" }), publisher);
  const read = await readOwnerInspection(root, "OI-merge-1");
  expect(read.stage).toBe("merge");
  expect(read.candidate).toBe("OI-candidate-1");
});

test("RED: a toolkit-only surface may state N/A only with an exact rationale and CI, ratchet, or package evidence", async () => {
  const { publishOwnerInspection, readOwnerInspection } = await load();
  const root = await fixture();
  const toolkit = packet({
    id: "OI-toolkit-1",
    surface: { kind: "toolkit", name: "atdd-flow CLI" },
    evidence: {
      health: ref("health", "health.json"), smoke: ref("smoke", "smoke.json"), teardown: ref("teardown", "teardown.json"),
      rendered: { na: true, rationale: "CLI-only toolkit surface has no rendered UI.", evidence: ref("ci", "ci-run.json") },
    },
  });
  await publishOwnerInspection(root, toolkit, publisher);
  expect((await readOwnerInspection(root, "OI-toolkit-1")).evidence.rendered.na).toBe(true);
});

test("RED: only operator@desk acknowledges, and acknowledgement appends immutable history without rewriting the record", async () => {
  const { publishOwnerInspection, acknowledgeOwnerInspection, readOwnerInspection, ownerInspectionFile } = await load();
  const root = await fixture();
  await publishOwnerInspection(root, packet(), publisher);
  const before = await readFile(ownerInspectionFile(root, "OI-candidate-1"), "utf8");

  await acknowledgeOwnerInspection(root, "OI-candidate-1", { ...operator, now: "2026-11-04T20:40:00.000Z" });
  await acknowledgeOwnerInspection(root, "OI-candidate-1", { ...operator, note: "Second look agrees.", now: "2026-11-04T20:41:00.000Z" });

  expect(await readFile(ownerInspectionFile(root, "OI-candidate-1"), "utf8")).toBe(before);
  const read = await readOwnerInspection(root, "OI-candidate-1");
  expect(read.acknowledgements).toHaveLength(2);
  expect(read.acknowledgements.map((entry: any) => entry.by)).toEqual(["operator@desk", "operator@desk"]);
  expect(read.acknowledgements[0].note).toBe(operator.note);
  expect(read.acknowledgements.every((entry: any) => entry.immutable === true)).toBe(true);
});

test("RED: advisory status moves from pending to acknowledged and never mutates tasks", async () => {
  const { publishOwnerInspection, acknowledgeOwnerInspection, ownerInspectionStatus } = await load();
  const root = await fixture();
  const taskFile = join(root, "work", "demo", "tasks", "feature.yaml");
  const taskBefore = await readFile(taskFile, "utf8");
  await publishOwnerInspection(root, packet(), publisher);

  expect(await ownerInspectionStatus(root, "demo", "feature")).toMatchObject({ pending: ["OI-candidate-1"], acknowledged: [] });
  await acknowledgeOwnerInspection(root, "OI-candidate-1", operator);
  expect(await ownerInspectionStatus(root, "demo", "feature")).toMatchObject({ pending: [], acknowledged: ["OI-candidate-1"] });
  expect(await readFile(taskFile, "utf8")).toBe(taskBefore);
});

test("RED: an unacknowledged record holds parent completion and dependent unblock through the existing Flow hold seam until acknowledged", async () => {
  const { publishOwnerInspection, acknowledgeOwnerInspection } = await load();
  const root = await fixture();
  await publishOwnerInspection(root, packet(), publisher);

  await expect(assertParentMayComplete(root, { project: "demo", task: "feature" })).rejects.toThrow(/OI-candidate-1/);
  await expect(assertDependentsMayUnblock(root, { project: "demo", task: "feature" })).rejects.toThrow(/OI-candidate-1/);

  await acknowledgeOwnerInspection(root, "OI-candidate-1", operator);
  await expect(assertParentMayComplete(root, { project: "demo", task: "feature" })).resolves.toBeUndefined();
  await expect(assertDependentsMayUnblock(root, { project: "demo", task: "feature" })).resolves.toBeUndefined();
});

// ---------- negative: required packet fields ----------

const missing: Array<[string, string[]]> = [
  ["owner", ["owner"]],
  ["surface", ["surface"]],
  ["scenario", ["scenario"]],
  ["data classification", ["data_classification"]],
  ["health evidence", ["evidence", "health"]],
  ["smoke evidence", ["evidence", "smoke"]],
  ["teardown evidence", ["evidence", "teardown"]],
  ["rendered evidence", ["evidence", "rendered"]],
];

for (const [label, path] of missing) {
  test(`RED: a packet missing ${label} is a named negative result, not an inferred substitute`, async () => {
    const { publishOwnerInspection, ownerInspectionFile } = await load();
    const root = await fixture();
    await expect(publishOwnerInspection(root, without(packet(), ...path), publisher)).rejects.toThrow(new RegExp(path.at(-1)!.replace("_", "[ _]"), "i"));
    expect(await Bun.file(ownerInspectionFile(root, "OI-candidate-1")).exists()).toBe(false);
  });
}

test("RED: N/A rendered evidence is rejected for a non-toolkit surface and without a rationale or direct evidence", async () => {
  const { publishOwnerInspection } = await load();
  const root = await fixture();
  const na = (extra: Record<string, unknown>) => ({ na: true, ...extra });
  const evidenceWith = (rendered: unknown) => ({ ...packet().evidence, rendered });

  await expect(publishOwnerInspection(root, packet({ evidence: evidenceWith(na({ rationale: "n/a", evidence: ref("ci", "ci.json") })) }), publisher)).rejects.toThrow(/toolkit/i);
  const toolkit = { surface: { kind: "toolkit", name: "atdd-flow CLI" } };
  await expect(publishOwnerInspection(root, packet({ ...toolkit, evidence: evidenceWith(na({ evidence: ref("ci", "ci.json") })) }), publisher)).rejects.toThrow(/rationale/i);
  await expect(publishOwnerInspection(root, packet({ ...toolkit, evidence: evidenceWith(na({ rationale: "CLI only" })) }), publisher)).rejects.toThrow(/evidence/i);
  await expect(publishOwnerInspection(root, packet({ ...toolkit, evidence: evidenceWith(na({ rationale: "CLI only", evidence: ref("screenshot", "x.png") })) }), publisher)).rejects.toThrow(/CI|ratchet|package/i);
});

// ---------- negative: safety ----------

test("RED: production, implicit, or fabricated targets are rejected and no URL is generated", async () => {
  const { publishOwnerInspection, ownerInspectionFile } = await load();
  const root = await fixture();

  await expect(publishOwnerInspection(root, packet({ target: { kind: "production", locator: "https://app.example.com" } }), publisher)).rejects.toThrow(/production/i);
  await expect(publishOwnerInspection(root, packet({ target: { kind: "preview" } }), publisher)).rejects.toThrow(/explicit|preview/i);
  await expect(publishOwnerInspection(root, without(packet(), "target"), publisher)).rejects.toThrow(/target/i);
  expect(await Bun.file(ownerInspectionFile(root, "OI-candidate-1")).exists()).toBe(false);
});

test("RED: no artifact contents or secrets are persisted in the record", async () => {
  const { publishOwnerInspection, ownerInspectionFile } = await load();
  const root = await fixture();
  const leaky = packet({ evidence: { ...packet().evidence, health: { ...ref("health", "health.json"), content: "token=TOPSECRET" } } });

  await expect(publishOwnerInspection(root, leaky, publisher)).rejects.toThrow(/content|reference/i);
  expect(await Bun.file(ownerInspectionFile(root, "OI-candidate-1")).exists()).toBe(false);
});

// ---------- negative: immutability and provenance ----------

test("RED: republishing a changed payload is rejected while an identical republish is idempotent", async () => {
  const { publishOwnerInspection, ownerInspectionFile } = await load();
  const root = await fixture();
  await publishOwnerInspection(root, packet(), publisher);
  const before = await readFile(ownerInspectionFile(root, "OI-candidate-1"), "utf8");

  await expect(publishOwnerInspection(root, packet(), publisher)).resolves.toMatchObject({ id: "OI-candidate-1" });
  await expect(publishOwnerInspection(root, packet({ scenario: "A different scenario." }), publisher)).rejects.toThrow(/immutable|already/i);
  expect(await readFile(ownerInspectionFile(root, "OI-candidate-1"), "utf8")).toBe(before);
});

test("RED: a merge record without a published candidate, and an unknown stage, are rejected", async () => {
  const { publishOwnerInspection } = await load();
  const root = await fixture();

  await expect(publishOwnerInspection(root, packet({ id: "OI-merge-1", stage: "merge" }), publisher)).rejects.toThrow(/candidate/i);
  await expect(publishOwnerInspection(root, packet({ id: "OI-merge-2", stage: "merge", candidate: "OI-absent" }), publisher)).rejects.toThrow(/candidate/i);
  await expect(publishOwnerInspection(root, packet({ stage: "release" }), publisher)).rejects.toThrow(/stage/i);
});

// ---------- negative: operator-only acknowledgement ----------

test("RED: driver, coordinator, and unknown seats cannot acknowledge, and a missing operator seat fails closed", async () => {
  const { publishOwnerInspection, acknowledgeOwnerInspection, readOwnerInspection } = await load();
  const root = await fixture();
  await publishOwnerInspection(root, packet(), publisher);

  for (const by of ["driver.delivery@demo", "coordinator@demo", "main@demo", "someone@elsewhere"]) {
    await expect(acknowledgeOwnerInspection(root, "OI-candidate-1", { by, note: "approved" })).rejects.toThrow(/operator@desk/);
  }
  await expect(acknowledgeOwnerInspection(root, "OI-candidate-1", { by: "operator@desk", note: "" })).rejects.toThrow(/note/i);
  await expect(acknowledgeOwnerInspection(root, "OI-absent", operator)).rejects.toThrow(/OI-absent/);
  expect((await readOwnerInspection(root, "OI-candidate-1")).acknowledgements ?? []).toHaveLength(0);

  const noOperator = await fixture({ operator: false });
  await publishOwnerInspection(noOperator, packet(), publisher);
  await expect(acknowledgeOwnerInspection(noOperator, "OI-candidate-1", operator)).rejects.toThrow(/operator@desk/);
  await expect(assertParentMayComplete(noOperator, { project: "demo", task: "feature" })).rejects.toThrow(/OI-candidate-1/);
});

test("RED: the hold clears only on acknowledgement and a failed acknowledgement leaves it in place", async () => {
  const { publishOwnerInspection, acknowledgeOwnerInspection } = await load();
  const root = await fixture();
  await publishOwnerInspection(root, packet(), publisher);

  await expect(acknowledgeOwnerInspection(root, "OI-candidate-1", { by: "driver.delivery@demo", note: "self-approve" })).rejects.toThrow();
  await expect(assertParentMayComplete(root, { project: "demo", task: "feature" })).rejects.toThrow(/OI-candidate-1/);
});

test("RED: Flow keeps one inspection state tree and writes nothing outside Flow-owned paths", async () => {
  const { publishOwnerInspection } = await load();
  const root = await fixture();
  const names = async () => (await readdir(root, { recursive: true })).map(String).sort();
  const before = await names();
  await publishOwnerInspection(root, packet(), publisher);

  const added = (await names()).filter((entry) => !before.includes(entry));
  expect(added.length).toBeGreaterThan(0);
  // The recursive listing also names the bare `.atdd-flow` parent directory; every other new path must sit inside the one tree.
  expect(added.every((entry) => entry === ".atdd-flow" || entry.startsWith(".atdd-flow/owner-inspections"))).toBe(true);
});
