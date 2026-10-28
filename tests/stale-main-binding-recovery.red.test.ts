// URN: test:atdd-flow:stale-main-binding-recovery
// Acceptance: acc:flow:E021-UNIT-001
// Phase: UNIT
// Purpose: A main seat whose recorded Pi session/path is stale, while a newer Pi lives in the exact canonical
// pane/worktree, has one supported operator-authorized recovery that reuses exact-adoption and Path-A primitives.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml, seat as readSeat } from "../src/core";
import { replacementForMainLaunch, requestHandoverReplacement, type HandoverReplacementRequest } from "../src/handover";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const projectName = "stale-demo", address = `main@${projectName}`;
const staleSession = "11111111-1111-4111-8111-111111111111";
const stalePath = `/sessions/--stale--/2026-10-20T08-00-00-000Z_${staleSession}.jsonl`;
const liveSession = "22222222-2222-4222-8222-222222222222";
const livePath = `/sessions/--stale--/2026-10-27T09-00-00-000Z_${liveSession}.jsonl`;
const pane = "w9:p1", cwd = "/work/stale-demo";
const handover = "H-20261027T100000Z-main-stale-demo-successor", takeover = "main-takeover-20261027";
const authorizationId = "A-stale-main-recovery-20261027";
const recoverFlag = "--recover-stale-main";

type Live = { sessionPath: string; pane: string; cwd: string; staleAlsoLive: boolean };

/** Plain launched main: recorded runtime has NO prior Path-A request/receipt history (not a consumed replacement). */
async function fixture(live: Partial<Live> = {}, authorize = true) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-stale-main-"));
  const bin = join(root, "bin"), pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }] });
  await atomicYaml(paths(root).projectFile(projectName), { schema: "atdd-workflow/project/v1", project: projectName, repository: cwd, roles: {} });
  const receipt = join(root, ".atdd-flow", "runtime-launch", `${staleSession}-receipt.yaml`);
  await atomicYaml(receipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, tasks: [takeover], candidate: "economy",
    pi_session: staleSession, pi_session_path: stalePath, herdr_session: "forge", pane, created_at: "2026-10-20T08:00:01.000Z",
  });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project: projectName, worktree: cwd, branch: "main",
    runtime: { application: "herdr", wake: "native", addresses: { herdr: { session: "forge", pane } },
      pi_session: staleSession, pi_session_path: stalePath, launch_receipt: receipt },
  });
  const text = `HANDOVER ${address} | 2026-10-27T10:00:00Z | handover-id ${handover} | supersedes none\nRuntime: herdr forge:${pane} | pi session ${liveSession} | model test/pi | context 80%\n\n1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS\n- exact\n\n2. OPEN WORK AND IN-FLIGHT OPERATIONS\n- exact\n\n3. DEPENDENCIES (both directions)\n- none\n\n4. RESUME PROCEDURE AND NEXT ACTIONS\n- exact\n`;
  await atomicYaml(paths(root).handoverFile(address), { schema: "atdd-workflow/handover/v1", seat: address, handover_id: handover, supersedes: "none", recorded_at: "2026-10-27T10:00:00.000Z", text });
  await atomicYaml(paths(root).taskFile(projectName, takeover), {
    schema: "atdd-workflow/task/v1", title: "Main takeover", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Recovered." }],
  });
  if (authorize) {
    await createExactSessionAdoptionAuthorization(root, authorizationId, [
      "--by", "operator@desk", "--seat", address, "--pi-session", liveSession, "--pi-session-path", livePath,
      "--source-herdr-session", "forge", "--source-pane", pane, "--target-herdr-session", "forge", "--target-pane", pane, "--target-cwd", cwd,
    ]);
  }
  const reports: Live = { sessionPath: livePath, pane, cwd, staleAlsoLive: false, ...live };
  const calls: string[][] = [];
  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const agent = (value: string, agentPane: string) => ({ name: "flow-main-stale-demo", agent: "pi", pane_id: agentPane, agent_status: "idle", agent_session: session(value), cwd: reports.cwd });
  const command = async (argv: string[]) => {
    calls.push(argv);
    const operation = argv.slice(3);
    if (operation[0] === "pane" && operation[1] === "get") return JSON.stringify({ result: { pane: { pane_id: reports.pane, agent: "pi", agent_status: "idle", agent_session: session(reports.sessionPath), cwd: reports.cwd } } });
    if (operation[0] === "agent" && operation[1] === "get") return JSON.stringify({ result: { agent: agent(reports.sessionPath, reports.pane) } });
    if (operation[0] === "agent" && operation[1] === "list") return JSON.stringify({ result: { agents: [agent(reports.sessionPath, reports.pane), ...(reports.staleAlsoLive ? [agent(stalePath, "w9:p2")] : [])] } });
    if (operation[0] === "pane" && operation[1] === "process-info") return JSON.stringify({ result: { process_info: { pane_id: pane, shell_pid: 42, foreground_processes: [{ name: "node", argv0: "pi", pid: 100, cwd: reports.cwd }] } } });
    throw new Error(`Unexpected Herdr command: ${argv.join(" ")}`);
  };
  const args = [recoverFlag, "--handover", handover, "--authorization", authorizationId, "--takeover-task", takeover,
    "--source-pi-session", liveSession, "--source-pi-session-path", livePath, "--source-herdr-session", "forge", "--source-pane", pane,
    "--herdr-session", "forge", "--target-pane", pane, "--target-cwd", cwd];
  return { root, receipt, args, command, calls, active: join(root, ".atdd-flow", "handover-replacements", encodeURIComponent(address) + ".yaml") };
}

async function invokeAtRoot(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ATDD_WORKFLOW_ROOT: root } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

/** A refusal only counts when the recovery flag was understood; a usage error is the missing feature, not the gate. */
async function refused(value: Awaited<ReturnType<typeof fixture>>, match?: string) {
  const error = await requestHandoverReplacement(value.root, address, value.args, { command: value.command }).then(() => undefined, (cause: Error) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).not.toContain("Use `handover replace");
  if (match) expect(error!.message).toContain(match);
  expect(await Bun.file(value.active).exists()).toBe(false);
  expect(value.calls.some(mutating)).toBe(false);
}

const mutating = (argv: string[]) => argv.some((part) => ["run", "start", "bind", "attach", "apply", "create", "rename", "close"].includes(part));

test("RED: help exposes the explicit stale-main recovery flag", async () => {
  const { output } = await invokeAtRoot(tmpdir(), "--help");
  expect(output).toContain(`handover replace <address> [--supersede-consumed] [${recoverFlag}]`);
});

test("RED: stale recorded main session versus newer live Pi in the exact canonical pane/worktree is recoverable only through the operator-authorized request", async () => {
  const value = await fixture();
  try {
    const seatBefore = await readFile(paths(value.root).seatFile(address), "utf8");
    const receiptBefore = await readFile(value.receipt, "utf8");
    // Baseline (proves the gap): neither existing primitive can bridge stale X -> live Y.
    await expect(requestHandoverReplacement(value.root, address, value.args.filter((arg) => arg !== recoverFlag), { command: value.command }))
      .rejects.toThrow("exactly match the recorded live runtime");
    // Recovery request: records the exact live source and the stale canonical source it supersedes.
    await requestHandoverReplacement(value.root, address, value.args, { command: value.command });
    const request = await readYaml<HandoverReplacementRequest & { stale_main_recovery?: Record<string, any> }>(value.active);
    expect(request).toMatchObject({
      task: takeover, authorization: { id: authorizationId },
      source: { pi_session: liveSession, pi_session_path: livePath, herdr_session: "forge", pane },
      target: { herdr_session: "forge", pane, cwd },
      stale_main_recovery: {
        canonical_source: { pi_session: staleSession, pi_session_path: stalePath, herdr_session: "forge", pane, cwd },
        live_source: { pi_session: liveSession, pi_session_path: livePath, herdr_session: "forge", pane, cwd },
      },
    });
    // Recording is evidence-only: no hand-edited binding, no Herdr mutation, stale receipt untouched.
    expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(seatBefore);
    expect(await readFile(value.receipt, "utf8")).toBe(receiptBefore);
    // Existing main-launch eligibility accepts the recovery request against the still-stale binding.
    const record = await readSeat(value.root, address);
    expect(await replacementForMainLaunch(value.root, record, address)).toMatchObject({ request: { task: takeover } });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("RED: recovery refuses without an exact operator authorization record", async () => {
  const value = await fixture({}, false);
  try {
    await refused(value, "operator authorization record");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("RED: recovery refuses live evidence that is not the exact canonical pane/worktree/session, or when the stale session is still live", async () => {
  for (const live of [{ cwd: "/elsewhere" }, { sessionPath: stalePath }, { staleAlsoLive: true }] as Partial<Live>[]) {
    const value = await fixture(live);
    try {
      await refused(value);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});
