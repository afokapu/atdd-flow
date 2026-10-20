// URN: test:flow:exact-adoption-resumed-proof-and-relaunch
// Acceptance: acc:flow:E006-RED-001
// Phase: E2E
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml } from "../src/core";
import { handoverReplacementPath, requestHandoverReplacement, type HandoverReplacementRequest } from "../src/handover";
import { clearRuntimeState, registerRuntimeState } from "../src/runtime-state";
import { launchPiRuntime } from "../src/seats";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const project = "frg-workstation", address = `main@${project}`;
const pane = "w6:p6", herdrSession = "forge", cwd = "/Users/alecfokapu/Github/frg-workstation";
const canonicalSession = "ed0280b7-ab1e-4f93-918a-ab9f6794413c";
const canonicalPath = "/Users/alecfokapu/.pi/agent/sessions/--Users-alecfokapu-Github-frg-workstation--/2026-10-19T08-22-48-930Z_ed0280b7-ab1e-4f93-918a-ab9f6794413c.jsonl";
const adoptedSession = "01a15391-2a48-7467-aedd-a13f993202d6";
const freshSession = "02b264a2-3b59-4578-beee-b24fa0431137";
const priorTask = "main-successor-20261019", takeoverTask = "main-sso-successor-20261019";
const consumedHandover = "H-20261019T073912Z-main-frg-workstation-successor";
const currentHandover = "H-20261019T143641Z-main-frg-workstation-successor";
const authorizationId = "A-frg-main-sso-repeat-20261019";
const exactFailedReceiptSuffix = "3faae05e";
const roots: string[] = [];

const selectEconomy = async () => ({ available: true as const, model: "test", selected_model: "economy", confidence: 0.99 });

async function invokeAtRoot(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, ATDD_WORKFLOW_ROOT: root },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

type RuntimeHarness = {
  calls: string[][];
  command: (command: string[]) => Promise<string>;
  release: () => void;
  runningPath: () => string | undefined;
};

function runtimeHarness(root: string, initiallyLive: string): RuntimeHarness {
  const calls: string[][] = [];
  let writerPath: string | undefined = initiallyLive;
  const agentName = "flow-main-frg-workstation";
  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const paneRecord = () => writerPath
    ? { pane_id: pane, agent: "pi", agent_status: "idle", agent_session: session(writerPath), cwd, label: address }
    : { pane_id: pane, agent: null, agent_status: "unknown", agent_session: null, cwd, label: address };

  return {
    calls,
    release: () => { writerPath = undefined; },
    runningPath: () => writerPath,
    command: async (command: string[]) => {
      calls.push(command);
      const operation = command.slice(3);
      if (operation[0] === "workspace" && operation[1] === "list") return JSON.stringify({ result: { workspaces: [
        { workspace_id: "w6", label: project, worktree: { checkout_path: cwd } },
      ] } });
      if (operation[0] === "tab" && operation[1] === "list") return JSON.stringify({ result: { tabs: [
        { tab_id: "w6:t1", workspace_id: "w6", label: address },
      ] } });
      if (operation[0] === "pane" && operation[1] === "list") return JSON.stringify({ result: { panes: [
        { pane_id: pane, tab_id: "w6:t1", label: address, agent: writerPath ? "pi" : null, agent_status: writerPath ? "idle" : "unknown" },
      ] } });
      if (operation[0] === "pane" && operation[1] === "get") return JSON.stringify({ result: { pane: paneRecord() } });
      if (operation[0] === "pane" && operation[1] === "process-info") return JSON.stringify({ result: { process_info: {
        pane_id: pane, shell_pid: 42,
        foreground_processes: writerPath
          ? [{ name: "node", argv0: "pi", pid: 100, cwd }]
          : [{ name: "zsh", argv0: "zsh", pid: 42, cwd }],
      } } });
      if (operation[0] === "agent" && operation[1] === "get") return JSON.stringify({ result: { agent: {
        name: agentName, agent: "pi", pane_id: pane, agent_status: "idle",
        agent_session: session(writerPath!), cwd,
      } } });
      if (operation[0] === "agent" && operation[1] === "list") return JSON.stringify({ result: { agents: writerPath ? [
        { name: agentName, agent: "pi", pane_id: pane, agent_status: "idle", agent_session: session(writerPath), cwd },
      ] : [] } });
      if (operation[0] === "pane" && operation[1] === "run") return JSON.stringify({ result: { pane_id: pane } });
      if (operation[0] === "agent" && operation[1] === "start") {
        const piArgs = operation.slice(operation.indexOf("--") + 1);
        const continued = piArgs.indexOf("--session"), minted = piArgs.indexOf("--session-id");
        writerPath = continued >= 0 ? piArgs[continued + 1] : join(root, `fresh_${piArgs[minted + 1]}.jsonl`);
        return JSON.stringify({ result: { name: agentName } });
      }
      throw new Error(`Unexpected Herdr command: ${command.join(" ")}`);
    },
  };
}

async function publishedFixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-exact-adoption-relaunch-"));
  roots.push(root);
  const bin = join(root, "bin"), pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, {
    schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi },
  });
  await atomicYaml(paths(root).models, {
    schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }],
  });
  await atomicYaml(paths(root).projectFile(project), {
    schema: "atdd-workflow/project/v1", project, repository: cwd, roles: {},
  });

  const livePath = join(root, `live_${adoptedSession}.jsonl`);
  await writeFile(livePath, '{"type":"session"}\n');
  const prior: HandoverReplacementRequest = {
    schema: "atdd-flow/context-handover-replacement-request/v1", seat: address, task: priorTask,
    handover: { id: consumedHandover, sha256: "1".repeat(64) },
    authorization: { id: "A-prior", hash: "2".repeat(64) },
    source: {
      pi_session: "01a1531e-966a-744e-b902-dea5900e53a8",
      pi_session_path: join(root, "prior_01a1531e-966a-744e-b902-dea5900e53a8.jsonl"),
      herdr_session: herdrSession, pane,
    },
    target: { herdr_session: herdrSession, pane, cwd },
    legacy_source: {
      authorization_hash: "2".repeat(64), pi_session: "01a1531e-966a-744e-b902-dea5900e53a8",
      pi_session_path: join(root, "prior_01a1531e-966a-744e-b902-dea5900e53a8.jsonl"),
      herdr_session: herdrSession, pane, cwd, agent: "flow-main-frg-workstation",
      verified_at: "2026-10-19T08:22:10.722Z",
    },
    created_at: "2026-10-19T08:22:10.722Z",
  };
  const active = handoverReplacementPath(root, address);
  await atomicYaml(active, prior);
  const canonicalReceipt = join(root, ".atdd-flow", "runtime-launch", `${canonicalSession}-receipt.yaml`);
  await atomicYaml(canonicalReceipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, tasks: [priorTask], candidate: "economy",
    pi_session: canonicalSession, pi_session_path: canonicalPath, herdr_session: herdrSession, pane,
    handover_replacement: { request: prior, successor_session: canonicalSession },
    created_at: "2026-10-19T08:22:51.906Z",
  });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project, worktree: cwd, branch: "main",
    runtime: {
      application: "herdr", addresses: { herdr: { session: herdrSession, pane } }, wake: "native",
      pi_session: canonicalSession, pi_session_path: canonicalPath, launch_receipt: canonicalReceipt,
    },
  });
  await atomicYaml(paths(root).handoverFile(address), {
    schema: "atdd-workflow/handover/v1", seat: address, handover_id: currentHandover,
    supersedes: consumedHandover, recorded_at: "2026-10-19T14:37:16.062Z", text: "exact handover",
  });
  await atomicYaml(paths(root).taskFile(project, priorTask), {
    schema: "atdd-workflow/task/v1", title: "Prior takeover", status: "done", coordinator: address,
    assignee: address, done_when: [{ text: "Prior successor resumed.", proof: canonicalReceipt }],
  });
  await atomicYaml(paths(root).taskFile(project, takeoverTask), {
    schema: "atdd-workflow/task/v1", title: "Next takeover", status: "todo", coordinator: address,
    assignee: address, done_when: [{ text: "Next successor resumes." }],
  });
  await createExactSessionAdoptionAuthorization(root, authorizationId, [
    "--by", "operator@desk", "--seat", address, "--pi-session", adoptedSession, "--pi-session-path", livePath,
    "--source-herdr-session", herdrSession, "--source-pane", pane,
    "--target-herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", cwd,
  ]);

  const runtime = runtimeHarness(root, livePath);
  await requestHandoverReplacement(root, address, [
    "--supersede-consumed", "--handover", currentHandover, "--authorization", authorizationId,
    "--takeover-task", takeoverTask, "--source-pi-session", adoptedSession,
    "--source-pi-session-path", livePath, "--source-herdr-session", herdrSession, "--source-pane", pane,
    "--herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", cwd,
  ], { command: runtime.command, at: () => "2026-10-20T03:30:00.000Z" });
  const request = await readYaml<HandoverReplacementRequest>(active);
  const archive = request.supersession!.prior_request.archive;
  return { root, livePath, active, archive, canonicalReceipt, runtime, request };
}

async function adopt(value: Awaited<ReturnType<typeof publishedFixture>>) {
  value.runtime.release();
  const launched = await launchPiRuntime(value.root, address, [
    "--pane", pane, "--herdr-session", herdrSession, "--adopt-session", value.livePath,
    "--source-herdr-session", herdrSession, "--source-pane", pane, "--authorization", authorizationId,
  ], { command: value.runtime.command, select: selectEconomy, at: () => "2026-10-20T03:33:00.000Z" });

  // Recreate the immutable receipt reference from the reported released state.
  const exactReceipt = join(value.root, ".atdd-flow", "runtime-launch", `${adoptedSession}-${exactFailedReceiptSuffix}.yaml`);
  await rename(launched.receipt, exactReceipt);
  const record = await readYaml<Record<string, any>>(paths(value.root).seatFile(address));
  await atomicYaml(paths(value.root).seatFile(address), {
    ...record, runtime: { ...record.runtime, launch_receipt: exactReceipt },
  });
  return exactReceipt;
}

async function heartbeat(root: string, session: string) {
  return registerRuntimeState(root, {
    seat: address, owner_token: `owner-${session}`, pid: 84314, model: "economy", cwd,
  }, "2026-10-20T03:34:00.000Z");
}

async function launchNormally(value: Awaited<ReturnType<typeof publishedFixture>>, dryRun = false) {
  return launchPiRuntime(value.root, address, [
    "--pane", pane, "--herdr-session", herdrSession, ...(dryRun ? ["--dry-run"] : []),
  ], { command: value.runtime.command, select: selectEconomy, sessionId: () => freshSession, at: () => "2026-10-20T03:36:00.000Z" });
}

async function updateTakeoverTask(root: string, change: Record<string, unknown>) {
  const file = paths(root).taskFile(project, takeoverTask);
  const task = await readYaml<Record<string, unknown>>(file);
  await atomicYaml(file, { ...task, ...change });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("exact adoption publishes, releases the source, preserves its identity, and reconciles RESUMED 6/6 from exact relocation proof", async () => {
  const value = await publishedFixture();
  const activeBefore = await readFile(value.active, "utf8");
  const failedReceipt = await adopt(value);
  await heartbeat(value.root, adoptedSession);

  const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(address));
  const receipt = await readYaml<Record<string, any>>(failedReceipt);
  const backup = receipt.relocation.backup as string;
  expect(seat.runtime).toMatchObject({
    pi_session: adoptedSession, pi_session_path: value.livePath, launch_receipt: failedReceipt,
  });
  expect(receipt).toMatchObject({
    seat: address, tasks: [takeoverTask], pi_session: adoptedSession, pi_session_path: value.livePath,
    handover_replacement: { request: value.request, successor_session: adoptedSession },
    relocation: {
      source_herdr_session: herdrSession, source_pane: pane,
      authorization: { id: authorizationId },
      backup_sha256: createHash("sha256").update(await readFile(value.livePath)).digest("hex"),
    },
  });
  expect(await readFile(backup, "utf8")).toBe(await readFile(value.livePath, "utf8"));
  expect(await readFile(value.active, "utf8")).toBe(activeBefore);

  const resumed = await invokeAtRoot(value.root, "handover", "resumed", address);
  if (resumed.exitCode !== 0) {
    expect(resumed.output).toContain("RESUMED; verified 5/6; discrepancies: fresh Pi session/JSONL path.");
  }
  expect(resumed.exitCode).toBe(0);
  expect(resumed.output).toContain("RESUMED; verified 6/6; discrepancies: none.");
  expect((await readYaml<Record<string, unknown>>(paths(value.root).taskFile(project, takeoverTask))).status).toBe("todo");

});

test("the exact exited 5-of-6 adoption state permits one normal fresh launch, receipt, RESUMED 6/6, and unchanged TODO eligibility", async () => {
  const value = await publishedFixture();
  const activeBefore = await readFile(value.active, "utf8");
  const failedReceipt = await adopt(value);
  value.runtime.release();
  await clearRuntimeState(value.root, address, `owner-${adoptedSession}`);

  let launched: Awaited<ReturnType<typeof launchNormally>> | undefined;
  let launchError: Error | undefined;
  try { launched = await launchNormally(value); }
  catch (error) { launchError = error as Error; }

  let resumed = { exitCode: -1, output: "normal launch did not complete" };
  if (launched) {
    await heartbeat(value.root, freshSession);
    resumed = await invokeAtRoot(value.root, "handover", "resumed", address);
  }

  if (launchError) {
    expect(launchError.message).toBe("Path-A replacement source tuple no longer matches the recorded runtime or ready main takeover task.");
  }
  expect(launchError).toBeUndefined();
  expect(launched).toMatchObject({ piSession: freshSession, pane, herdrSession });
  const freshReceipt = await readYaml<Record<string, any>>(launched!.receipt);
  expect(freshReceipt).toMatchObject({
    seat: address, tasks: [takeoverTask], pi_session: freshSession,
    handover_replacement: { request: value.request, successor_session: freshSession },
  });
  expect(freshReceipt.relocation).toBeUndefined();
  expect(basename(failedReceipt)).toBe(`${adoptedSession}-${exactFailedReceiptSuffix}.yaml`);
  expect(await readFile(value.active, "utf8")).toBe(activeBefore);
  expect(resumed).toMatchObject({ exitCode: 0 });
  expect(resumed.output).toContain("RESUMED; verified 6/6; discrepancies: none.");
  expect((await readYaml<Record<string, unknown>>(paths(value.root).taskFile(project, takeoverTask))).status).toBe("todo");
});

test("the exact exited adoption state permits normal relaunch and RESUMED 6/6 for only the evidence-empty IN_PROGRESS takeover", async () => {
  const value = await publishedFixture();
  const activeBefore = await readFile(value.active, "utf8");
  const failedReceipt = await adopt(value);
  value.runtime.release();
  await clearRuntimeState(value.root, address, `owner-${adoptedSession}`);
  await updateTakeoverTask(value.root, { status: "in_progress" });

  const launched = await launchNormally(value);
  await heartbeat(value.root, freshSession);
  const resumed = await invokeAtRoot(value.root, "handover", "resumed", address);

  expect(launched).toMatchObject({ piSession: freshSession, pane, herdrSession });
  expect(await readYaml<Record<string, unknown>>(launched.receipt)).toMatchObject({
    seat: address, tasks: [takeoverTask], pi_session: freshSession,
    handover_replacement: { request: value.request, successor_session: freshSession },
  });
  expect(basename(failedReceipt)).toBe(`${adoptedSession}-${exactFailedReceiptSuffix}.yaml`);
  expect(await readFile(value.active, "utf8")).toBe(activeBefore);
  expect(resumed).toMatchObject({ exitCode: 0 });
  expect(resumed.output).toContain("RESUMED; verified 6/6; discrepancies: none.");
  expect((await readYaml<Record<string, unknown>>(paths(value.root).taskFile(project, takeoverTask))).status).toBe("in_progress");
});

test("ordinary non-adoption reconciliation keeps fresh-session inequality and cannot borrow adoption status", async () => {
  const value = await publishedFixture();
  const failedReceipt = await adopt(value);
  await heartbeat(value.root, adoptedSession);
  const receipt = await readYaml<Record<string, any>>(failedReceipt);
  delete receipt.relocation;
  await atomicYaml(failedReceipt, receipt);

  const resumed = await invokeAtRoot(value.root, "handover", "resumed", address);
  expect(resumed.exitCode).toBe(1);
  expect(resumed.output).toContain("RESUMED; verified 5/6; discrepancies: fresh Pi session/JSONL path.");
});

test("failed-adoption relaunch refuses mismatched evidence and any non-empty or unrelated IN_PROGRESS lifecycle", async () => {
  const cases: Array<[string, (value: Awaited<ReturnType<typeof publishedFixture>>, receipt: string) => Promise<void>]> = [
    ["request mismatch", async (_value, receipt) => {
      const record = await readYaml<Record<string, any>>(receipt);
      record.handover_replacement.request = { ...record.handover_replacement.request, task: "substituted-task" };
      await atomicYaml(receipt, record);
    }],
    ["duplicate adoption receipt", async (value, receipt) => {
      await copyFile(receipt, join(value.root, ".atdd-flow", "runtime-launch", `${adoptedSession}-duplicate.yaml`));
    }],
    ["damaged immutable archive", async (value) => {
      await rm(join(value.archive, "request.yaml"));
    }],
    ["unrelated in-progress task", async (value) => {
      await updateTakeoverTask(value.root, { status: "done" });
      await atomicYaml(paths(value.root).taskFile(project, "unrelated-takeover"), {
        schema: "atdd-workflow/task/v1", title: "Unrelated takeover", status: "in_progress",
        coordinator: address, assignee: address, done_when: [{ text: "Unrelated successor resumes." }],
      });
    }],
    ["proven in-progress takeover", async (value) => {
      await updateTakeoverTask(value.root, {
        status: "in_progress", done_when: [{ text: "Next successor resumes.", proof: "SSO result" }],
      });
    }],
    ["blocked in-progress takeover", async (value) => {
      await updateTakeoverTask(value.root, { status: "in_progress", blocker: "awaiting authority" });
    }],
    ["handoff-bearing in-progress takeover", async (value) => {
      await updateTakeoverTask(value.root, {
        status: "in_progress", handoff: { state: "executing", evidence: "M-handoff", updated_at: "2026-10-20T03:35:00.000Z" },
      });
    }],
    ["review takeover", async (value) => {
      await updateTakeoverTask(value.root, { status: "review" });
    }],
  ];

  for (const [label, arrange] of cases) {
    const value = await publishedFixture();
    const receipt = await adopt(value);
    value.runtime.release();
    await arrange(value, receipt);
    const before = value.runtime.calls.length;
    await expect(launchNormally(value, true), label).rejects.toThrow();
    expect(value.runtime.calls.length, `${label} must refuse before Herdr observation`).toBe(before);
  }
});
