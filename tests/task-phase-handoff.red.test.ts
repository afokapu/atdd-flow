import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respondToHandoff, submitHandoff } from "../src/tasks";

const cli = join(import.meta.dir, "..", "src", "cli.ts");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-phase-handoff-"));
  await mkdir(join(root, "work", "demo", "seats", "driver.delivery"), { recursive: true });
  await mkdir(join(root, "work", "demo", "seats", "coordinator"), { recursive: true });
  await mkdir(join(root, "work", "demo", "tasks"), { recursive: true });
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await writeFile(join(root, "work", "demo", "project.yaml"), "schema: atdd-workflow/project/v1\nproject: demo\n");
  await writeFile(join(root, "work", "demo", "seats", "driver.delivery", "seat.yaml"), "schema: atdd-workflow/seat/v2\naddress: driver.delivery@demo\nrole: driver\nproject: demo\nworktree: /tmp/delivery\nbranch: delivery/test\n");
  await writeFile(join(root, "work", "demo", "seats", "coordinator", "seat.yaml"), "schema: atdd-workflow/seat/v2\naddress: coordinator@demo\nrole: coordinator\nproject: demo\nworktree: /tmp/coordinator\nbranch: main\n");
  await writeFile(join(root, "work", "demo", "tasks", "delivery.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/task/v1",
    title: "Deliver phase handoff",
    status: "in_progress",
    coordinator: "coordinator@demo",
    assignee: "driver.delivery@demo",
    done_when: [{ text: "Delivery works" }],
  }));
  return root;
}

async function invoke(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "--root", root, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { output: `${stdout}${stderr}`, exitCode };
}

async function task(root: string) {
  return Bun.YAML.parse(await readFile(join(root, "work", "demo", "tasks", "delivery.yaml"), "utf8"));
}

test("RED: assignee handoff links phase evidence without changing authoritative task status", async () => {
  const root = await fixture();
  try {
    await submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "red", "--evidence", "M-test-red-proof",
    ]);
    expect(await task(root)).toMatchObject({
      status: "in_progress",
      phase: "red",
      handoff: { state: "awaiting_coordinator", evidence: "M-test-red-proof", updated_at: expect.any(String) },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RED: only the assigned driver may submit a non-empty, legal phase handoff", async () => {
  const root = await fixture();
  try {
    await expect(submitHandoff(root, "demo", "delivery", [
      "--by", "coordinator@demo", "--phase", "red", "--evidence", "M-proof",
    ])).rejects.toThrow(/assignee|driver/i);
    await expect(submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "invalid", "--evidence", "M-proof",
    ])).rejects.toThrow(/phase/i);
    await expect(submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "red", "--evidence", "",
    ])).rejects.toThrow(/evidence/i);
    await submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "red", "--evidence", "M-proof",
    ]);
    await expect(submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "green", "--evidence", "M-second-proof",
    ])).rejects.toThrow(/awaiting.*coordinator/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("GREEN: the two direct CLI operations persist a submitted handoff and coordinator response", async () => {
  const root = await fixture();
  try {
    const submitted = await invoke(root, "task", "handoff", "demo", "delivery",
      "--by", "driver.delivery@demo", "--phase", "plan", "--evidence", "M-cli-plan");
    expect(submitted.exitCode, submitted.output).toBe(0);
    const answered = await invoke(root, "task", "respond", "demo", "delivery",
      "--by", "coordinator@demo", "--outcome", "accept", "--phase", "red");
    expect(answered.exitCode, answered.output).toBe(0);
    expect(await task(root)).toMatchObject({
      status: "in_progress",
      phase: "red",
      handoff: { state: "awaiting_assignee", evidence: "M-cli-plan", updated_at: expect.any(String) },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RED: coordinator acceptance or return names the next phase and retains immutable evidence linkage", async () => {
  const root = await fixture();
  try {
    await submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "red", "--evidence", "M-test-red-proof",
    ]);
    await respondToHandoff(root, "demo", "delivery", [
      "--by", "coordinator@demo", "--outcome", "accept", "--phase", "green",
    ]);
    expect(await task(root)).toMatchObject({
      status: "in_progress",
      phase: "green",
      handoff: { state: "awaiting_assignee", evidence: "M-test-red-proof", updated_at: expect.any(String) },
    });
    await submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "green", "--evidence", "PR-42",
    ]);
    await respondToHandoff(root, "demo", "delivery", [
      "--by", "coordinator@demo", "--outcome", "return", "--phase", "refactor",
    ]);
    expect(await task(root)).toMatchObject({
      status: "in_progress",
      phase: "refactor",
      handoff: { state: "executing", evidence: "PR-42", updated_at: expect.any(String) },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RED: coordinator response is constrained to a submitted handoff and never changes task status", async () => {
  const root = await fixture();
  try {
    await expect(respondToHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--outcome", "accept", "--phase", "green",
    ])).rejects.toThrow(/coordinator/i);
    await expect(respondToHandoff(root, "demo", "delivery", [
      "--by", "coordinator@demo", "--outcome", "accept", "--phase", "green",
    ])).rejects.toThrow(/awaiting.*coordinator/i);
    await submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "plan", "--evidence", "M-plan",
    ]);
    await expect(respondToHandoff(root, "demo", "delivery", [
      "--by", "coordinator@demo", "--outcome", "invalid", "--phase", "green",
    ])).rejects.toThrow(/outcome/i);
    await expect(respondToHandoff(root, "demo", "delivery", [
      "--by", "coordinator@demo", "--outcome", "accept", "--phase", "invalid",
    ])).rejects.toThrow(/phase/i);
    expect((await task(root)).status).toBe("in_progress");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RED: legacy tasks remain readable and task status reports optional handoff with offline runtime observation", async () => {
  const root = await fixture();
  try {
    const legacy = await invoke(root, "task", "open", "demo", "delivery");
    expect(legacy.exitCode, legacy.output).toBe(0);
    expect(legacy.output).not.toContain("phase:");

    await submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "red", "--evidence", "M-status-proof",
    ]);
    const status = await invoke(root, "status", "task", "demo", "delivery");
    expect(status.exitCode, status.output).toBe(0);
    expect(status.output).toContain("PHASE / HANDOFF");
    expect(status.output).toContain("RED");
    expect(status.output).toContain("AWAITING-COORDINATOR");
    expect(status.output).toContain("M-status-proof");
    expect(status.output).toContain("OFFLINE");
  } finally { await rm(root, { recursive: true, force: true }); }
});
