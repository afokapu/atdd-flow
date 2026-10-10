import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { launchPiRuntime } from "../src/seats";

const roots: string[] = [];
const seat = "driver.runtime@demo";
const session = "exact-session";

async function desk() {
  const root = await mkdtemp(join(tmpdir(), "atdd-runtime-launch-"));
  roots.push(root);
  const bin = join(root, "bin");
  const pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [
    { id: "strong", executable: "pi", args: ["--model", "strong"] },
    { id: "economy", executable: "pi", args: ["--model", "economy"] },
  ] });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", roles: {} });
  await atomicYaml(paths(root).seatFile(seat), { schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/runtime" });
  await atomicYaml(paths(root).taskFile("demo", "runtime"), { schema: "atdd-workflow/task/v1", title: "Bounded runtime work", status: "in_progress", coordinator: "coordinator@demo", assignee: seat, done_when: [{ text: "Runtime command is tested." }] });
  return root;
}

async function priorRuntime(root: string) {
  const receipt = join(root, ".atdd-flow", "runtime-launch", "old.yaml");
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: session, herdr_session: "forge", pane: "w1:p2" });
  const saved = await readYaml<Record<string, any>>(paths(root).seatFile(seat));
  saved.runtime = { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, pi_session: session, launch_receipt: receipt };
  await atomicYaml(paths(root).seatFile(seat), saved);
}

function fakeHerdr(options: { released?: boolean; verifiedSession?: string } = {}) {
  const calls: string[][] = [];
  let started = false;
  let startedSession = session;
  const shell = { pane_id: "w1:p2", agent: options.released === false ? "flow-driver-runtime-demo" : null, agent_status: "unknown", agent_session: null };
  const running = () => {
    const exact = options.verifiedSession ?? startedSession;
    return { pane_id: "w1:p2", agent: "flow-driver-runtime-demo", agent_status: "idle", agent_session: { source: "pi", agent: "flow-driver-runtime-demo", kind: "id", value: exact } };
  };
  return {
    calls,
    command: async (command: string[]) => {
      calls.push(command);
      const args = command.slice(3);
      if (args[0] === "pane" && args[1] === "get") return JSON.stringify({ result: { pane: started ? running() : shell } });
      if (args[0] === "pane" && args[1] === "process-info") {
        const exact = options.verifiedSession ?? startedSession;
        return JSON.stringify({ result: { process_info: {
          pane_id: "w1:p2", shell_pid: 11,
          foreground_processes: started ? [{ pid: 22, name: "pi", argv0: "pi", argv: ["pi", "--session", exact] }] : [{ pid: 11, name: "zsh", argv0: "zsh" }],
        } } });
      }
      if (args[0] === "pane" && args[1] === "run") return JSON.stringify({ result: { pane_id: "w1:p2" } });
      if (args[0] === "agent" && args[1] === "start") { startedSession = args[args.indexOf("--session") + 1]!; started = true; return JSON.stringify({ result: { name: "flow-driver-runtime-demo" } }); }
      if (args[0] === "agent" && args[1] === "get") return JSON.stringify({ result: { agent: { name: "flow-driver-runtime-demo", pane_id: "w1:p2", status: "idle" } } });
      throw new Error(`unexpected Herdr command: ${command.join(" ")}`);
    },
  };
}

const selectEconomy = async () => ({ available: true as const, model: "fake-jev", selected_model: "economy", confidence: 0.93 });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("first launch uses only installed Herdr commands, exports identity in the existing shell, and verifies before binding", async () => {
  const root = await desk();
  const herdr = fakeHerdr();
  const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select: selectEconomy, command: herdr.command, sessionId: () => session, at: () => "2026-10-10T14:30:00.000Z" });

  const commands = herdr.calls.map((entry) => entry.join(" "));
  expect(commands.some((entry) => entry.includes("agent inspect") || entry.includes("agent stop") || entry.includes("--json") || entry.includes("--env"))).toBe(false);
  expect(commands).toContain(`herdr --session forge pane run w1:p2 export ATDD_WORKFLOW_ROOT='${root}' ATDD_WORKFLOW_SEAT='${seat}'`);
  expect(commands).toContainEqual(expect.stringContaining("agent start flow-driver-runtime-demo --kind pi --pane w1:p2 -- --session exact-session --model economy --extension"));
  expect(commands).toContain("herdr --session forge agent get flow-driver-runtime-demo");
  expect(result.piSession).toBe(session);
  const receipt = await readYaml<Record<string, unknown>>(result.receipt);
  expect(receipt).toMatchObject({ seat, tasks: ["runtime"], candidate: "economy", pi_session: session, herdr_session: "forge", pane: "w1:p2" });
  const bound = await readYaml<Record<string, any>>(paths(root).seatFile(seat));
  expect(bound.runtime).toMatchObject({ application: "herdr", model: "economy", wake: "native", pi_session: session, launch_receipt: result.receipt });
});

test("resume requires the previous Pi already released and starts the exact prior session without an invented stop", async () => {
  const root = await desk();
  await priorRuntime(root);
  const herdr = fakeHerdr();
  await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--resume"], { select: selectEconomy, command: herdr.command });
  const commands = herdr.calls.map((entry) => entry.join(" "));
  expect(commands).toContainEqual(expect.stringContaining("agent start flow-driver-runtime-demo --kind pi --pane w1:p2 -- --session exact-session"));
  expect(commands.some((entry) => entry.includes("agent stop") || entry.includes("release-agent"))).toBe(false);
});

test("resume refuses a prior Pi that has not been released", async () => {
  const root = await desk();
  await priorRuntime(root);
  const herdr = fakeHerdr({ released: false });
  await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--resume"], { select: selectEconomy, command: herdr.command })).rejects.toThrow("exited and been released");
  expect(herdr.calls.map((entry) => entry.join(" ")).some((entry) => entry.includes("agent start"))).toBe(false);
});

test("unavailable, low-confidence, or invalid Jev selection receipts the strongest fallback", async () => {
  const selections = [
    async () => ({ available: false as const, reason: "Jev offline" }),
    async () => ({ available: true as const, selected_model: "economy", confidence: 0.74 }),
    async () => ({ available: true as const, selected_model: "missing", confidence: 0.99 }),
  ];
  for (const select of selections) {
    const root = await desk();
    const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select, command: fakeHerdr().command, sessionId: () => crypto.randomUUID() });
    expect(result.candidate).toBe("strong");
    expect(await readFile(result.receipt, "utf8")).toContain("fallback");
  }
});

test("mismatched verification refuses binding and dry-run inspects only", async () => {
  const root = await desk();
  const mismatch = fakeHerdr({ verifiedSession: "other-session" });
  await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select: selectEconomy, command: mismatch.command, sessionId: () => session })).rejects.toThrow("exact requested Pi session");
  expect((await readYaml<Record<string, any>>(paths(root).seatFile(seat))).runtime).toBeUndefined();

  const dryRun = fakeHerdr();
  const plan = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--dry-run"], { select: selectEconomy, command: dryRun.command, sessionId: () => "dry-session" });
  expect(plan.dryRun).toBe(true);
  expect(dryRun.calls).toHaveLength(2);
  expect(await Bun.file(plan.receipt).exists()).toBe(false);
});
