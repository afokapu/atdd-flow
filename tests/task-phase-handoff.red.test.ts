import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
  const child = Bun.spawn([process.execPath, cli, "--root", root, ...args], { cwd: root, env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined }, stdout: "pipe", stderr: "pipe" });
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
      "--by", "coordinator@demo", "--outcome", "accept", "--phase", "red", "--plan-review", "M-coach-reviewed-plan");
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
      "--by", "coordinator@demo", "--outcome", "return", "--phase", "green",
    ]);
    expect(await task(root)).toMatchObject({
      status: "in_progress",
      phase: "green",
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


test("PLT-128: PLAN cannot advance without Coach review evidence and only one phase at a time", async () => {
  const root = await fixture();
  try {
    await submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "plan", "--evidence", "M-driver-plan",
    ]);
    await expect(respondToHandoff(root, "demo", "delivery", [
      "--by", "coordinator@demo", "--outcome", "accept", "--phase", "red",
    ])).rejects.toThrow(/PLAN review/i);
    await expect(respondToHandoff(root, "demo", "delivery", [
      "--by", "coordinator@demo", "--outcome", "accept", "--phase", "green",
      "--plan-review", "M-reviewed",
    ])).rejects.toThrow(/must advance to RED/i);
    await respondToHandoff(root, "demo", "delivery", [
      "--by", "coordinator@demo", "--outcome", "accept", "--phase", "red",
      "--plan-review", "M-coach-plan-review",
    ]);
    expect(await task(root)).toMatchObject({
      phase: "red",
      handoff: { plan_review: { by: "coordinator@demo", evidence: "M-coach-plan-review" } },
    });
    await expect(submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "green", "--evidence", "M-skipped-red",
    ])).rejects.toThrow(/current phase first/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("PLT-128: accepted PLAN evidence survives the same driver's RED handoff", async () => {
  const root=await fixture();
  try {
    await submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "plan", "--evidence", "M-driver-plan",
    ]);
    await respondToHandoff(root, "demo", "delivery", [
      "--by", "coordinator@demo", "--outcome", "accept", "--phase", "red",
      "--plan-review", "M-coach-reviewed-plan",
    ]);
    await submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "red", "--evidence", "M-red-proof",
    ]);
    expect((await task(root)).handoff).toMatchObject({
      submitted_phase:"red", evidence:"M-red-proof",
      plan_review:{by:"coordinator@demo",evidence:"M-coach-reviewed-plan"},
    });
  }finally{await rm(root,{recursive:true,force:true});}
});

test("PLT-128: returned PLAN remains PLAN and does not mint Coach approval", async () => {
  const root = await fixture();
  try {
    await submitHandoff(root, "demo", "delivery", [
      "--by", "driver.delivery@demo", "--phase", "plan", "--evidence", "M-draft-plan",
    ]);
    await respondToHandoff(root, "demo", "delivery", [
      "--by", "coordinator@demo", "--outcome", "return", "--phase", "plan",
    ]);
    expect(await task(root)).toMatchObject({
      phase: "plan", handoff: { state: "executing", evidence: "M-draft-plan" },
    });
    expect((await task(root)).handoff.plan_review).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("PLT-128: new PLAN requires a committed source and acceptance refs, then rejects a stale Coach review", async () => {
  const root = await fixture();
  try {
    const home = join(root,"delivery-repository");
    await mkdir(join(home,"plan"),{recursive:true});
    const git=(...args:string[])=>execFileSync("git",args,{cwd:home,encoding:"utf8"}).trim();
    git("init","-q");
    git("config","user.name","ATDD tester");
    git("config","user.email","tester@example.invalid");
    await writeFile(join(home,"plan","delivery.yaml"),"acceptances:\n  - urn: acc:demo:delivery:success\n");
    git("add",".");git("commit","-qm","ratified plan");
    const revision=git("rev-parse","HEAD");
    const seatFile=join(root,"work","demo","seats","driver.delivery","seat.yaml");
    const seat=Bun.YAML.parse(await readFile(seatFile,"utf8"));
    seat.worktree=home;
    await writeFile(seatFile,Bun.YAML.stringify(seat));
    const taskFile=join(root,"work","demo","tasks","delivery.yaml");
    const active=Bun.YAML.parse(await readFile(taskFile,"utf8"));
    active.phase="plan"; // new tasks enter plan when they start
    await writeFile(taskFile,Bun.YAML.stringify(active));

    await expect(submitHandoff(root,"demo","delivery",[
      "--by","driver.delivery@demo","--phase","plan","--evidence","M-plan",
    ])).rejects.toThrow(/PLAN source/);
    await expect(submitHandoff(root,"demo","delivery",[
      "--by","driver.delivery@demo","--phase","plan","--evidence","M-plan",
      "--plan-source","plan/delivery.yaml","--plan-revision",revision,
    ])).rejects.toThrow(/acceptance references/);
    await submitHandoff(root,"demo","delivery",[
      "--by","driver.delivery@demo","--phase","plan","--evidence","M-plan",
      "--plan-source","plan/delivery.yaml","--plan-revision",revision,
      "--acceptance","acc:demo:delivery:success",
    ]);
    expect((await task(root)).handoff.plan).toEqual({
      source:"plan/delivery.yaml",revision,acceptances:["acc:demo:delivery:success"],
    });
    await writeFile(join(home,"plan","delivery.yaml"),"acceptances:\n  - urn: acc:demo:delivery:changed\n");
    git("add",".");git("commit","-qm","changed plan after handoff");
    await expect(respondToHandoff(root,"demo","delivery",[
      "--by","coordinator@demo","--outcome","accept","--phase","red",
      "--plan-review","M-coach-approval",
    ])).rejects.toThrow(/changed after submission/);
    expect((await task(root)).phase).toBe("plan");
  } finally {await rm(root,{recursive:true,force:true});}
});
