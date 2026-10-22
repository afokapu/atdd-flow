// URN: test:flow:relaunched-seat-mail-activation
// Acceptance: acc:flow:E009-RED-001
// Phase: UNIT
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { registerRuntimeState } from "../src/runtime-state";
import { launchPiRuntime } from "../src/seats";

// Contract under test (RED):
// 1 NOTICE  a launcher Pi whose live session differs from the seat binding emits one visible inactive-mail notice after the activation window.
// 2 STATUS  status seat reports 'native mail inactive (bound X, live Y)' for a fresh advisory runtime whose session differs from the binding.
// 3 LAUNCH  pi runtime launch binds with a receipt when Herdr reports the exact session path one poll late.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const seat = "driver.pi@demo";
const bound = "01a00000-0000-7000-8000-00000000000a";
const live = "01a00000-0000-7000-8000-00000000000b";
const pathFor = (id: string) => `/Users/test/.pi/agent/sessions/demo/2026-10-22T09-41-00-000Z_${id}.jsonl`;
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const extension = join(import.meta.dir, "..", "extensions", "pi", "index.ts");

/** A Desk whose seat is bound to the `bound` session with a matching launch receipt. */
async function desk() {
  const root = await mkdtemp(join(tmpdir(), "atdd-mail-activation-"));
  roots.push(root);
  const receipt = join(root, ".atdd-flow", "runtime-launch", "bound.yaml");
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr" });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", repository: "/work/primary", roles: {} });
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: bound, pi_session_path: pathFor(bound), herdr_session: "forge", pane: "w1:p2" });
  await atomicYaml(paths(root).seatFile(seat), {
    schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/pi",
    runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, wake: "native", pi_session: bound, pi_session_path: pathFor(bound), launch_receipt: receipt },
  });
  await atomicYaml(paths(root).taskFile("demo", "work"), { schema: "atdd-workflow/task/v1", title: "Work", status: "in_progress", coordinator: "coordinator@demo", assignee: seat, done_when: [{ text: "Done." }] });
  return root;
}

// The host runs in a child process with an explicit environment so no test mutates shared process.env.
// Date.now jumps forward once session_start returns, which expires the 60s activation window immediately.
const hostScript = `
import install from ${JSON.stringify(extension)};
const sent = []; const listeners = {};
const real = Date.now; let jump = 0; Date.now = () => real() + jump;
install({ on(event, listener) { (listeners[event] ??= []).push(listener); }, sendMessage(message) { sent.push(message); } });
await listeners.session_start[0]({}, { hasUI: false });
jump = 61_000;
await new Promise((resolve) => setTimeout(resolve, 400));
for (const listener of listeners.session_shutdown ?? []) await listener({}, {});
await new Promise((resolve) => setTimeout(resolve, 100));
console.log(JSON.stringify(sent));
process.exit(0);`;

async function runPi(root: string, piSession: string) {
  const env = { ...process.env, ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: seat, ATDD_FLOW_PI_SESSION: piSession, ATDD_FLOW_HERDR_SESSION: "forge", ATDD_FLOW_HERDR_PANE: "w1:p2" };
  const child = Bun.spawn([process.execPath, "-e", hostScript], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as { customType?: string; content?: string }[];
}

test("RED 1 NOTICE: a launcher Pi whose live session differs from the binding emits exactly one inactive-mail notice naming both sessions", async () => {
  const root = await desk();
  const notices = (await runPi(root, live)).filter((message) => message.customType === "atdd-flow-mail-inactive");
  expect(notices).toHaveLength(1);
  expect(notices[0]?.content).toContain(bound);
  expect(notices[0]?.content).toContain(live);
  expect(notices[0]?.content).toContain("coordinator@demo");
  expect(notices[0]?.content).toContain(`atdd-flow pi runtime launch ${seat}`);
});

test("RED 1 NOTICE: a Pi whose live session matches the binding and receipt sends no inactive-mail notice (guard)", async () => {
  const root = await desk();
  expect((await runPi(root, bound)).filter((message) => message.customType === "atdd-flow-mail-inactive")).toHaveLength(0);
});

async function seatStatus(root: string) {
  const child = Bun.spawn([process.execPath, cli, "--root", root, "status", "seat", seat], { cwd: root, env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return `${stdout}${stderr}`;
}

const advisory = (root: string, piSession: string) =>
  registerRuntimeState(root, { seat, owner_token: "token", pid: process.pid, model: "m", cwd: root, pi_session: piSession } as never);

test("RED 2 STATUS: status seat reports native mail inactive with bound and live sessions when the fresh advisory runtime differs", async () => {
  const root = await desk();
  await advisory(root, live);
  expect(await seatStatus(root)).toContain(`native mail inactive (bound ${bound}, live ${live})`);
});

test("RED 2 STATUS: status seat is silent about mail when the advisory session matches the binding (guard)", async () => {
  const root = await desk();
  await advisory(root, bound);
  expect(await seatStatus(root)).not.toContain("native mail inactive");
});

const sessionId = live;
const sessionPath = pathFor(live);

/** Installed-Herdr fake in which the exact session path appears only after `lateByPolls` pane reads following the start. */
function lateHerdr(lateByPolls: number) {
  let started = false, polls = 0;
  const agent = "flow-driver-pi-demo";
  const shell = { pane_id: "w1:p2", agent: null, agent_status: "unknown", agent_session: null };
  const running = () => ({ pane_id: "w1:p2", agent, agent_status: "idle", agent_session: polls > lateByPolls ? { source: "pi", agent, kind: "path", value: sessionPath } : null });
  return async (command: string[]) => {
    const args = command.slice(3);
    if (args[0] === "workspace" && args[1] === "list") return JSON.stringify({ result: { workspaces: [
      { workspace_id: "w1", label: "demo", worktree: { checkout_path: "/work/primary" } },
      { workspace_id: "w2", label: seat, worktree: { checkout_path: "/work/demo" } },
    ] } });
    if (args[0] === "tab" && args[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "w2:t1", workspace_id: "w2", label: seat }] } });
    if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: "w1:p2", tab_id: "w2:t1", label: seat }] } });
    if (args[0] === "pane" && args[1] === "get") { if (started) polls += 1; return JSON.stringify({ result: { pane: started ? running() : shell } }); }
    if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: { pane_id: "w1:p2", shell_pid: 11,
      foreground_processes: started ? [{ pid: 22, name: "node", argv0: "node" }, { pid: 23, name: "pi", argv0: "pi" }] : [{ pid: 11, name: "zsh", argv0: "zsh" }] } } });
    if (args[0] === "pane" && args[1] === "run") return JSON.stringify({ result: { pane_id: "w1:p2" } });
    if (args[0] === "agent" && args[1] === "start") { started = true; return JSON.stringify({ result: { name: agent } }); }
    if (args[0] === "agent" && args[1] === "get") return JSON.stringify({ result: { agent: { name: agent, pane_id: "w1:p2", status: "idle" } } });
    throw new Error(`unexpected Herdr command: ${command.join(" ")}`);
  };
}

async function launchDesk() {
  const root = await mkdtemp(join(tmpdir(), "atdd-mail-activation-launch-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pi"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "pi"), 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi: join(bin, "pi") } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi", args: ["--model", "economy"] }] });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", repository: "/work/primary", roles: {} });
  await atomicYaml(paths(root).seatFile(seat), { schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/pi" });
  await atomicYaml(paths(root).taskFile("demo", "work"), { schema: "atdd-workflow/task/v1", title: "Work", status: "in_progress", coordinator: "coordinator@demo", assignee: seat, done_when: [{ text: "Done." }] });
  return root;
}

const select = async () => ({ available: true as const, model: "fake-jev", selected_model: "economy", confidence: 0.93 });

test("RED 3 LAUNCH: Herdr reporting the exact session path one poll late still binds the seat with a receipt", async () => {
  const root = await launchDesk();
  const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], {
    select, command: lateHerdr(1), sessionId: () => sessionId, at: () => "2026-10-22T09:41:00.000Z", sleep: async () => undefined,
  } as never);
  const record = await readYaml<Record<string, any>>(paths(root).seatFile(seat));
  expect(record.runtime).toMatchObject({ pi_session: sessionId, pi_session_path: sessionPath, launch_receipt: result.receipt });
  expect(await readYaml<Record<string, unknown>>(result.receipt)).toMatchObject({ pi_session: sessionId, pi_session_path: sessionPath });
});
