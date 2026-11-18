// URN: test:atdd-flow:awaiting-assignee-continuation
// Acceptance: acc:flow:E021-UNIT-001
// Phase: UNIT
// Purpose: `status task` NEXT for an in_progress task (awaiting_assignee/executing/awaiting_coordinator) names the supported assignee
// continuation instead of a refused duplicate `task start`; todo/terminal/blocked/unassigned paths stay fail-closed and status is read-only.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const driver = "driver.delivery@demo";
const coordinator = "coordinator@demo";

/** Isolated temporary Desk; never touches a live Desk. */
async function fixture(task: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-awaiting-assignee-"));
  await mkdir(join(root, "work", "demo", "seats", "driver.delivery"), { recursive: true });
  await mkdir(join(root, "work", "demo", "seats", "coordinator"), { recursive: true });
  await mkdir(join(root, "work", "demo", "tasks"), { recursive: true });
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await writeFile(join(root, "work", "demo", "project.yaml"), "schema: atdd-workflow/project/v1\nproject: demo\n");
  await writeFile(join(root, "work", "demo", "seats", "driver.delivery", "seat.yaml"), `schema: atdd-workflow/seat/v2\naddress: ${driver}\nrole: driver\nproject: demo\nworktree: /tmp/delivery\nbranch: delivery/test\n`);
  await writeFile(join(root, "work", "demo", "seats", "coordinator", "seat.yaml"), `schema: atdd-workflow/seat/v2\naddress: ${coordinator}\nrole: coordinator\nproject: demo\nworktree: /tmp/coordinator\nbranch: main\n`);
  await writeFile(join(root, "work", "demo", "tasks", "delivery.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/task/v1", title: "Deliver", status: "in_progress", coordinator, assignee: driver,
    done_when: [{ text: "Delivery works", proof: "M-proof" }], ...task,
  }));
  return root;
}

async function invoke(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "--root", root, ...args], { cwd: root, env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { output: `${stdout}${stderr}`, exitCode };
}

const handoff = (state: string, phase: string) => ({ phase, handoff: { state, evidence: "M-evidence", updated_at: "2026-11-03T17:02:05.116Z", submitted_phase: phase } });
const taskFile = (root: string) => join(root, "work", "demo", "tasks", "delivery.yaml");
const next = async (root: string) => (await invoke(root, "status", "task", "demo", "delivery")).output.split("NEXT").at(-1) ?? "";

test("RED: in-progress REFACTOR accepted (desk migration shape) never recommends a duplicate task start", async () => {
  const root = await fixture(handoff("awaiting_assignee", "refactor"));
  try {
    const text = await next(root);
    expect(text).not.toContain("task start");
    expect(text).toContain(`atdd-flow task review demo delivery --by ${driver}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RED: REFACTOR accepted with a missing proof directs to record proof, not a review that would refuse", async () => {
  const root = await fixture({ ...handoff("awaiting_assignee", "refactor"), done_when: [{ text: "Delivery works" }] });
  try {
    const text = await next(root);
    expect(text).not.toContain("task start");
    expect(text).not.toContain("task review");
    expect(text).toContain(`atdd-flow task prove demo delivery --by ${driver}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RED: accepted earlier phases continue with the next phase handoff", async () => {
  for (const [accepted, following] of [["plan", "red"], ["red", "green"], ["green", "refactor"]]) {
    const root = await fixture(handoff("awaiting_assignee", accepted));
    try {
      const text = await next(root);
      expect(text).not.toContain("task start");
      expect(text).toContain(`atdd-flow task handoff demo delivery --by ${driver} --phase ${following}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("RED: executing continues the current phase and awaiting_coordinator waits without a command", async () => {
  const executing = await fixture(handoff("executing", "green"));
  const waiting = await fixture(handoff("awaiting_coordinator", "green"));
  try {
    const running = await next(executing);
    expect(running).not.toContain("task start");
    expect(running).toContain(`atdd-flow task handoff demo delivery --by ${driver} --phase green`);
    const idle = await next(waiting);
    expect(idle).not.toContain("task start");
    expect(idle).not.toContain("atdd-flow task ");
  } finally { await rm(executing, { recursive: true, force: true }); await rm(waiting, { recursive: true, force: true }); }
});

test("RED: fail-closed paths are preserved", async () => {
  const todo = await fixture({ status: "todo" });
  const done = await fixture({ status: "done", ...handoff("awaiting_assignee", "refactor") });
  const blocked = await fixture({ blocker: "Waiting on owner", ...handoff("awaiting_assignee", "refactor") });
  const unassigned = await fixture({ assignee: undefined, ...handoff("awaiting_assignee", "refactor") });
  try {
    expect(await next(todo)).toContain(`atdd-flow task start demo delivery --by ${driver}`);
    const closed = await next(done);
    expect(closed).not.toContain("task start");
    expect(closed).not.toContain("task review");
    const stopped = await next(blocked);
    expect(stopped).toContain("blocker");
    expect(stopped).not.toContain("task start");
    expect(stopped).not.toContain("task review");
    expect(await next(unassigned)).toContain("assign a driver");
  } finally { for (const root of [todo, done, blocked, unassigned]) await rm(root, { recursive: true, force: true }); }
});

test("RED: no duplicate start, no state escape, and status is read-only (no fabricated acknowledgement)", async () => {
  const root = await fixture({ ...handoff("awaiting_assignee", "refactor"), immediate_dispatch: { thread: "T", message: "M", priority: "p", mutation_boundary: "b", assignee: driver, status: "dispatched" } });
  try {
    const before = await readFile(taskFile(root), "utf8");
    await next(root);
    const started = await invoke(root, "task", "start", "demo", "delivery", "--by", driver);
    expect(started.exitCode).not.toBe(0);
    expect(started.output).toMatch(/cannot move from in_progress to in_progress/);
    const coordinatorStart = await invoke(root, "task", "start", "demo", "delivery", "--by", coordinator);
    expect(coordinatorStart.exitCode).not.toBe(0);
    expect(await readFile(taskFile(root), "utf8")).toBe(before);
    expect(before).not.toContain("acknowledgement");
  } finally { await rm(root, { recursive: true, force: true }); }
});
