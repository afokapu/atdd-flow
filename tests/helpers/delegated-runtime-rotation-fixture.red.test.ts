// URN: test:atdd-flow:delegated-seat-runtime-rotation:E007-RED-001-fixture
// Acceptance: acc:flow:E007-RED-001
// Phase: RED
// Layer: integration
// Runtime: bun
// Structural RED marker; imported behavioral cases are the causal oracle: expect.fail("delegated rotation is not implemented")
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, exists, paths, readYaml } from "../../src/core";
import { handoverReplacementPath } from "../../src/handover";
import { clearRuntimeState, heartbeatRuntimeState, registerRuntimeState, runtimeStatePath } from "../../src/runtime-state";

const roots: string[] = [];
const sourceSession = "01a15391-2a48-7467-aedd-a13f993202d6";
const successorSession = "01a15391-2a48-7467-aedd-a13f993202d7";
const sourcePath = `/sessions/2026-10-20T10-00-00-000Z_${sourceSession}.jsonl`;
const successorPath = `/sessions/2026-10-20T14-00-00-000Z_${successorSession}.jsonl`;
const sourceOwner = "source-owner";
const successorOwner = "successor-owner";
const at = "2026-10-20T14:00:00.000Z";

type FixtureOptions = {
  caller?: string;
  target?: string;
  targetRole?: "driver" | "coordinator" | "main";
  taskCoordinator?: string;
  taskStatus?: "todo" | "in_progress" | "review" | "done";
  blocker?: string;
  handoff?: { state: string; evidence: string; updated_at: string };
  secondEligibleTask?: boolean;
  retired?: boolean;
};

type RotationModule = {
  rotatePiRuntime: (root: string, address: string, args: string[], dependencies?: Record<string, unknown>) => Promise<Record<string, any>>;
};

/** Production is intentionally absent in RED; importing here keeps fixture construction executable and the failure focused. */
async function runtimeRotation(): Promise<RotationModule> {
  const modulePath = "../../src/runtime-rotation";
  return await import(modulePath) as RotationModule;
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-delegated-rotation-"));
  roots.push(root);
  const bin = join(root, "bin"), pi = join(bin, "pi");
  await mkdir(bin, { recursive: true });
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);

  const targetRole = options.targetRole ?? "driver";
  const target = options.target ?? (targetRole === "main" ? "main@demo" : targetRole === "coordinator" ? "coordinator.payments@demo" : "driver.rotate@demo");
  const caller = options.caller ?? (targetRole === "main" ? "main@demo" : "main@demo");
  const primary = "/work/primary";
  const targetWorktree = targetRole === "main" ? primary : targetRole === "coordinator" ? "/work/payments" : "/work/rotate";
  const targetBranch = targetRole === "main" ? "main" : targetRole === "coordinator" ? "integration/payments" : "delivery/rotate";
  const taskCoordinator = options.taskCoordinator ?? (targetRole === "main" ? target : targetRole === "coordinator" ? target : caller);

  await atomicYaml(paths(root).desk, {
    schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", herdr_session: "forge", executables: { pi },
  });
  await atomicYaml(paths(root).models, {
    schema: "atdd-workflow/models/v1",
    models: [{ id: "strong", executable: "pi", args: ["--model", "strong"] }, { id: "economy", executable: "pi", args: ["--model", "economy"] }],
  });
  await atomicYaml(paths(root).projectFile("demo"), {
    schema: "atdd-workflow/project/v1", project: "demo", repository: primary, worktree_root: "/work",
    roles: {
      main: { address: "main@{project}", branch: "main", worktree: "{repository}" },
      coordinator: { address: "coordinator.{name}@{project}", branch: "integration/{name}", worktree: "{worktree_root}/{name}" },
      driver: { address: "driver.{name}@{project}", branch: "delivery/{name}", worktree: "{worktree_root}/{name}" },
    },
  });

  const seats = [
    { address: "main@demo", role: "main", project: "demo", worktree: primary, branch: "main" },
    { address: "coordinator.payments@demo", role: "coordinator", project: "demo", worktree: "/work/payments", branch: "integration/payments" },
    { address: "coordinator@demo", role: "coordinator", project: "demo", worktree: primary, branch: "main" },
    { address: "driver.rotate@demo", role: "driver", project: "demo", worktree: "/work/rotate", branch: "delivery/rotate" },
  ];
  if (!seats.some((entry) => entry.address === target)) seats.push({ address: target, role: targetRole, project: "demo", worktree: targetWorktree, branch: targetBranch });
  if (!seats.some((entry) => entry.address === caller) && caller !== "operator@desk") {
    const project = caller.split("@").at(-1)!;
    await atomicYaml(paths(root).projectFile(project), { schema: "atdd-workflow/project/v1", project, repository: `/work/${project}`, roles: {} });
    seats.push({ address: caller, role: "main", project, worktree: `/work/${project}`, branch: "main" });
  }
  for (const seat of seats) {
    await atomicYaml(paths(root).seatFile(seat.address), {
      schema: "atdd-workflow/seat/v2", ...seat,
      ...(seat.address === target && options.retired ? { retired: { task: "demo/old", completed_at: at, summary: "retired" } } : {}),
    });
  }
  if (caller === "operator@desk") {
    await atomicYaml(paths(root).projectFile("desk"), { schema: "atdd-workflow/project/v1", project: "desk", repository: "/work/desk", roles: {} });
    await atomicYaml(paths(root).seatFile("operator@desk"), { schema: "atdd-workflow/seat/v2", address: "operator@desk", role: "operator", project: "desk", worktree: "/work/desk", branch: "main" });
  }

  const receipt = join(root, ".atdd-flow", "runtime-launch", "source.yaml");
  await atomicYaml(receipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: target, tasks: ["rotate"], candidate: "economy",
    pi_session: sourceSession, pi_session_path: sourcePath, herdr_session: "forge", pane: "w1:p2", created_at: "2026-10-20T10:00:00.000Z",
  });
  const targetSeat = await readYaml<Record<string, any>>(paths(root).seatFile(target));
  targetSeat.runtime = {
    application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, wake: "native", model: "economy",
    pi_session: sourceSession, pi_session_path: sourcePath, launch_receipt: receipt,
  };
  await atomicYaml(paths(root).seatFile(target), targetSeat);

  await atomicYaml(paths(root).taskFile("demo", "rotate"), {
    schema: "atdd-workflow/task/v1", title: "Continue bounded work after rotation", status: options.taskStatus ?? "in_progress",
    coordinator: taskCoordinator, assignee: target,
    ...(options.blocker ? { blocker: options.blocker } : {}),
    ...(options.handoff ? { phase: "red", handoff: options.handoff } : {}),
    done_when: [{ text: "The exact work continues under one successor." }],
  });
  if (options.secondEligibleTask) {
    await atomicYaml(paths(root).taskFile("demo", "also-ready"), {
      schema: "atdd-workflow/task/v1", title: "Ambiguous second task", status: "todo", coordinator: taskCoordinator, assignee: target,
      done_when: [{ text: "Ambiguity is rejected." }],
    });
  }

  const handoverText = [
    `HANDOVER ${target} | 2026-10-20T13:59:00Z | handover-id H-rotate-1 | supersedes none`,
    "Runtime: pi | source | model openai/gpt | context 80%",
    "1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS",
    `- Continue task demo/rotate under ${target}.`,
    "2. OPEN WORK AND IN-FLIGHT OPERATIONS",
    "- No process mutation is in flight.",
    "3. DEPENDENCIES",
    "- Exact request, source and target tuples are required.",
    "4. RESUME PROCEDURE AND NEXT ACTIONS",
    "- Reconcile the Desk and report RESUMED.",
  ].join("\n");
  await atomicYaml(paths(root).handoverFile(target), {
    schema: "atdd-workflow/handover/v1", seat: target, handover_id: "H-rotate-1", supersedes: "none", recorded_at: at, text: handoverText,
  });

  await registerRuntimeState(root, { seat: target, owner_token: sourceOwner, pid: 101, model: "economy", cwd: targetWorktree }, "2026-10-20T13:59:30.000Z");
  if (caller !== target) await registerRuntimeState(root, { seat: caller, owner_token: `caller-${caller}`, pid: 102, model: "strong", cwd: seats.find((entry) => entry.address === caller)?.worktree ?? "/work/desk" }, at);

  return { root, caller, target, targetRole, targetWorktree, receipt };
}

function args(value: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, string | undefined> = {}) {
  const fields: Record<string, string | undefined> = {
    "--by": value.caller, "--task": "rotate", "--handover": "H-rotate-1",
    "--source-pi-session": sourceSession, "--source-pi-session-path": sourcePath,
    "--source-herdr-session": "forge", "--source-pane": "w1:p2",
    "--target-herdr-session": "forge", "--target-pane": "w1:p2", "--target-cwd": value.targetWorktree,
    "--model": "economy", "--timeout-ms": "250", ...overrides,
  };
  return Object.entries(fields).flatMap(([flag, field]) => field === undefined ? [] : [flag, field]);
}

function fakeHerdr(value: Awaited<ReturnType<typeof fixture>>, options: { releaseOnPause?: boolean; startGate?: Promise<void> } = {}) {
  const calls: string[][] = [];
  let released = false, started = false, starts = 0, ticks = 0;
  const agent = `flow-${value.target.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`.slice(0, 32);
  const pane = () => started
    ? { pane_id: "w1:p2", cwd: value.targetWorktree, agent, agent_status: "idle", agent_session: { source: "pi", agent, kind: "path", value: successorPath } }
    : released
      ? { pane_id: "w1:p2", cwd: value.targetWorktree, agent: null, agent_status: "unknown", agent_session: null }
      : { pane_id: "w1:p2", cwd: value.targetWorktree, agent, agent_status: "idle", agent_session: { source: "pi", agent, kind: "path", value: sourcePath } };
  const processes = () => started || !released
    ? [{ pid: started ? 202 : 101, name: "pi", argv0: "pi", cmdline: "pi" }]
    : [{ pid: 11, name: "zsh", argv0: "zsh", cmdline: "zsh" }];
  const command = async (command: string[]) => {
    calls.push(command);
    const parts = command.slice(3);
    if (parts[0] === "workspace" && parts[1] === "list") return JSON.stringify({ result: { workspaces: [
      { workspace_id: "w1", label: "demo", worktree: { checkout_path: "/work/primary" } },
      ...(value.targetRole === "main" ? [] : [{ workspace_id: "w2", label: value.target, worktree: { checkout_path: value.targetWorktree } }]),
    ] } });
    if (parts[0] === "tab" && parts[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "w1:t1", workspace_id: value.targetRole === "main" ? "w1" : "w2", label: value.target }] } });
    if (parts[0] === "pane" && parts[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: "w1:p2", tab_id: "w1:t1", label: value.target }] } });
    if (parts[0] === "pane" && parts[1] === "get") return JSON.stringify({ result: { pane: pane() } });
    if (parts[0] === "pane" && parts[1] === "process-info") return JSON.stringify({ result: { process_info: { pane_id: "w1:p2", shell_pid: 11, foreground_processes: processes() } } });
    if (parts[0] === "pane" && parts[1] === "run") return JSON.stringify({ result: { pane_id: "w1:p2" } });
    if (parts[0] === "agent" && parts[1] === "list") return JSON.stringify({ result: { agents: released && !started ? [] : [{ name: agent, agent: "pi", pane_id: "w1:p2", cwd: value.targetWorktree, agent_session: { kind: "path", value: started ? successorPath : sourcePath } }] } });
    if (parts[0] === "agent" && parts[1] === "get") return JSON.stringify({ result: { agent: { name: agent, agent: "pi", pane_id: "w1:p2", cwd: value.targetWorktree, agent_status: "idle", agent_session: { kind: "path", value: started ? successorPath : sourcePath } } } });
    if (parts[0] === "agent" && parts[1] === "start") {
      starts += 1;
      started = true;
      await registerRuntimeState(value.root, { seat: value.target, owner_token: successorOwner, pid: 202, model: "economy", cwd: value.targetWorktree }, at);
      if (options.startGate) await options.startGate;
      return JSON.stringify({ result: { name: agent } });
    }
    throw new Error(`unexpected Herdr command: ${command.join(" ")}`);
  };
  const pause = async () => {
    ticks += 1;
    if (!released && options.releaseOnPause !== false) {
      await clearRuntimeState(value.root, value.target, sourceOwner);
      released = true;
    }
    if (started) await heartbeatRuntimeState(value.root, value.target, successorOwner, "2026-10-20T14:00:01.000Z");
  };
  return { calls, command, pause, release: () => { released = true; }, starts: () => starts, ticks: () => ticks };
}

const selectEconomy = async () => ({ available: true as const, model: "governed", selected_model: "economy", confidence: 0.99 });

async function rotate(value: Awaited<ReturnType<typeof fixture>>, herdr: ReturnType<typeof fakeHerdr>, commandArgs = args(value), extra: Record<string, unknown> = {}) {
  const api = await runtimeRotation();
  return api.rotatePiRuntime(value.root, value.target, commandArgs, {
    command: herdr.command, pause: herdr.pause, select: selectEconomy, sessionId: () => successorSession, at: () => at, ...extra,
  });
}

async function immutableSnapshot(value: Awaited<ReturnType<typeof fixture>>) {
  const request = handoverReplacementPath(value.root, value.target);
  const receiptDirectory = join(value.root, ".atdd-flow", "runtime-launch");
  return {
    seat: await readFile(paths(value.root).seatFile(value.target), "utf8"),
    task: await readFile(paths(value.root).taskFile("demo", "rotate"), "utf8"),
    handover: await readFile(paths(value.root).handoverFile(value.target), "utf8"),
    request: await exists(request) ? await readFile(request, "utf8") : undefined,
    receipts: (await readdir(receiptDirectory)).sort(),
    runtime: await readFile(runtimeStatePath(value.root, value.target), "utf8"),
  };
}

function processEffects(calls: string[][]) {
  return calls.map((call) => call.slice(3).join(" ")).filter((call) => call.startsWith("pane run") || call.startsWith("agent start"));
}

export { at, args, fakeHerdr, fixture, immutableSnapshot, processEffects, rotate, sourcePath, sourceSession, successorPath, successorSession };
export async function cleanupFixtures() { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); }
