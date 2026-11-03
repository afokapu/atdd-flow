// URN: test:atdd-flow:bootstrap-main-launch
// Acceptance: acc:flow:E024-UNIT-001
// Phase: UNIT
// Purpose: A brand-new exact main seat (no runtime, no predecessor) with a recorded handover and exactly one ready self-assigned
// todo task launches a fresh Pi into its available shell pane without any fabricated Path-A request, reconciles through
// `handover resumed`, cannot launch twice, and every unsafe variant stays fail-closed without mutation.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { registerRuntimeState } from "../src/runtime-state";
import { launchPiRuntime } from "../src/seats";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const project = "fresh", address = `main@${project}`;
const pane = "wMG:p1", herdrSession = "forge", cwd = "/work/fresh";
const handover = "H-20261103T014000Z-main-fresh-bootstrap", task = "pr1-exact-head-review";
const at = "2026-11-03T02:05:00.000Z";
const roots: string[] = [];
const selectEconomy = async () => ({ available: true as const, model: "test", selected_model: "economy", confidence: 0.99 });
const mutating = (argv: string[]) => argv.some((part) => ["run", "start", "bind", "attach", "apply", "create", "rename", "close"].includes(part));

type Options = {
  runtime?: boolean;
  noHandover?: boolean;
  noTask?: boolean;
  twoReady?: boolean;
  foreignTask?: boolean;
  blockedTask?: boolean;
  branch?: string;
  targetOccupied?: boolean;
  hostPane?: string;
  invalidRequest?: boolean;
};

async function fixture(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-bootstrap-"));
  roots.push(root);
  const bin = join(root, "bin"), pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }] });
  await atomicYaml(paths(root).projectFile(project), { schema: "atdd-workflow/project/v1", project, repository: cwd, roles: {} });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project, worktree: cwd, branch: options.branch ?? "main",
    ...(options.runtime ? { runtime: { application: "herdr", wake: "native", addresses: { herdr: { session: herdrSession, pane } }, pi_session: "55555555-5555-4555-8555-555555555555" } } : {}),
  });
  if (!options.noHandover) await atomicYaml(paths(root).handoverFile(address), { schema: "atdd-workflow/handover/v1", seat: address, handover_id: handover, supersedes: "none", recorded_at: "2026-11-03T01:37:37.150Z", text: "exact handover" });
  const ready = { schema: "atdd-workflow/task/v1", title: "Review", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Reviewed." }] };
  if (!options.noTask) await atomicYaml(paths(root).taskFile(project, task), {
    ...ready, ...(options.foreignTask ? { assignee: `driver.x@${project}` } : {}), ...(options.blockedTask ? { blocker: "waiting" } : {}),
  });
  if (options.twoReady) await atomicYaml(paths(root).taskFile(project, "another-ready"), { ...ready, title: "Other" });
  if (options.invalidRequest) await atomicYaml(join(root, ".atdd-flow", "handover-replacements", "main%40fresh.yaml"), { schema: "bogus" });
  const fake = harness(options);
  const launch = (extra: string[] = []) => launchPiRuntime(root, address, ["--herdr-session", herdrSession, ...extra],
    { command: fake.command, select: selectEconomy, at: () => at, hostPane: options.hostPane });
  return { root, fake, launch, seatBefore: await readFile(paths(root).seatFile(address), "utf8") };
}

/** Fake Herdr: the target pane is an available shell until a Pi is started on it. */
function harness(options: Options) {
  const calls: string[][] = [];
  let writerPath = options.targetOccupied ? join(tmpdir(), "intruder_99999999-9999-4999-8999-999999999999.jsonl") : undefined;
  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const command = async (argv: string[]) => {
    calls.push(argv);
    const op = argv.slice(3);
    if (op[0] === "workspace" && op[1] === "list") return JSON.stringify({ result: { workspaces: [{ workspace_id: "wMG", label: project, worktree: { checkout_path: cwd } }] } });
    if (op[0] === "tab" && op[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "wMG:t1", workspace_id: "wMG", label: address }] } });
    if (op[0] === "pane" && op[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: pane, tab_id: "wMG:t1", label: address, agent: writerPath ? "pi" : null, agent_status: writerPath ? "idle" : "unknown" }] } });
    if (op[0] === "pane" && op[1] === "get") return JSON.stringify({ result: { pane: writerPath
      ? { pane_id: pane, agent: "pi", agent_status: "idle", agent_session: session(writerPath), cwd, label: address }
      : { pane_id: pane, agent: null, agent_status: "unknown", agent_session: null, cwd, label: address } } });
    if (op[0] === "pane" && op[1] === "process-info") return JSON.stringify({ result: { process_info: { pane_id: pane, shell_pid: 42,
      foreground_processes: writerPath ? [{ name: "node", argv0: "pi", pid: 100, cwd }] : [{ name: "zsh", argv0: "zsh", pid: 42, cwd }] } } });
    if (op[0] === "agent" && op[1] === "get") return JSON.stringify({ result: { agent: { name: "flow-main-fresh", agent: "pi", pane_id: pane, agent_status: "idle", agent_session: session(writerPath!), cwd } } });
    if (op[0] === "pane" && op[1] === "run") return JSON.stringify({ result: { pane_id: pane } });
    if (op[0] === "agent" && op[1] === "start") {
      const args = op.slice(op.indexOf("--") + 1);
      writerPath = join(tmpdir(), `fresh_${args[args.indexOf("--session-id") + 1]}.jsonl`);
      await writeFile(writerPath, '{"type":"session"}\n');
      return JSON.stringify({ result: { name: "flow-main-fresh" } });
    }
    throw new Error(`Unexpected Herdr command: ${argv.join(" ")}`);
  };
  return { command, calls };
}

async function resumed(root: string) {
  const child = Bun.spawn([process.execPath, cli, "handover", "resumed", address], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ATDD_WORKFLOW_ROOT: root } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function refusedUnchanged(options: Options, match: string) {
  const value = await fixture(options);
  const mutationsBefore = value.fake.calls.filter(mutating).length;
  const error = await value.launch().then(() => undefined, (cause: Error) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toContain(match);
  expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(value.seatBefore);
  expect(value.fake.calls.filter(mutating).length).toBe(mutationsBefore);
}

test("RED: a brand-new exact main seat launches into its shell pane with no Path-A request and reconciles RESUMED", async () => {
  const value = await fixture();
  const dry = await value.launch(["--dry-run"]);
  expect(dry.pane).toBe(pane);
  expect(value.fake.calls.some(mutating)).toBe(false);
  expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(value.seatBefore);

  const launched = await value.launch();
  const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(address));
  expect(seat.runtime).toMatchObject({ pi_session: launched.piSession, addresses: { herdr: { session: herdrSession, pane } }, launch_receipt: launched.receipt });
  const receipt = await readYaml<Record<string, any>>(launched.receipt);
  expect(receipt).toMatchObject({ seat: address, tasks: [task], pi_session: launched.piSession, bootstrap_launch: { handover: { id: handover }, task } });
  // No predecessor tuple is fabricated.
  expect(receipt.handover_replacement).toBeUndefined();
  expect(await Bun.file(join(value.root, ".atdd-flow", "handover-replacements", "main%40fresh.yaml")).exists()).toBe(false);

  await registerRuntimeState(value.root, { seat: address, owner_token: `owner-${launched.piSession}`, pid: 84314, model: "economy", cwd }, at);
  const result = await resumed(value.root);
  expect(result.output).toContain("RESUMED; verified 5/5; discrepancies: none.");
  expect(result.exitCode).toBe(0);
}, 60_000);

test("a bootstrap launch happens once: the recorded runtime makes a second launch fail closed", async () => {
  const value = await fixture();
  await value.launch();
  await expect(value.launch()).rejects.toThrow("requires one validated Path-A replacement request");
});

test("bootstrap resumed fails closed without a fresh heartbeat", async () => {
  const value = await fixture();
  await value.launch();
  const result = await resumed(value.root);
  expect(result.output).toContain("fresh heartbeat");
  expect(result.exitCode).not.toBe(0);
});

const refusal = "requires one validated Path-A replacement request";
test("fail-closed: a recorded runtime is not a bootstrap", async () => { await refusedUnchanged({ runtime: true }, refusal); });
test("fail-closed: no recorded handover", async () => { await refusedUnchanged({ noHandover: true }, refusal); });
test("fail-closed: no ready task", async () => { await refusedUnchanged({ noTask: true }, refusal); });
test("fail-closed: a blocked task is not ready", async () => { await refusedUnchanged({ blockedTask: true }, refusal); });
test("fail-closed: a task assigned to another seat is not a self-assigned main task", async () => { await refusedUnchanged({ foreignTask: true }, refusal); });
test("fail-closed: two ready tasks", async () => { await refusedUnchanged({ twoReady: true }, refusal); });
test("fail-closed: a seat off the exact main topology", async () => { await refusedUnchanged({ branch: "feature" }, "launch-eligible"); });
test("fail-closed: an invalid request file is never treated as a bootstrap", async () => { await refusedUnchanged({ invalidRequest: true }, refusal); });
test("fail-closed: target pane occupied by a Pi", async () => { await refusedUnchanged({ targetOccupied: true }, "available shell"); });
test("fail-closed: host pane is the target pane", async () => { await refusedUnchanged({ hostPane: pane }, "different pane"); });
