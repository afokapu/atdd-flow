// URN: test:flow:plan-handoff:E043-UNIT-001
// Acceptance: acc:flow:E043-UNIT-001
// Phase: UNIT
// Layer: application
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respondToHandoff, submitHandoff, prove, review, done, nextDirective } from "../src/tasks";

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


/** Only temporary committed artifacts and typed owner messages may authorize a
 * PLAN handoff. Legacy fixture tasks deliberately remain v1 without this gate. */
async function plannedFixture() {
  const root = await fixture();
  // Operator messages reach the real project main seat; do not fake routing.
  const mainDir=join(root,"work","demo","seats","main");
  await mkdir(mainDir,{recursive:true});
  await writeFile(join(mainDir,"seat.yaml"),Bun.YAML.stringify({
    schema:"atdd-workflow/seat/v2",address:"main@demo",role:"main",
    project:"demo",worktree:join(root,"primary"),branch:"main",
  }));
  const worktree = join(root,"worktrees","driver");
  await mkdir(join(worktree,"plan","acceptances"),{recursive:true});
  const git=(...args:string[])=>execFileSync("git",args,{cwd:worktree,encoding:"utf8"}).trim();
  git("init","-q");git("config","user.name","ATDD test");git("config","user.email","atdd@example.invalid");
  const source="plan/acceptances/delivery.yaml",acceptance="acc:flow:E043-UNIT-001";
  await writeFile(join(worktree,source),"urn: "+acceptance+"\nrequirement: Delivery works\n");
  git("add",".");git("commit","-qm","ratified PLAN");
  const revision=git("rev-parse","HEAD");
  const seatFile=join(root,"work","demo","seats","driver.delivery","seat.yaml");
  const driver=Bun.YAML.parse(await readFile(seatFile,"utf8"));
  driver.worktree=worktree;
  await writeFile(seatFile,Bun.YAML.stringify(driver));
  const taskFile=join(root,"work","demo","tasks","delivery.yaml");
  const record=await task(root);
  record.phase="plan";record.plan_required=true;
  await writeFile(taskFile,Bun.YAML.stringify(record));
  const ratification="M-owner-ratification",delegationRef="M-owner-delegation",reviewRef="M-coach-plan-review";
  const thread="T-plan-review",dir=join(root,"threads",thread);
  await mkdir(dir,{recursive:true});
  await writeFile(join(dir,"thread.yaml"),Bun.YAML.stringify({
    schema:"atdd-workflow/thread/v1",id:thread,task:"demo/delivery",
    participants:["operator@desk","main@demo","coordinator@demo","driver.delivery@demo"],
    subject:"Scoped plan decision",state:"open",
  }));
  const authorization={
    schema:"atdd-workflow/plan-ratification/v1",project:"demo",task:"delivery",
    coordinator:"coordinator@demo",assignee:"driver.delivery@demo",
    action:"ratify",source,revision,acceptances:[acceptance],
  };
  const owner=(next=authorization,from="operator@desk")=>writeFile(join(dir,ratification+".yaml"),
    Bun.YAML.stringify({schema:"atdd-workflow/message/v1",id:ratification,from,to:["main@demo"],
      kind:"message",body:"Ratified exact plan.",created_at:"2026-11-22T12:00:00Z",authorization:next}));
  const delegation={
    schema:"atdd-workflow/plan-coach-delegation/v1",project:"demo",task:"delivery",
    coordinator:"coordinator@demo",assignee:"driver.delivery@demo",
    action:"delegate-plan-review",title:"Deliver phase handoff",criteria:["Delivery works"],
  };
  const delegate=(next=delegation,from="operator@desk")=>writeFile(join(dir,delegationRef+".yaml"),
    Bun.YAML.stringify({schema:"atdd-workflow/message/v1",id:delegationRef,from,to:["main@demo"],
      kind:"message",body:"Delegate bounded task review to the Coach.",created_at:"2026-11-22T11:00:00Z",authorization:next}));
  const coach=(body="PLAN APPROVE "+revision+"\nChecked scoped acceptance "+acceptance+" against expected delivery behavior.",from="coordinator@demo",createdAt=new Date().toISOString())=>writeFile(join(dir,reviewRef+".yaml"),
    Bun.YAML.stringify({schema:"atdd-workflow/message/v1",id:reviewRef,from,
      to:["driver.delivery@demo"],kind:"message",body,created_at:createdAt}));
  await owner();
  const submit=["--by","driver.delivery@demo","--phase","plan","--evidence","M-driver-plan",
    "--plan-source",source,"--plan-revision",revision,"--acceptance",acceptance,
    "--operator-ratification",ratification];
  const accept=["--by","coordinator@demo","--outcome","accept","--phase","red","--plan-review",reviewRef];
  return {root,worktree,git,source,revision,acceptance,ratification,delegationRef,delegation,reviewRef,owner,delegate,coach,submit,accept,taskFile};
}

test("ATD-42: a ratified PLAN and Coach review advance the same driver through RED GREEN REFACTOR", async () => {
  const f=await plannedFixture();
  try {
    await submitHandoff(f.root,"demo","delivery",f.submit);
    await f.coach();
    await respondToHandoff(f.root,"demo","delivery",f.accept);
    expect(await task(f.root)).toMatchObject({status:"in_progress",phase:"red",
      handoff:{plan:{source:f.source,revision:f.revision,acceptances:[f.acceptance],ratification:f.ratification},
        plan_review:{by:"coordinator@demo",evidence:f.reviewRef}}});
    for(const [stage,next] of [["red","green"],["green","refactor"],["refactor","refactor"]] as const){
      await submitHandoff(f.root,"demo","delivery",[
        "--by","driver.delivery@demo","--phase",stage,"--evidence","M-"+stage+"-proof",
      ]);
      await respondToHandoff(f.root,"demo","delivery",[
        "--by","coordinator@demo","--outcome","accept","--phase",next,
      ]);
    }
    await prove(f.root,"demo","delivery",["--by","driver.delivery@demo","--item","1","--proof","M-acceptance-proof"]);
    await review(f.root,"demo","delivery",["--by","driver.delivery@demo"]);
    expect(await task(f.root)).toMatchObject({status:"review",phase:"refactor",
      handoff:{plan_review:{by:"coordinator@demo",ratification:f.ratification}}});
    await expect(done(f.root,"demo","delivery",[
      "--by","coordinator@demo",
    ])).rejects.toThrow(/final behavioral review/i);
    expect((await task(f.root)).status).toBe("review");
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: missing plan evidence, wrong scope and skipped phases fail before write", async () => {
  const f=await plannedFixture();
  try {
    const before=await readFile(f.taskFile,"utf8");
    await expect(submitHandoff(f.root,"demo","delivery",[
      "--by","driver.delivery@demo","--phase","red","--evidence","M-skipped",
    ])).rejects.toThrow(/phase skipping/i);
    await expect(submitHandoff(f.root,"demo","delivery",[
      "--by","driver.delivery@demo","--phase","plan","--evidence","M-unplanned",
    ])).rejects.toThrow(/plan-source/i);
    await expect(submitHandoff(f.root,"demo","delivery",[
      ...f.submit.slice(0,-2),"--acceptance","acc:flow:E999-NOT-DECLARED",
      "--operator-ratification",f.ratification,
    ])).rejects.toThrow(/not declared/i);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
    await expect(review(f.root,"demo","delivery",["--by","driver.delivery@demo"])).rejects.toThrow(/requires accepted PLAN/i);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: stale PLAN, forged ratification or unreviewed Coach verdict cannot reach RED", async () => {
  const f=await plannedFixture();
  try {
    await submitHandoff(f.root,"demo","delivery",f.submit);
    const before=await readFile(f.taskFile,"utf8");
    await f.owner(undefined,"driver.delivery@demo");
    await expect(respondToHandoff(f.root,"demo","delivery",f.accept)).rejects.toThrow(/operator-authorized|owner-authorized/i);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
    await f.owner();
    await expect(respondToHandoff(f.root,"demo","delivery",[
      ...f.accept.slice(0,-1),"../escape",
    ])).rejects.toThrow(/canonical M- message reference/);
    await f.coach("Approved but no revision reference.");
    await expect(respondToHandoff(f.root,"demo","delivery",f.accept)).rejects.toThrow(/exact plan revision/i);
    await f.coach("PLAN RETURN "+f.revision+"\nCriteria are incomplete; revise before coding.");
    await expect(respondToHandoff(f.root,"demo","delivery",f.accept)).rejects.toThrow(/exact plan revision/i);
    await f.coach();
    await writeFile(join(f.worktree,"README.md"),"Changed after PLAN submission\n");
    f.git("add",".");f.git("commit","-qm","plan changed");
    await expect(respondToHandoff(f.root,"demo","delivery",f.accept)).rejects.toThrow(/changed after submission/i);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: only operator may post exact ratification authorization in Flow threads", async () => {
  const f=await plannedFixture();
  try {
    const tuple={schema:"atdd-workflow/plan-ratification/v1",project:"demo",task:"delivery",
      coordinator:"coordinator@demo",assignee:"driver.delivery@demo",action:"ratify",
      source:f.source,revision:f.revision,acceptances:[f.acceptance]};
    const fake=await invoke(f.root,"post","T-plan-review","--from","coordinator@demo",
      "--to","driver.delivery@demo","--body","Approve.","--plan-ratification-authorization",JSON.stringify(tuple));
    expect(fake.exitCode).not.toBe(0);
    expect(fake.output).toContain("Only operator@desk");
    const valid=await invoke(f.root,"post","T-plan-review","--from","operator@desk",
      "--to","main@demo","--body","Ratify PLAN.","--plan-ratification-authorization",JSON.stringify(tuple));
    expect(valid.exitCode,valid.output).toBe(0);
    expect(valid.output).toContain("M-");
  }finally{await rm(f.root,{recursive:true,force:true});}
});


test("ATD-42: the tracker can explicitly enter governed PLAN without changing legacy task creation", async () => {
  const root=await fixture();
  try {
    const governed=await invoke(root,"task","add","demo","new-plan",
      "--title","New scoped job","--coordinator","coordinator@demo",
      "--done-when","Acceptance checked","--plan-required");
    expect(governed.exitCode,governed.output).toBe(0);
    const record=Bun.YAML.parse(await readFile(join(root,"work","demo","tasks","new-plan.yaml"),"utf8"));
    expect(record).toMatchObject({status:"todo",phase:"plan",plan_required:true});
    const legacy=await invoke(root,"task","add","demo","legacy-work",
      "--title","Legacy control","--coordinator","coordinator@demo",
      "--done-when","Retirement case");
    expect(legacy.exitCode,legacy.output).toBe(0);
    const old=Bun.YAML.parse(await readFile(join(root,"work","demo","tasks","legacy-work.yaml"),"utf8"));
    expect(old).not.toHaveProperty("plan_required");
    expect(old).not.toHaveProperty("phase");
  }finally{await rm(root,{recursive:true,force:true});}
});

test("ATD-42: PLAN source must itself declare every ratified acceptance, not another file", async () => {
  const f=await plannedFixture();
  try {
    const before=await readFile(f.taskFile,"utf8");
    await writeFile(join(f.worktree,f.source),"urn: acc:flow:E999-UNRELATED\n");
    await writeFile(join(f.worktree,"plan","acceptances","other.yaml"),"urn: "+f.acceptance+"\n");
    f.git("add",".");f.git("commit","-qm","move acceptance outside scoped source");
    const revision=f.git("rev-parse","HEAD");
    const args=[...f.submit];
    args[args.indexOf("--plan-revision")+1]=revision;
    await expect(submitHandoff(f.root,"demo","delivery",args))
      .rejects.toThrow(/not declared in submitted plan source/);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: forged operator approval fails on PLAN submission before a Coach decision", async () => {
  const f=await plannedFixture();
  try {
    const before=await readFile(f.taskFile,"utf8");
    await f.owner(undefined,"driver.delivery@demo");
    await expect(submitHandoff(f.root,"demo","delivery",f.submit))
      .rejects.toThrow(/operator-authorized|owner-authorized/i);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: Coach must cite all plan acceptances and return actionable guidance", async () => {
  const f=await plannedFixture();
  try {
    await submitHandoff(f.root,"demo","delivery",f.submit);
    await f.coach("PLAN APPROVE "+f.revision+"\nReviewed a feature but supplied no acceptance identifiers.");
    await expect(respondToHandoff(f.root,"demo","delivery",f.accept))
      .rejects.toThrow(/exact plan revision/i);
    await expect(respondToHandoff(f.root,"demo","delivery",[
      "--by","coordinator@demo","--outcome","return","--phase","plan",
    ])).rejects.toThrow(/return reason/);
    await respondToHandoff(f.root,"demo","delivery",[
      "--by","coordinator@demo","--outcome","return","--phase","plan",
      "--reason","Acceptance coverage is unverified; revise the scoped plan and resubmit.",
    ]);
    expect(await task(f.root)).toMatchObject({status:"in_progress",phase:"plan",
      handoff:{state:"executing",return_reason:"Acceptance coverage is unverified; revise the scoped plan and resubmit."}});
    const next=await nextDirective(f.root,"driver.delivery@demo");
    expect(next?.action).toContain("Acceptance coverage is unverified");
    expect(next?.command).toContain("--plan-source");
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: pre-authorized task scope lets accountable Coach accept without a per-plan owner prompt", async () => {
  const f=await plannedFixture();
  try {
    await f.delegate(); // Owner delegates only this task/title/criteria once, before PLAN.
    const args=[...f.submit.slice(0,-2),"--coach-delegation",f.delegationRef];
    await submitHandoff(f.root,"demo","delivery",args);
    await f.coach();
    await respondToHandoff(f.root,"demo","delivery",f.accept);
    expect(await task(f.root)).toMatchObject({
      phase:"red",handoff:{
        plan:{delegation:f.delegationRef,acceptances:[f.acceptance]},
        plan_review:{by:"coordinator@demo",ratification:f.delegationRef},
      },
    });
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: delegated Coach authority cannot expand title/criteria or forge owner identity", async () => {
  const f=await plannedFixture();
  try {
    const args=[...f.submit.slice(0,-2),"--coach-delegation",f.delegationRef];
    const before=await readFile(f.taskFile,"utf8");
    await f.delegate({...f.delegation,criteria:["A new unapproved product scope"]});
    await expect(submitHandoff(f.root,"demo","delivery",args)).rejects.toThrow(/exact operator@desk approval/);
    await f.delegate(undefined,"coordinator@demo");
    await expect(submitHandoff(f.root,"demo","delivery",args)).rejects.toThrow(/operator-authorized|owner-authorized/i);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: only operator may create a typed bounded PLAN delegation", async () => {
  const f=await plannedFixture();
  try {
    const invalid=await invoke(f.root,"post","T-plan-review","--from","coordinator@demo",
      "--to","driver.delivery@demo","--body","Attempt delegation",
      "--plan-coach-delegation-authorization",JSON.stringify(f.delegation));
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.output).toContain("Only operator@desk");
    const valid=await invoke(f.root,"post","T-plan-review","--from","operator@desk",
      "--to","main@demo","--body","Approve fixed scope delegation",
      "--plan-coach-delegation-authorization",JSON.stringify(f.delegation));
    expect(valid.exitCode,valid.output).toBe(0);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: external To Do intake maps automatically to governed PLAN; display status cannot advance phases", async () => {
  const root=await fixture();
  try {
    const tracked=await invoke(root,"task","add","demo","tracked-new",
      "--title","External delivery","--coordinator","coordinator@demo",
      "--done-when","Visible acceptance","--source","linear:ATD-42",
      "--tracking-status","To Do");
    expect(tracked.exitCode,tracked.output).toBe(0);
    const first=Bun.YAML.parse(await readFile(join(root,"work","demo","tasks","tracked-new.yaml"),"utf8"));
    expect(first).toMatchObject({status:"todo",phase:"plan",plan_required:true,source:"linear:ATD-42"});
    const bypass=await invoke(root,"task","add","demo","tracked-done",
      "--title","Unapproved external Done","--coordinator","coordinator@demo",
      "--done-when","Evidence exists","--tracking-status","Done");
    expect(bypass.exitCode).not.toBe(0);
    expect(bypass.output).toContain("cannot bypass Flow PLAN");
  }finally{await rm(root,{recursive:true,force:true});}
});

test("ATD-42: a review issued before the actual PLAN submission cannot advance RED", async () => {
  const f=await plannedFixture();
  try {
    await f.coach(undefined,"coordinator@demo","2025-01-01T00:00:00Z");
    await submitHandoff(f.root,"demo","delivery",f.submit);
    const before=await readFile(f.taskFile,"utf8");
    await expect(respondToHandoff(f.root,"demo","delivery",f.accept))
      .rejects.toThrow(/task-linked message/);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
    await f.coach();
    await respondToHandoff(f.root,"demo","delivery",f.accept);
    expect((await task(f.root)).phase).toBe("red");
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: dirty scoped plan source is refused before and after PLAN submission", async () => {
  const f=await plannedFixture();
  try {
    const before=await readFile(f.taskFile,"utf8");
    await writeFile(join(f.worktree,f.source),"urn: "+f.acceptance+"\nmodified: true\n");
    await expect(submitHandoff(f.root,"demo","delivery",f.submit))
      .rejects.toThrow(/uncommitted changes/);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
    f.git("checkout","--",f.source);
    await submitHandoff(f.root,"demo","delivery",f.submit);
    await f.coach();
    await writeFile(join(f.worktree,f.source),"urn: "+f.acceptance+"\nmodified: again\n");
    await expect(respondToHandoff(f.root,"demo","delivery",f.accept))
      .rejects.toThrow(/uncommitted changes after submission/);
    expect((await task(f.root)).phase).toBe("plan");
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: acceptance prefix matches are not valid declared identities", async () => {
  const f=await plannedFixture();
  try {
    const args=[...f.submit];
    args[args.indexOf("--acceptance")+1]="acc:flow:E043-UNIT-00";
    const before=await readFile(f.taskFile,"utf8");
    await expect(submitHandoff(f.root,"demo","delivery",args))
      .rejects.toThrow(/not declared in submitted plan source/);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: a moved driver worktree cannot accept a prior PLAN handoff", async () => {
  const f=await plannedFixture();
  try {
    await submitHandoff(f.root,"demo","delivery",f.submit);
    await f.coach();
    const before=await readFile(f.taskFile,"utf8");
    const seatFile=join(f.root,"work","demo","seats","driver.delivery","seat.yaml");
    const driver=Bun.YAML.parse(await readFile(seatFile,"utf8"));
    const different=join(f.root,"worktrees","substitute");
    await mkdir(different,{recursive:true});
    driver.worktree=different;
    await writeFile(seatFile,Bun.YAML.stringify(driver));
    await expect(respondToHandoff(f.root,"demo","delivery",f.accept))
      .rejects.toThrow(/worktree changed after handoff/);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: corrupted task phase cannot turn a submitted PLAN into an accepted later phase", async () => {
  const f=await plannedFixture();
  try {
    await submitHandoff(f.root,"demo","delivery",f.submit);
    await f.coach();
    const tampered=await task(f.root);
    tampered.phase="green";
    await writeFile(f.taskFile,Bun.YAML.stringify(tampered));
    const before=await readFile(f.taskFile,"utf8");
    await expect(respondToHandoff(f.root,"demo","delivery",f.accept))
      .rejects.toThrow(/handoff phase does not match/);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: Coach approval must be routed to the assigned driver, not an unrelated thread recipient", async () => {
  const f=await plannedFixture();
  try {
    await submitHandoff(f.root,"demo","delivery",f.submit);
    await f.coach();
    const file=join(f.root,"threads","T-plan-review",f.reviewRef+".yaml");
    const message=Bun.YAML.parse(await readFile(file,"utf8"));
    message.to=["main@demo"];
    await writeFile(file,Bun.YAML.stringify(message));
    const before=await readFile(f.taskFile,"utf8");
    await expect(respondToHandoff(f.root,"demo","delivery",f.accept))
      .rejects.toThrow(/task-linked message/);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test("ATD-42: rejected PLAN evidence reaches the accountable Coach as an actionable thread blocker", async () => {
  const f=await plannedFixture();
  try {
    const before=await readFile(f.taskFile,"utf8");
    await expect(submitHandoff(f.root,"demo","delivery",[
      "--by","driver.delivery@demo","--phase","plan","--evidence","M-plan-rejected",
    ])).rejects.toThrow(/plan-source/);
    expect(await readFile(f.taskFile,"utf8")).toBe(before);
    const dir=join(f.root,"threads","T-plan-review");
    const entries=await readdir(dir);
    const posts=await Promise.all(entries.filter(name=>name.startsWith("M-")&&name.endsWith(".yaml"))
      .map(async name=>Bun.YAML.parse(await readFile(join(dir,name),"utf8"))));
    const blockers=posts.filter(message=>message.from==="driver.delivery@demo" &&
      message.to?.includes("coordinator@demo") &&
      message.body?.includes("PLAN BLOCKED demo/delivery"));
    expect(blockers.length).toBe(1);
    expect(blockers[0]?.body).toContain("Next action");
  }finally{await rm(f.root,{recursive:true,force:true});}
});
