// URN: test:atdd-flow:owner-inspection-cli
// Acceptance: acc:flow:E042-UNIT-001
// Phase: UNIT
import { afterEach, expect, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Phase 1 RED (CLI slice): the approved `atdd-flow owner-inspection publish|read|ack|status` wiring and the
// `atdd-flow status task` owner-inspection section. The module-level matrix lives in
// owner-inspection-record-lifecycle.red.test.ts and is unchanged.
const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const test = (name: string, body: () => unknown | Promise<unknown>) => bunTest(name, body, 30_000);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function atdd(root: string, ...args: string[]) {
  const environment = { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined } as Record<string, string | undefined>;
  delete environment.ATDD_WORKFLOW_ROOT;
  delete environment.ATDD_WORKFLOW_SEAT;
  const child = Bun.spawn([process.execPath, cli, "--root", root, ...args], { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

async function seat(root: string, project: string, local: string, address: string, role: string) {
  await mkdir(join(root, "work", project, "seats", local), { recursive: true });
  await writeFile(join(root, "work", project, "seats", local, "seat.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/seat/v2", address, role, project, worktree: `/tmp/${local}`, branch: "main",
  }));
  await writeFile(join(root, "work", project, "seats", local, "checkpoint.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/checkpoint/v1", seat: address, status: "active",
    updated_at: "2026-11-04T19:00:00.000Z", summary: "fixture", next_action: "fixture",
  }));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-owner-inspection-cli-"));
  roots.push(root);
  await mkdir(join(root, "work", "desk"), { recursive: true });
  await mkdir(join(root, "work", "demo", "tasks"), { recursive: true });
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await writeFile(join(root, "work", "desk", "project.yaml"), "schema: atdd-workflow/project/v1\nproject: desk\n");
  await writeFile(join(root, "work", "demo", "project.yaml"), "schema: atdd-workflow/project/v1\nproject: demo\n");
  await seat(root, "desk", "operator", "operator@desk", "operator");
  await seat(root, "demo", "coordinator", "coordinator@demo", "coordinator");
  await seat(root, "demo", "driver.delivery", "driver.delivery@demo", "driver");
  await writeFile(join(root, "work", "demo", "tasks", "feature.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/task/v1", title: "feature", status: "review", coordinator: "coordinator@demo",
    assignee: "driver.delivery@demo", done_when: [{ text: "fixture", proof: "fixture-proof" }],
  }));
  return root;
}

const ref = (kind: string, name: string) => ({ kind, locator: `evidence/${name}`, sha256: "a".repeat(64) });
const packet = (overrides: Record<string, unknown> = {}) => ({
  id: "OI-candidate-1", stage: "candidate", parent: { project: "demo", task: "feature" }, owner: "driver.delivery@demo",
  surface: { kind: "web", name: "Demo dashboard" }, scenario: "Owner opens the dashboard and sees the new panel.",
  data_classification: "synthetic", target: { kind: "local", locator: "http://localhost:4173" },
  provenance: { task: "demo/feature", pr: "demo#12", commit: "b".repeat(40) },
  evidence: { health: ref("health", "h.json"), smoke: ref("smoke", "s.json"), teardown: ref("teardown", "t.json"), rendered: ref("rendered", "r.png") },
  ...overrides,
});

async function publish(root: string, value: Record<string, unknown> = packet(), by = "driver.delivery@demo") {
  const file = join(root, "packet.yaml");
  await writeFile(file, Bun.YAML.stringify(value));
  return atdd(root, "owner-inspection", "publish", "--file", file, "--by", by);
}

test("RED: the CLI publishes a packet file and reads back the immutable reference-only record", async () => {
  const root = await fixture();
  const published = await publish(root);
  expect(published.code, published.stderr).toBe(0);
  expect(published.stdout).toContain("OI-candidate-1");

  const read = await atdd(root, "owner-inspection", "read", "OI-candidate-1");
  expect(read.code, read.stderr).toBe(0);
  const record = Bun.YAML.parse(read.stdout) as any;
  expect(record.schema).toBe("atdd-workflow/owner-inspection/v1");
  expect(record.parent).toEqual({ project: "demo", task: "feature" });
  expect(record.evidence.rendered).toEqual(ref("rendered", "r.png"));
});

test("RED: the CLI rejects an incomplete packet, a changed republish, and an unknown id with a non-zero exit", async () => {
  const root = await fixture();
  const incomplete = packet();
  delete (incomplete as any).scenario;
  const missing = await publish(root, incomplete);
  expect(missing.code).not.toBe(0);
  expect(missing.stderr).toMatch(/scenario/i);

  expect((await publish(root)).code).toBe(0);
  const changed = await publish(root, packet({ scenario: "A different scenario." }));
  expect(changed.code).not.toBe(0);
  expect(changed.stderr).toMatch(/immutable|already/i);

  const unknown = await atdd(root, "owner-inspection", "read", "OI-absent");
  expect(unknown.code).not.toBe(0);
  expect(unknown.stderr).toContain("OI-absent");
});

test("RED: the CLI acknowledges only as operator@desk and appends history", async () => {
  const root = await fixture();
  await publish(root);

  for (const by of ["driver.delivery@demo", "coordinator@demo"]) {
    const denied = await atdd(root, "owner-inspection", "ack", "OI-candidate-1", "--by", by, "--note", "approved");
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("operator@desk");
  }
  const noNote = await atdd(root, "owner-inspection", "ack", "OI-candidate-1", "--by", "operator@desk");
  expect(noNote.code).not.toBe(0);
  expect(noNote.stderr).toMatch(/note/i);

  const acked = await atdd(root, "owner-inspection", "ack", "OI-candidate-1", "--by", "operator@desk", "--note", "Inspected; matches behavior.");
  expect(acked.code, acked.stderr).toBe(0);
  const record = Bun.YAML.parse((await atdd(root, "owner-inspection", "read", "OI-candidate-1")).stdout) as any;
  expect(record.acknowledgements).toHaveLength(1);
  expect(record.acknowledgements[0]).toMatchObject({ by: "operator@desk", note: "Inspected; matches behavior.", immutable: true });
});

test("RED: the CLI status reports pending then acknowledged per project and per task, advisory only", async () => {
  const root = await fixture();
  const taskFile = join(root, "work", "demo", "tasks", "feature.yaml");
  const taskBefore = await readFile(taskFile, "utf8");
  await publish(root);

  const pending = await atdd(root, "owner-inspection", "status", "demo", "feature");
  expect(pending.code, pending.stderr).toBe(0);
  expect(Bun.YAML.parse(pending.stdout)).toMatchObject({ pending: ["OI-candidate-1"], acknowledged: [] });
  expect(Bun.YAML.parse((await atdd(root, "owner-inspection", "status", "demo")).stdout)).toMatchObject({ pending: ["OI-candidate-1"] });

  await atdd(root, "owner-inspection", "ack", "OI-candidate-1", "--by", "operator@desk", "--note", "ok");
  expect(Bun.YAML.parse((await atdd(root, "owner-inspection", "status", "demo", "feature")).stdout)).toMatchObject({ pending: [], acknowledged: ["OI-candidate-1"] });
  expect(await readFile(taskFile, "utf8")).toBe(taskBefore);
});

test("RED: `atdd-flow status task` shows an OWNER INSPECTION section that clears on acknowledgement", async () => {
  const root = await fixture();
  await publish(root);

  const held = await atdd(root, "status", "task", "demo", "feature");
  expect(held.code, held.stderr).toBe(0);
  expect(held.stdout).toContain("OWNER INSPECTION");
  expect(held.stdout).toContain("OI-candidate-1");
  expect(held.stdout).toMatch(/pending|held/i);

  await atdd(root, "owner-inspection", "ack", "OI-candidate-1", "--by", "operator@desk", "--note", "ok");
  const cleared = await atdd(root, "status", "task", "demo", "feature");
  expect(cleared.stdout).toContain("OWNER INSPECTION");
  expect(cleared.stdout).toMatch(/acknowledged/i);
});

test("RED: the CLI hold blocks `task done` until the owner acknowledges", async () => {
  const root = await fixture();
  await publish(root);

  const blocked = await atdd(root, "task", "done", "demo", "feature", "--by", "coordinator@demo");
  expect(blocked.code).not.toBe(0);
  expect(blocked.stderr).toContain("OI-candidate-1");

  await atdd(root, "owner-inspection", "ack", "OI-candidate-1", "--by", "operator@desk", "--note", "ok");
  const afterAck = await atdd(root, "task", "done", "demo", "feature", "--by", "coordinator@demo");
  expect(afterAck.stderr).not.toContain("OI-candidate-1");
});

test("RED: the CLI usage lists owner-inspection and rejects unknown subcommands", async () => {
  const root = await fixture();
  const help = await atdd(root, "--help");
  expect(help.stdout + help.stderr).toMatch(/owner-inspection publish/);
  expect(help.stdout + help.stderr).toMatch(/owner-inspection ack/);

  const unknown = await atdd(root, "owner-inspection", "frobnicate");
  expect(unknown.code).not.toBe(0);
  expect(unknown.stderr).toMatch(/owner-inspection publish\|read\|ack\|status/);
});
