import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { launchPiRuntime } from "../src/seats";
import { block, unblock } from "../src/tasks";

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
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", roles: {} });
  await atomicYaml(paths(root).seatFile(seat), { schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/runtime" });
  await atomicYaml(paths(root).taskFile("demo", "runtime"), { schema: "atdd-workflow/task/v1", title: "Bounded runtime work", status: "in_progress", coordinator: "coordinator@demo", assignee: seat, done_when: [{ text: "Runtime command is tested." }] });
  return root;
}

async function priorRuntime(root: string) {
  const receipt = join(root, ".atdd-flow", "runtime-launch", "old.yaml");
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: sessionId, pi_session_path: sessionPath, herdr_session: "forge", pane: "w1:p2" });
  const saved = await readYaml<Record<string, any>>(paths(root).seatFile(seat));
  saved.runtime = { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, pi_session: sessionId, pi_session_path: sessionPath, launch_receipt: receipt };
  await atomicYaml(paths(root).seatFile(seat), saved);
}

function fakeHerdr(options: { released?: boolean; verifiedPath?: string } = {}) {
  const calls: string[][] = [];
  let started = false;
  let requestedId = sessionId;
  const shell = { pane_id: "w1:p2", agent: options.released === false ? "flow-driver-runtime-demo" : null, agent_status: "unknown", agent_session: null };
  const running = () => ({ pane_id: "w1:p2", agent: "flow-driver-runtime-demo", agent_status: "idle", agent_session: { source: "pi", agent: "flow-driver-runtime-demo", kind: "path", value: options.verifiedPath ?? sessionPath } });
  return {
    calls,
    command: async (command: string[]) => {
      calls.push(command);
      const args = command.slice(3);
      if (args[0] === "pane" && args[1] === "get") return JSON.stringify({ result: { pane: started ? running() : shell } });
      if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: {
        pane_id: "w1:p2", shell_pid: 11,
        // Copied installed shape: node/pi argv0 is available, argv is absent.
        foreground_processes: started ? [{ pid: 22, name: "node", argv0: "node" }, { pid: 23, name: "pi", argv0: "pi" }] : [{ pid: 11, name: "zsh", argv0: "zsh" }],
      } } });
      if (args[0] === "pane" && args[1] === "run") return JSON.stringify({ result: { pane_id: "w1:p2" } });
      if (args[0] === "agent" && args[1] === "start") {
        const piArgs = args.slice(args.indexOf("--") + 1);
        const id = piArgs.indexOf("--session-id");
        requestedId = id >= 0 ? piArgs[id + 1]! : sessionId;
        started = true;
        return JSON.stringify({ result: { name: "flow-driver-runtime-demo" } });
      }
      if (args[0] === "agent" && args[1] === "get") return JSON.stringify({ result: { agent: { name: "flow-driver-runtime-demo", pane_id: "w1:p2", status: "idle" } } });
      throw new Error(`unexpected Herdr command: ${command.join(" ")}`);
    },
    requestedId: () => requestedId,
  };
}

const selectEconomy = async () => ({ available: true as const, model: "fake-jev", selected_model: "economy", confidence: 0.93 });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("first launch uses only installed Herdr commands and persists the exact reported JSONL path before binding", async () => {
  const root = await desk();
  const herdr = fakeHerdr();
  const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select: selectEconomy, command: herdr.command, sessionId: () => sessionId, at: () => "2026-10-10T14:30:00.000Z" });

  const commands = herdr.calls.map((entry) => entry.join(" "));
  expect(commands.some((entry) => entry.includes("agent inspect") || entry.includes("agent stop") || entry.includes("--json") || entry.includes("--env"))).toBe(false);
  expect(commands).toContain(`herdr --session forge pane run w1:p2 export ATDD_WORKFLOW_ROOT='${root}' ATDD_WORKFLOW_SEAT='${seat}'`);
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

test("unavailable, low-confidence, or invalid Jev selection receipts the strongest fallback", async () => {
  const selections = [async () => ({ available: false as const, reason: "Jev offline" }), async () => ({ available: true as const, selected_model: "economy", confidence: 0.74 }), async () => ({ available: true as const, selected_model: "missing", confidence: 0.99 })];
  for (const select of selections) {
    const root = await desk();
    const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select, command: fakeHerdr().command, sessionId: () => sessionId });
    expect(result.candidate).toBe("strong");
    expect(await readFile(result.receipt, "utf8")).toContain("fallback");
  }
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

test("dry-run reads installed reports only and does not write, start, or bind", async () => {
  const root = await desk();
  const herdr = fakeHerdr();
  const plan = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--dry-run"], { select: selectEconomy, command: herdr.command, sessionId: () => sessionId });
  expect(plan.dryRun).toBe(true);
  expect(herdr.calls).toHaveLength(2);
  expect(await Bun.file(plan.receipt).exists()).toBe(false);
  expect((await readYaml<Record<string, any>>(paths(root).seatFile(seat))).runtime).toBeUndefined();
});
