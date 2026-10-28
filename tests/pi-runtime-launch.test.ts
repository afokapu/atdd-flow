import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { launchPiRuntime } from "../src/seats";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { block, unblock } from "../src/tasks";
import { recordHandover, resumedHandover, showHandover } from "../src/handover";
import { registerRuntimeState } from "../src/runtime-state";

const roots: string[] = [];
const seat = "driver.runtime@demo";
const sessionId = "01a12345-6789-7abc-8def-0123456789ab";
const sessionPath = "/Users/test/.pi/agent/sessions/demo/2026-10-10T14-30-00-000Z_01a12345-6789-7abc-8def-0123456789ab.jsonl";

async function desk() {
  const root = await mkdtemp(join(tmpdir(), "atdd-runtime-launch-"));
  roots.push(root);
  const bin = join(root, "bin");
  const pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "strong", executable: "pi", args: ["--model", "strong"] }, { id: "economy", executable: "pi", args: ["--model", "economy"] }] });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", repository: "/work/primary", roles: {} });
  await atomicYaml(paths(root).seatFile(seat), { schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/runtime" });
  await atomicYaml(paths(root).taskFile("demo", "runtime"), { schema: "atdd-workflow/task/v1", title: "Bounded runtime work", status: "in_progress", coordinator: "coordinator@demo", assignee: seat, done_when: [{ text: "Runtime command is tested." }] });
  return root;
}

let authorizationCount = 0;
async function operatorAuthorization(root: string, sessionPath: string, overrides: Record<string, unknown> = {}, sender = "operator@desk") {
  const id = `A-adoption-${authorizationCount += 1}`;
  await createExactSessionAdoptionAuthorization(root, id, [
    "--by", "operator@desk", "--seat", seat, "--pi-session", sessionId, "--pi-session-path", sessionPath,
    "--source-herdr-session", "legacy", "--source-pane", "w1:p2", "--target-herdr-session", "forge", "--target-pane", "w1:p2", "--target-cwd", "/work/demo",
  ]);
  if (Object.keys(overrides).length || sender !== "operator@desk") {
    const file = join(root, ".atdd-flow", "exact-session-adoption-authorizations", `${id}.yaml`);
    const record = await readYaml<Record<string, unknown>>(file);
    await atomicYaml(file, { ...record, issued_by: sender, ...overrides });
  }
  return id;
}

async function priorRuntime(root: string) {
  const receipt = join(root, ".atdd-flow", "runtime-launch", "old.yaml");
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: sessionId, pi_session_path: sessionPath, herdr_session: "forge", pane: "w1:p2" });
  const saved = await readYaml<Record<string, any>>(paths(root).seatFile(seat));
  saved.runtime = { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, pi_session: sessionId, pi_session_path: sessionPath, launch_receipt: receipt };
  await atomicYaml(paths(root).seatFile(seat), saved);
}

function fakeHerdr(options: { project?: string; released?: boolean; sourceLive?: boolean; verifiedPath?: string; seat?: string; primary?: string; worktree?: string; agentLifecycle?: { key?: "agent_status" | "status" | "state"; value?: string } } = {}) {
  const calls: string[][] = [];
  let started = false;
  let requestedId = sessionId;
  const targetSeat = options.seat ?? seat;
  const primary = options.primary ?? "/work/primary";
  const worktree = options.worktree ?? "/work/demo";
  const agent = `flow-${targetSeat.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`.slice(0, 32);
  const lifecycle = options.agentLifecycle ?? { key: "status", value: "idle" };
  const shell = { pane_id: "w1:p2", agent: options.released === false ? agent : null, agent_status: "unknown", agent_session: null };
  const running = () => ({ pane_id: "w1:p2", agent, agent_status: "idle", agent_session: { source: "pi", agent, kind: "path", value: options.verifiedPath ?? sessionPath } });
  return {
    calls,
    command: async (command: string[]) => {
      calls.push(command);
      const session = command[2];
      const args = command.slice(3);
      if (args[0] === "workspace" && args[1] === "list") return JSON.stringify({ result: { workspaces: [
        { workspace_id: "w1", label: options.project ?? "demo", worktree: { checkout_path: primary } },
        { workspace_id: "w2", label: targetSeat, worktree: { checkout_path: worktree } },
      ] } });
      if (args[0] === "tab" && args[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "w2:t1", workspace_id: "w2", label: targetSeat }] } });
      if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: "w1:p2", tab_id: "w2:t1", label: targetSeat }] } });
      if (args[0] === "pane" && args[1] === "get") return JSON.stringify({ result: { pane: started || (session !== "forge" && options.sourceLive) ? running() : shell } });
      if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: {
        pane_id: "w1:p2", shell_pid: 11,
        // Copied installed shape: node/pi argv0 is available, argv is absent.
        foreground_processes: started || (session !== "forge" && options.sourceLive) ? [{ pid: 22, name: "node", argv0: "node" }, { pid: 23, name: "pi", argv0: "pi" }] : [{ pid: 11, name: "zsh", argv0: "zsh" }],
      } } });
      if (args[0] === "pane" && args[1] === "run") return JSON.stringify({ result: { pane_id: "w1:p2" } });
      if (args[0] === "agent" && args[1] === "start") {
        const piArgs = args.slice(args.indexOf("--") + 1);
        const id = piArgs.indexOf("--session-id");
        requestedId = id >= 0 ? piArgs[id + 1]! : sessionId;
        started = true;
        return JSON.stringify({ result: { name: agent } });
      }
      if (args[0] === "agent" && args[1] === "get") return JSON.stringify({ result: { agent: { name: agent, pane_id: "w1:p2", ...(lifecycle.key && lifecycle.value ? { [lifecycle.key]: lifecycle.value } : {}) } } });
      throw new Error(`unexpected Herdr command: ${command.join(" ")}`);
    },
    requestedId: () => requestedId,
  };
}

const selectEconomy = async () => ({ available: true as const, model: "fake-jev", selected_model: "economy", confidence: 0.93 });
const coordinatorSeat = "coordinator.payments@demo";
const coordinatorPrimary = "/work/coordinator-primary";
const coordinatorWorktree = "/work/coordinator-worktrees/payments";

async function coordinatorDesk() {
  const root = await mkdtemp(join(tmpdir(), "atdd-coordinator-runtime-launch-"));
  roots.push(root);
  const bin = join(root, "bin");
  const pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "strong", executable: "pi", args: ["--model", "strong"] }, { id: "economy", executable: "pi", args: ["--model", "economy"] }] });
  await atomicYaml(paths(root).projectFile("demo"), {
    schema: "atdd-workflow/project/v1", project: "demo", repository: coordinatorPrimary, worktree_root: "/work/coordinator-worktrees",
    roles: {
      main: { address: "main@{project}", branch: "main", worktree: "{repository}" },
      coordinator: { address: "coordinator.{name}@{project}", branch: "integration/{name}", worktree: "{worktree_root}/{name}" },
      driver: { address: "driver.{name}@{project}", branch: "delivery/{name}", worktree: "{worktree_root}/{name}" },
    },
  });
  await atomicYaml(paths(root).seatFile(coordinatorSeat), { schema: "atdd-workflow/seat/v2", address: coordinatorSeat, role: "coordinator", project: "demo", worktree: coordinatorWorktree, branch: "integration/payments" });
  await atomicYaml(paths(root).taskFile("demo", "coordinate"), { schema: "atdd-workflow/task/v1", title: "Coordinate integration", status: "todo", coordinator: coordinatorSeat, done_when: [{ text: "Integration is accountable." }] });
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("first launch uses only installed Herdr commands and persists the exact reported JSONL path before binding", async () => {
  const root = await desk();
  const herdr = fakeHerdr();
  const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select: selectEconomy, command: herdr.command, sessionId: () => sessionId, at: () => "2026-10-10T14:30:00.000Z" });

  const commands = herdr.calls.map((entry) => entry.join(" "));
  expect(commands.some((entry) => entry.includes("agent inspect") || entry.includes("agent stop") || entry.includes("--json") || entry.includes("--env"))).toBe(false);
  expect(commands).toContain(`herdr --session forge pane run w1:p2 export ATDD_WORKFLOW_ROOT='${root}' ATDD_WORKFLOW_SEAT='${seat}' ATDD_FLOW_PI_SESSION='${sessionId}' ATDD_FLOW_HERDR_SESSION='forge' ATDD_FLOW_HERDR_PANE='w1:p2'`);
  expect(commands).toContainEqual(expect.stringContaining(`agent start flow-driver-runtime-demo --kind pi --pane w1:p2 -- --session-id ${sessionId} --model economy --extension`));
  expect(herdr.requestedId()).toBe(sessionId);
  const start = herdr.calls.find((entry) => entry.includes("start"))!;
  const newPiArgs = start.slice(start.indexOf("--") + 1);
  expect(newPiArgs.slice(0, 2)).toEqual(["--session-id", sessionId]);
  expect(newPiArgs).not.toContain("latest");
  const receipt = await readYaml<Record<string, unknown>>(result.receipt);
  expect(receipt).toMatchObject({ seat, candidate: "economy", pi_session: sessionId, pi_session_path: sessionPath, herdr_session: "forge", pane: "w1:p2" });
  const bound = await readYaml<Record<string, any>>(paths(root).seatFile(seat));
  expect(bound.runtime).toMatchObject({ pi_session: sessionId, pi_session_path: sessionPath, launch_receipt: result.receipt });
});

test("accepts Herdr agent get's actual agent_status lifecycle shape", async () => {
  const root = await desk();
  await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], {
    select: selectEconomy, command: fakeHerdr({ agentLifecycle: { key: "agent_status", value: "idle" } }).command, sessionId: () => sessionId,
  })).resolves.toMatchObject({ piSession: sessionId });
});

test("preserves legacy agent lifecycle fields and rejects unknown or missing reports", async () => {
  for (const agentLifecycle of [{ key: "status", value: "idle" }, { key: "state", value: "done" }] as const) {
    const root = await desk();
    await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], {
      select: selectEconomy, command: fakeHerdr({ agentLifecycle }).command, sessionId: () => sessionId,
    })).resolves.toMatchObject({ piSession: sessionId });
  }
  for (const agentLifecycle of [{ key: "agent_status", value: "unknown" }, { key: "status", value: "unknown" }, { key: "state", value: "unknown" }, {}] as const) {
    const root = await desk();
    await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], {
      select: selectEconomy, command: fakeHerdr({ agentLifecycle }).command, sessionId: () => sessionId,
    })).rejects.toThrow("did not verify the replacement Pi process");
  }
});

test("RED: launch resolves the exact seat-scoped projected pane without accepting a caller pane", async () => {
  const root = await desk();
  const herdr = fakeHerdr();
  await expect(launchPiRuntime(root, seat, ["--herdr-session", "forge", "--dry-run"], {
    select: selectEconomy, command: herdr.command, sessionId: () => sessionId,
  })).resolves.toMatchObject({ pane: "w1:p2", herdrSession: "forge", dryRun: true });
  await expect(launchPiRuntime(root, seat, ["--pane", "w9:p9", "--herdr-session", "forge", "--dry-run"], {
    select: selectEconomy, command: herdr.command, sessionId: () => sessionId,
  })).rejects.toThrow("does not match the seat-scoped Herdr projection");
  expect(herdr.calls.map((entry) => entry.join(" "))).not.toContainEqual(expect.stringContaining("agent start"));
});

test("resume requires the previous Pi already released and the same exact reported path", async () => {
  const root = await desk();
  await priorRuntime(root);
  const herdr = fakeHerdr();
  await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--resume"], { select: selectEconomy, command: herdr.command });
  expect(herdr.requestedId()).toBe(sessionId);
  const start = herdr.calls.find((entry) => entry.includes("start"))!;
  const resumedPiArgs = start.slice(start.indexOf("--") + 1);
  expect(resumedPiArgs.slice(0, 2)).toEqual(["--session", sessionPath]);
  expect(resumedPiArgs).not.toContain("--session-id");
  expect(resumedPiArgs).not.toContain("latest");
  expect(herdr.calls.map((entry) => entry.join(" ")).some((entry) => entry.includes("agent stop") || entry.includes("release-agent"))).toBe(false);
});

test("resume refuses a prior Pi still present, a mismatched reported path, or a path with a different documented ID", async () => {
  const root = await desk();
  await priorRuntime(root);
  await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--resume"], { select: selectEconomy, command: fakeHerdr({ released: false }).command })).rejects.toThrow("exited and been released");
  await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--resume"], { select: selectEconomy, command: fakeHerdr({ verifiedPath: sessionPath.replace("2026-10-10", "2026-10-11") }).command })).rejects.toThrow("exact requested Pi session path");
  await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--resume"], { select: selectEconomy, command: fakeHerdr({ verifiedPath: sessionPath.replace(sessionId, "01a99999-6789-7abc-8def-0123456789ab") }).command })).rejects.toThrow("exact requested Pi session");
});

test("a TODO depending on a superseded or rejected task is launch-eligible", async () => {
  for (const status of ["superseded", "rejected"]) {
    const root = await desk();
    const file = paths(root).taskFile("demo", "runtime");
    const todo = await readYaml<Record<string, unknown>>(file);
    await atomicYaml(paths(root).taskFile("demo", "closed"), { schema: "atdd-workflow/task/v1", title: "Closed", status, coordinator: "coordinator@demo", disposition: { kind: status, by: "coordinator@demo", at: "2026-10-10T00:00:00.000Z", reason: "Closed." }, done_when: [{ text: "Never." }] });
    await atomicYaml(file, { ...todo, status: "todo", depends_on: ["closed"] });
    await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--dry-run"], { select: selectEconomy, command: fakeHerdr().command, sessionId: () => sessionId })).resolves.toMatchObject({ dryRun: true });
  }
});

test("model selection considers only non-terminal tasks", async () => {
  const root = await desk();
  await atomicYaml(paths(root).taskFile("demo", "obsolete"), { schema: "atdd-workflow/task/v1", title: "Obsolete work", status: "superseded", coordinator: "coordinator@demo", assignee: seat, disposition: { kind: "superseded", by: "coordinator@demo", at: "2026-10-10T00:00:00.000Z", reason: "Replaced." }, done_when: [{ text: "Never delivered." }] });
  const seen: string[][] = [];
  await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--dry-run"], {
    select: async (input) => { seen.push(input.tasks.map((task) => task.id)); return selectEconomy(); },
    command: fakeHerdr().command, sessionId: () => sessionId,
  });
  expect(seen).toEqual([["runtime"]]);
});

test("RED: cross-session or pane relocation cannot use legacy resume", async () => {
  const root = await desk();
  await priorRuntime(root);
  await expect(launchPiRuntime(root, seat, ["--pane", "w9:p9", "--herdr-session", "forge", "--resume"], {
    select: selectEconomy, command: fakeHerdr().command,
  })).rejects.toThrow("explicit exact-session adoption");
  await expect(launchPiRuntime(root, seat, ["--herdr-session", "rehomed", "--resume"], {
    select: selectEconomy, command: fakeHerdr().command,
  })).rejects.toThrow("explicit exact-session adoption");
});

test("RED: explicit exact-session adoption needs a released source, backup hash, and immutable relocation receipt", async () => {
  const root = await desk();
  const source = join(root, "legacy-session_01a12345-6789-7abc-8def-0123456789ab.jsonl");
  await writeFile(source, '{"type":"session"}\n');
  const authorization = await operatorAuthorization(root, source);
  const result = await launchPiRuntime(root, seat, [
    "--pane", "w1:p2", "--herdr-session", "forge", "--adopt-session", source,
    "--source-herdr-session", "legacy", "--source-pane", "w1:p2",
    "--authorization", authorization,
  ], { select: selectEconomy, command: fakeHerdr({ verifiedPath: source }).command });
  const receipt = await readYaml<Record<string, unknown>>(result.receipt);
  expect(receipt).toMatchObject({ pi_session: sessionId, pi_session_path: source, relocation: {
    source_herdr_session: "legacy", source_pane: "w1:p2", authorization: { id: authorization },
  } });
  expect(typeof (receipt.relocation as Record<string, unknown>).backup_sha256).toBe("string");
  expect(await Bun.file((receipt.relocation as Record<string, string>).backup).exists()).toBe(true);
  await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--adopt-session", source, "--source-herdr-session", "legacy", "--source-pane", "w1:p2", "--authorization", authorization], { select: selectEconomy, command: fakeHerdr({ verifiedPath: source }).command }))
    .rejects.toThrow("already used");
});

test("RED: adoption does not run or start a target Pi when the required source backup fails", async () => {
  const root = await desk();
  const source = join(root, `missing_${sessionId}.jsonl`);
  const authorization = await operatorAuthorization(root, source);
  const herdr = fakeHerdr({ verifiedPath: source });
  await expect(launchPiRuntime(root, seat, [
    "--pane", "w1:p2", "--herdr-session", "forge", "--adopt-session", source,
    "--source-herdr-session", "legacy", "--source-pane", "w1:p2", "--authorization", authorization,
  ], { select: selectEconomy, command: herdr.command })).rejects.toThrow();
  const commands = herdr.calls.map((call) => call.join(" "));
  expect(commands).not.toContainEqual(expect.stringContaining("pane run"));
  expect(commands).not.toContainEqual(expect.stringContaining("agent start"));
});

test("RED: adoption validates an immutable operator authorization bound to the exact tuple before projection", async () => {
  const root = await desk();
  const source = join(root, `legacy_${sessionId}.jsonl`);
  await writeFile(source, "source");
  const cases: Array<{ name: string; authorization: () => Promise<string> }> = [
    { name: "nonexistent", authorization: async () => "M-missing" },
    { name: "wrong sender", authorization: () => operatorAuthorization(root, source, {}, "coordinator@demo") },
    { name: "mutable record", authorization: () => operatorAuthorization(root, source, { created_at: "2026-10-11T00:00:00.000Z" }) },
    { name: "non-schema record", authorization: () => operatorAuthorization(root, source, { schema: "untrusted" }) },
    { name: "wrong seat", authorization: () => operatorAuthorization(root, source, { seat: "driver.other@demo" }) },
    { name: "wrong session", authorization: () => operatorAuthorization(root, source, { pi_session: "01a99999-6789-7abc-8def-0123456789ab" }) },
    { name: "wrong source", authorization: () => operatorAuthorization(root, source, { source: { herdr_session: "other", pane: "w1:p2" } }) },
    { name: "wrong target", authorization: () => operatorAuthorization(root, source, { target: { herdr_session: "forge", pane: "w9:p9" } }) },
  ];
  for (const entry of cases) {
    const authorization = await entry.authorization();
    const herdr = fakeHerdr({ verifiedPath: source });
    await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--adopt-session", source, "--source-herdr-session", "legacy", "--source-pane", "w1:p2", "--authorization", authorization], { select: selectEconomy, command: herdr.command }))
      .rejects.toThrow("immutable operator authorization");
    expect(herdr.calls.map((call) => call.join(" "))).not.toContainEqual(expect.stringContaining("workspace list"));
  }
});

test("exact-session adoption fails closed for live sources, wrong targets, missing authorization, and receipt substitution", async () => {
  const args = (source: string, authorization: string, pane = "w1:p2") => ["--pane", pane, "--herdr-session", "forge", "--adopt-session", source, "--source-herdr-session", "legacy", "--source-pane", "w1:p2", "--authorization", authorization];
  const live = await desk();
  const liveSource = join(live, `legacy_${sessionId}.jsonl`);
  await writeFile(liveSource, "source");
  await expect(launchPiRuntime(live, seat, args(liveSource, await operatorAuthorization(live, liveSource)), { select: selectEconomy, command: fakeHerdr({ sourceLive: true, verifiedPath: liveSource }).command }))
    .rejects.toThrow("source Pi has exited and been released");

  const missingAuthorization = await desk();
  const unauthorizedSource = join(missingAuthorization, `legacy_${sessionId}.jsonl`);
  await writeFile(unauthorizedSource, "source");
  const unauthorized = await operatorAuthorization(missingAuthorization, unauthorizedSource);
  await expect(launchPiRuntime(missingAuthorization, seat, args(unauthorizedSource, unauthorized).filter((value) => value !== "--authorization" && value !== unauthorized), { select: selectEconomy, command: fakeHerdr().command }))
    .rejects.toThrow("requires --adopt-session");
  await expect(launchPiRuntime(missingAuthorization, seat, args(unauthorizedSource, unauthorized, "w9:p9"), { select: selectEconomy, command: fakeHerdr().command }))
    .rejects.toThrow("immutable operator authorization record bound to the exact adoption tuple");

  const substituted = await desk();
  const adoptedSource = join(substituted, `legacy_${sessionId}.jsonl`);
  await writeFile(adoptedSource, "source");
  await launchPiRuntime(substituted, seat, args(adoptedSource, await operatorAuthorization(substituted, adoptedSource)), { select: selectEconomy, command: fakeHerdr({ verifiedPath: adoptedSource }).command });
  const bound = await readYaml<Record<string, any>>(paths(substituted).seatFile(seat));
  const replacementReceipt = join(substituted, ".atdd-flow", "runtime-launch", "substituted.yaml");
  await atomicYaml(replacementReceipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: sessionId, pi_session_path: adoptedSource, herdr_session: "forge", pane: "w9:p9" });
  await atomicYaml(paths(substituted).seatFile(seat), { ...bound, runtime: { ...bound.runtime, launch_receipt: replacementReceipt } });
  await expect(launchPiRuntime(substituted, seat, ["--herdr-session", "forge", "--resume"], { select: selectEconomy, command: fakeHerdr({ verifiedPath: adoptedSource }).command }))
    .rejects.toThrow("valid Flow launch receipt");
});

test("unavailable, low-confidence, or invalid Jev selection receipts the strongest fallback", async () => {
  const selections = [async () => ({ available: false as const, reason: "Jev offline" }), async () => ({ available: true as const, selected_model: "economy", confidence: 0.74 }), async () => ({ available: true as const, selected_model: "missing", confidence: 0.99 })];
  for (const select of selections) {
    const root = await desk();
    const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select, command: fakeHerdr().command, sessionId: () => sessionId });
    expect(result.candidate).toBe("strong");
    expect(await readFile(result.receipt, "utf8")).toContain("fallback");
  }
});

async function configureFallback(root: string, fallback_model: Record<string, string>) {
  await atomicYaml(paths(root).desk, { ...await readYaml<Record<string, unknown>>(paths(root).desk), fallback_model });
}

const fallbackSelections = {
  unavailable: async () => ({ available: false as const, reason: "Jev offline" }),
  "low-confidence": async () => ({ available: true as const, selected_model: "economy", confidence: 0.74 }),
  "out-of-portfolio": async () => ({ available: true as const, selected_model: "missing", confidence: 0.99 }),
};

test("driver fallback uses desk fallback_model.driver and receipts role, model, and reason", async () => {
  for (const [kind, select] of Object.entries(fallbackSelections)) {
    const root = await desk();
    await configureFallback(root, { driver: "economy" });
    const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select, command: fakeHerdr().command, sessionId: () => sessionId });
    expect(result.candidate, kind).toBe("economy");
    const receipt = await readYaml<Record<string, any>>(result.receipt);
    expect(receipt.candidate).toBe("economy");
    expect(receipt.selection.result).toBe("fallback");
    expect(receipt.selection.applied_fallback).toEqual({ role: "driver", model: "economy", reason: receipt.selection.reason });
    expect(receipt.selection.reason).toBeTruthy();
  }
});

test("a successful Jev selection ignores the configured fallback", async () => {
  const root = await desk();
  await configureFallback(root, { driver: "strong" });
  const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select: selectEconomy, command: fakeHerdr().command, sessionId: () => sessionId });
  expect(result.candidate).toBe("economy");
});

test("roles without a configured fallback keep the strongest candidate", async () => {
  const root = await desk();
  await configureFallback(root, { coordinator: "economy" });
  const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select: fallbackSelections.unavailable, command: fakeHerdr().command, sessionId: () => sessionId });
  expect(result.candidate).toBe("strong");
  expect((await readYaml<Record<string, any>>(result.receipt)).selection.applied_fallback).toBeUndefined();
});

test("a missing or disabled configured fallback fails closed with a clear error", async () => {
  const launch = (root: string) => launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select: fallbackSelections.unavailable, command: fakeHerdr().command, sessionId: () => sessionId });
  const missing = await desk();
  await configureFallback(missing, { driver: "nonexistent" });
  await expect(launch(missing)).rejects.toThrow("fallback_model.driver");

  const disabled = await desk();
  await configureFallback(disabled, { driver: "economy" });
  await atomicYaml(paths(disabled).models, { schema: "atdd-workflow/models/v1", models: [{ id: "strong", executable: "pi", args: ["--model", "strong"] }, { id: "economy", executable: "pi", enabled: false, args: ["--model", "economy"] }] });
  await expect(launch(disabled)).rejects.toThrow("fallback_model.driver");
});

test("launch eligibility admits assigned active or dependency-ready TODO without changing lifecycle and refuses every other task", async () => {
  const dryRun = (root: string) => launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--dry-run"], { select: selectEconomy, command: fakeHerdr().command, sessionId: () => sessionId });
  const active = await desk();
  await expect(dryRun(active)).resolves.toMatchObject({ dryRun: true });
  expect((await readYaml<Record<string, unknown>>(paths(active).taskFile("demo", "runtime"))).status).toBe("in_progress");

  const ready = await desk();
  const taskFile = paths(ready).taskFile("demo", "runtime");
  const todo = await readYaml<Record<string, unknown>>(taskFile);
  await atomicYaml(paths(ready).taskFile("demo", "done"), { schema: "atdd-workflow/task/v1", title: "Done", status: "done", coordinator: "coordinator@demo", done_when: [{ text: "Done." }] });
  await atomicYaml(taskFile, { ...todo, status: "todo", depends_on: ["done"] });
  await block(ready, "demo", "runtime", ["--by", seat, "--reason", "Awaiting supported coordinator recovery."]);
  await unblock(ready, "demo", "runtime", ["--by", "coordinator@demo"]);
  await expect(dryRun(ready)).resolves.toMatchObject({ dryRun: true });
  expect((await readYaml<Record<string, unknown>>(taskFile)).status).toBe("todo");

  const refuse = async (change: Record<string, unknown>, waiting = false) => {
    const root = await desk();
    const file = paths(root).taskFile("demo", "runtime");
    const task = await readYaml<Record<string, unknown>>(file);
    const next = { ...task, ...change };
    if (change.assignee === null) delete next.assignee;
    await atomicYaml(file, next);
    if (waiting) await atomicYaml(paths(root).taskFile("demo", "waiting"), { schema: "atdd-workflow/task/v1", title: "Waiting", status: "todo", coordinator: "coordinator@demo", done_when: [{ text: "Finish." }] });
    await expect(dryRun(root)).rejects.toThrow("no launch-eligible task");
  };
  await refuse({ status: "in_progress", blocker: "Awaiting approval." });
  await refuse({ status: "todo", depends_on: ["waiting"] }, true);
  await refuse({ status: "todo", assignee: null });
  await refuse({ status: "review" });
  await refuse({ status: "done" });
  await refuse({ status: "todo", assignee: "driver.other@demo" });
  await refuse({ status: "invalid" });
});

test("named coordinator launches from its exact integration accountability, while invalid coordinator topology remains ineligible", async () => {
  const launch = (root: string) => launchPiRuntime(root, coordinatorSeat, ["--pane", "w1:p2", "--herdr-session", "forge"], {
    select: selectEconomy,
    command: fakeHerdr({ seat: coordinatorSeat, primary: coordinatorPrimary, worktree: coordinatorWorktree }).command,
    sessionId: () => sessionId,
  });
  const root = await coordinatorDesk();
  const result = await launch(root);
  expect(await readFile(result.receipt, "utf8")).toContain("coordinate");
  expect((await readYaml<Record<string, any>>(paths(root).seatFile(coordinatorSeat))).runtime).toMatchObject({
    pi_session: sessionId,
    pi_session_path: sessionPath,
    wake: "native",
    launch_receipt: result.receipt,
  });

  const reject = async (mutate: (root: string) => Promise<void>) => {
    const denied = await coordinatorDesk();
    await mutate(denied);
    await expect(launch(denied)).rejects.toThrow("launch-eligible task");
  };
  await reject(async (denied) => {
    const task = await readYaml<Record<string, unknown>>(paths(denied).taskFile("demo", "coordinate"));
    await atomicYaml(paths(denied).taskFile("demo", "coordinate"), { ...task, blocker: "Awaiting an external decision." });
  });
  await reject(async (denied) => {
    const task = await readYaml<Record<string, unknown>>(paths(denied).taskFile("demo", "coordinate"));
    await atomicYaml(paths(denied).taskFile("demo", "coordinate"), { ...task, coordinator: "coordinator.generic@demo" });
  });
  await reject(async (denied) => {
    const record = await readYaml<Record<string, unknown>>(paths(denied).seatFile(coordinatorSeat));
    await atomicYaml(paths(denied).seatFile(coordinatorSeat), { ...record, branch: "main" });
  });
  await reject(async (denied) => {
    const record = await readYaml<Record<string, unknown>>(paths(denied).seatFile(coordinatorSeat));
    await atomicYaml(paths(denied).seatFile("coordinator.duplicate@demo"), { ...record, address: "coordinator.duplicate@demo" });
  });
  await reject(async (denied) => {
    const record = await readYaml<Record<string, unknown>>(paths(denied).seatFile(coordinatorSeat));
    await atomicYaml(paths(denied).seatFile(coordinatorSeat), { ...record, address: "coordinator.payments.nested@demo", branch: "integration/payments/nested" });
    const task = await readYaml<Record<string, unknown>>(paths(denied).taskFile("demo", "coordinate"));
    await atomicYaml(paths(denied).taskFile("demo", "coordinate"), { ...task, coordinator: "coordinator.payments.nested@demo" });
  });

  const active = await coordinatorDesk();
  const task = await readYaml<Record<string, unknown>>(paths(active).taskFile("demo", "coordinate"));
  await atomicYaml(paths(active).taskFile("demo", "coordinate"), { ...task, status: "in_progress" });
  await expect(launchPiRuntime(active, coordinatorSeat, ["--pane", "w1:p2", "--herdr-session", "forge", "--dry-run"], {
    select: selectEconomy,
    command: fakeHerdr({ seat: coordinatorSeat, primary: coordinatorPrimary, worktree: coordinatorWorktree }).command,
    sessionId: () => sessionId,
  })).resolves.toMatchObject({ dryRun: true });
});

test("dry-run reads installed reports only and does not write, start, or bind", async () => {
  const root = await desk();
  const herdr = fakeHerdr();
  const plan = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--dry-run"], { select: selectEconomy, command: herdr.command, sessionId: () => sessionId });
  expect(plan.dryRun).toBe(true);
  // Topology is read and verified before the existing pane/process dry-run inspection.
  expect(herdr.calls).toHaveLength(5);
  expect(await Bun.file(plan.receipt).exists()).toBe(false);
  expect((await readYaml<Record<string, any>>(paths(root).seatFile(seat))).runtime).toBeUndefined();
});

// RED: operator@desk launch eligibility and the generated canonical relaunch command.
const operatorSeat = "operator@desk";
const operatorPrimary = "/work/desk-primary";
const canonicalOperatorCommand = "atdd-flow pi runtime launch operator@desk --herdr-session forge";

async function operatorDesk(change: Record<string, unknown> = {}, task?: Record<string, unknown>) {
  const root = await desk();
  await atomicYaml(paths(root).desk, { ...await readYaml<Record<string, unknown>>(paths(root).desk), herdr_session: "forge" });
  await atomicYaml(paths(root).projectFile("desk"), { schema: "atdd-workflow/project/v1", project: "desk", repository: operatorPrimary, roles: { main: { address: "main@{project}", branch: "main", worktree: "{repository}" } } });
  await atomicYaml(paths(root).seatFile(operatorSeat), { schema: "atdd-workflow/seat/v2", address: operatorSeat, role: "operator", project: "desk", worktree: operatorPrimary, branch: "main", ...change });
  if (task) await atomicYaml(paths(root).taskFile("desk", "operate"), { schema: "atdd-workflow/task/v1", title: "Operate the Desk", status: "in_progress", coordinator: "main@desk", assignee: operatorSeat, done_when: [{ text: "Desk is operated." }], ...task });
  return root;
}
const operatorHerdr = () => fakeHerdr({ project: "desk", seat: operatorSeat, primary: operatorPrimary, worktree: operatorPrimary });
const launchOperator = (root: string, flags: string[] = ["--dry-run"]) => launchPiRuntime(root, operatorSeat, ["--herdr-session", "forge", ...flags], { select: selectEconomy, command: operatorHerdr().command, sessionId: () => sessionId });

test("RED: the exact operator@desk seat launches through the supported launcher with no task", async () => {
  await expect(launchOperator(await operatorDesk())).resolves.toMatchObject({ dryRun: true, piSession: sessionId });
});

test("RED: the exact operator@desk seat launches with an assigned in_progress task, which is currently refused", async () => {
  await expect(launchOperator(await operatorDesk({}, {}))).resolves.toMatchObject({ dryRun: true });
});

test("RED: a live operator launch persists an immutable receipt, native binding, and the injected extension", async () => {
  const root = await operatorDesk();
  const herdr = operatorHerdr();
  const plan = await launchPiRuntime(root, operatorSeat, ["--herdr-session", "forge"], { select: selectEconomy, command: herdr.command, sessionId: () => sessionId, at: () => "2026-10-27T15:00:00.000Z" });
  const receipt = await readYaml<Record<string, unknown>>(plan.receipt);
  expect(receipt).toMatchObject({ seat: operatorSeat, tasks: [], pi_session: sessionId, pane: "w1:p2" });
  expect((await readYaml<any>(paths(root).seatFile(operatorSeat))).runtime).toMatchObject({ wake: "native", pi_session: sessionId, launch_receipt: plan.receipt });
  expect(plan.command.join(" ")).toContain("--extension");
});

test("operator eligibility is exact: non-primary placement, other roles, and a driver without a task stay refused", async () => {
  await expect(launchOperator(await operatorDesk({ worktree: "/work/elsewhere" }))).rejects.toThrow("no launch-eligible task");
  await expect(launchOperator(await operatorDesk({ branch: "feature" }))).rejects.toThrow("no launch-eligible task");
  await expect(launchOperator(await operatorDesk({ role: "driver" }))).rejects.toThrow("no launch-eligible task");
  const root = await desk();
  await rm(paths(root).taskFile("demo", "runtime"));
  await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--dry-run"], { select: selectEconomy, command: fakeHerdr().command, sessionId: () => sessionId })).rejects.toThrow("no launch-eligible task");
});

test("RED: the launcher plan and pre-exit handover show carry the same generated canonical relaunch command", async () => {
  const root = await operatorDesk();
  expect(await launchOperator(root)).toMatchObject({ canonicalCommand: canonicalOperatorCommand });
  await recordOperatorHandover(root);
  let shown = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { shown += String(chunk); return true; }) as typeof process.stdout.write;
  try { await showHandover(root, operatorSeat); } finally { process.stdout.write = write; }
  expect(shown).toContain(canonicalOperatorCommand);
});

async function recordOperatorHandover(root: string) {
  const file = join(root, "handover.txt");
  await writeFile(file, ["HANDOVER operator@desk | 2026-10-27T15:00:00Z | handover-id H-operator-1 | supersedes none", "Runtime: pi | s1 | model claude/opus | context 81%",
    "1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS", "x", "2. OPEN WORK AND IN-FLIGHT OPERATIONS", "x", "3. DEPENDENCIES", "x", "4. RESUME PROCEDURE AND NEXT ACTIONS", "x", ""].join("\n"));
  await recordHandover(root, operatorSeat, ["--file", file]);
}

async function captureStdout(work: () => Promise<unknown>) {
  let shown = "";
  const log = console.log;
  console.log = (...parts: unknown[]) => { shown += `${parts.join(" ")}\n`; };
  try { await work(); } finally { console.log = log; }
  return shown;
}

const operatorHeartbeat = (root: string, piSession = sessionId) => registerRuntimeState(root, { seat: operatorSeat, owner_token: "owner-operator", pid: 4242, model: "economy", cwd: operatorPrimary, pi_session: piSession }, new Date(Date.now() + 2000).toISOString());
/** Launch the successor through the supported launcher after the pre-exit handover was recorded. */
async function launchedOperator() {
  const root = await operatorDesk();
  await recordOperatorHandover(root);
  await launchPiRuntime(root, operatorSeat, ["--herdr-session", "forge"], { select: selectEconomy, command: operatorHerdr().command, sessionId: () => sessionId, at: () => new Date(Date.now() + 1000).toISOString() });
  return root;
}

test("RED: operator resumed reconciles only a fresh launcher receipt, native-wake binding, and matching heartbeat", async () => {
  const root = await launchedOperator();
  await operatorHeartbeat(root);
  expect(await captureStdout(() => resumedHandover(root, operatorSeat))).toContain("RESUMED; verified 6/6; discrepancies: none.");
});

test("RED: operator resumed fails closed without verified activation", async () => {
  const resumed = (root: string) => resumedHandover(root, operatorSeat);
  // No launch at all: a bare Pi, or the pre-exit runtime, cannot be reported resumed.
  const bare = await operatorDesk();
  await recordOperatorHandover(bare);
  await expect(resumed(bare)).rejects.toThrow("not reconciled");
  // Launched, but the successor extension never registered a heartbeat.
  await expect(resumed(await launchedOperator())).rejects.toThrow("not reconciled");
  // Heartbeat belongs to a different Pi session than the launched successor.
  const other = await launchedOperator();
  await operatorHeartbeat(other, "01a12345-6789-7abc-8def-0123456789ff");
  await expect(resumed(other)).rejects.toThrow("not reconciled");
  // Receipt predates the handover, so it is not the fresh successor.
  const stale = await launchedOperator();
  await operatorHeartbeat(stale);
  const record = await readYaml<any>(paths(stale).seatFile(operatorSeat));
  const receipt = await readYaml<Record<string, unknown>>(record.runtime.launch_receipt);
  await atomicYaml(record.runtime.launch_receipt, { ...receipt, created_at: "2000-01-01T00:00:00.000Z" });
  await expect(resumed(stale)).rejects.toThrow("not reconciled");
  // Binding lost native wake.
  const host = await launchedOperator();
  await operatorHeartbeat(host);
  const saved = await readYaml<any>(paths(host).seatFile(operatorSeat));
  await atomicYaml(paths(host).seatFile(operatorSeat), { ...saved, runtime: { ...saved.runtime, wake: "host" } });
  await expect(resumed(host)).rejects.toThrow("not reconciled");
});

// RED: live failure — the launcher run inside the target pane typed its export into its own tty.
const sameTerminalMessage = "Run this from a different pane; the target pane must be an idle shell.";
const paneRuns = (calls: string[][]) => calls.filter((call) => call[3] === "pane" && call[4] === "run");

test("RED: a launch invoked from inside the target pane refuses before any pane run or agent start", async () => {
  for (const flags of [["--dry-run"], []]) {
    const root = await operatorDesk();
    const herdr = operatorHerdr();
    await expect(launchPiRuntime(root, operatorSeat, ["--herdr-session", "forge", ...flags], { select: selectEconomy, command: herdr.command, sessionId: () => sessionId, hostPane: "w1:p2" } as any)).rejects.toThrow(sameTerminalMessage);
    expect(paneRuns(herdr.calls)).toEqual([]);
    expect(herdr.calls.some((call) => call[3] === "agent" && call[4] === "start")).toBe(false);
    expect((await readYaml<any>(paths(root).seatFile(operatorSeat))).runtime).toBeUndefined();
  }
});

test("RED: a launch whose process is in the target pane's foreground refuses before any pane run", async () => {
  const root = await operatorDesk();
  const herdr = operatorHerdr();
  // The fake pane reports foreground pids 11, 22, 23 once started; make the launcher one of them while still a shell.
  const command = async (args: string[]) => {
    const out = await herdr.command(args);
    return args[3] === "pane" && args[4] === "process-info" ? out.replace("\"pid\":11", "\"pid\":31337") : out;
  };
  await expect(launchPiRuntime(root, operatorSeat, ["--herdr-session", "forge"], { select: selectEconomy, command, sessionId: () => sessionId, hostPane: "w9:p9", hostPid: 31337 } as any)).rejects.toThrow(sameTerminalMessage);
  expect(paneRuns(herdr.calls)).toEqual([]);
});

test("RED: a launch from a different pane still proceeds, and the export is typed only after vacancy is proven", async () => {
  const root = await operatorDesk();
  const herdr = operatorHerdr();
  await launchPiRuntime(root, operatorSeat, ["--herdr-session", "forge"], { select: selectEconomy, command: herdr.command, sessionId: () => sessionId, hostPane: "w9:p9", hostPid: 1 } as any);
  const firstRun = herdr.calls.findIndex((call) => call[3] === "pane" && call[4] === "run");
  const lastVacancy = herdr.calls.findIndex((call) => call[3] === "pane" && call[4] === "process-info");
  expect(lastVacancy).toBeGreaterThanOrEqual(0);
  expect(firstRun).toBeGreaterThan(lastVacancy);
});

test("RED: the handover-show relaunch text tells the operator to use a DIFFERENT pane", async () => {
  const root = await operatorDesk();
  await recordOperatorHandover(root);
  const shown = await captureStdoutRaw(() => showHandover(root, operatorSeat));
  expect(shown).toContain("Exit Pi in the operator pane so it is an idle shell, then run this from a DIFFERENT pane");
  expect(shown).not.toContain("vacant shell pane");
  expect(shown).toContain(canonicalOperatorCommand);
});

async function captureStdoutRaw(work: () => Promise<unknown>) {
  let shown = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { shown += String(chunk); return true; }) as typeof process.stdout.write;
  try { await work(); } finally { process.stdout.write = write; }
  return shown;
}
