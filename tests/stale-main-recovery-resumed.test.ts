// URN: test:atdd-flow:stale-main-recovery-resumed
// Acceptance: acc:flow:E021-UNIT-001
// Phase: UNIT
// Purpose: Stale-main recovery is carried through exact adoption to a verified RESUMED successor, fail-closed on damaged evidence.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml } from "../src/core";
import { handoverReplacementPath, requestHandoverReplacement, type HandoverReplacementRequest } from "../src/handover";
import { registerRuntimeState } from "../src/runtime-state";
import { launchPiRuntime } from "../src/seats";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const project = "stale-demo", address = `main@${project}`;
const pane = "w9:p1", herdrSession = "forge", cwd = "/work/stale-demo";
const staleSession = "11111111-1111-4111-8111-111111111111";
const liveSession = "22222222-2222-4222-8222-222222222222";
const handover = "H-20261027T100000Z-main-stale-demo-successor", takeover = "main-takeover-20261027";
const authorizationId = "A-stale-main-resumed-20261027";
const roots: string[] = [];
const selectEconomy = async () => ({ available: true as const, model: "test", selected_model: "economy", confidence: 0.99 });

async function resumed(root: string) {
  const child = Bun.spawn([process.execPath, cli, "handover", "resumed", address], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ATDD_WORKFLOW_ROOT: root } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

/** Fake Herdr: a live Pi on `writerPath` until released; a started agent continues the requested session path. */
function harness(root: string, live: string) {
  let writerPath: string | undefined = live;
  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const command = async (argv: string[]) => {
    const op = argv.slice(3), agent = (path: string) => ({ name: "flow-main-stale-demo", agent: "pi", pane_id: pane, agent_status: "idle", agent_session: session(path), cwd });
    if (op[0] === "workspace" && op[1] === "list") return JSON.stringify({ result: { workspaces: [{ workspace_id: "w9", label: project, worktree: { checkout_path: cwd } }] } });
    if (op[0] === "tab" && op[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "w9:t1", workspace_id: "w9", label: address }] } });
    if (op[0] === "pane" && op[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: pane, tab_id: "w9:t1", label: address, agent: writerPath ? "pi" : null, agent_status: writerPath ? "idle" : "unknown" }] } });
    if (op[0] === "pane" && op[1] === "get") return JSON.stringify({ result: { pane: writerPath
      ? { pane_id: pane, agent: "pi", agent_status: "idle", agent_session: session(writerPath), cwd, label: address }
      : { pane_id: pane, agent: null, agent_status: "unknown", agent_session: null, cwd, label: address } } });
    if (op[0] === "pane" && op[1] === "process-info") return JSON.stringify({ result: { process_info: { pane_id: pane, shell_pid: 42,
      foreground_processes: writerPath ? [{ name: "node", argv0: "pi", pid: 100, cwd }] : [{ name: "zsh", argv0: "zsh", pid: 42, cwd }] } } });
    if (op[0] === "agent" && op[1] === "get") return JSON.stringify({ result: { agent: agent(writerPath!) } });
    if (op[0] === "agent" && op[1] === "list") return JSON.stringify({ result: { agents: writerPath ? [agent(writerPath)] : [] } });
    if (op[0] === "pane" && op[1] === "run") return JSON.stringify({ result: { pane_id: pane } });
    if (op[0] === "agent" && op[1] === "start") {
      const args = op.slice(op.indexOf("--") + 1);
      writerPath = args[args.indexOf("--session") + 1];
      return JSON.stringify({ result: { name: "flow-main-stale-demo" } });
    }
    throw new Error(`Unexpected Herdr command: ${argv.join(" ")}`);
  };
  return { command, release: () => { writerPath = undefined; } };
}

/** An active Path-A request already on the Desk: "stale" names a Pi the runtime no longer records; "live" matches the recorded runtime. */
type Existing = "stale" | "live";

async function recovered(existing?: Existing) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-stale-resumed-"));
  roots.push(root);
  const bin = join(root, "bin"), pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }] });
  await atomicYaml(paths(root).projectFile(project), { schema: "atdd-workflow/project/v1", project, repository: cwd, roles: {} });
  const stalePath = join(root, `stale_${staleSession}.jsonl`), livePath = join(root, `live_${liveSession}.jsonl`);
  await writeFile(livePath, '{"type":"session"}\n');
  const staleReceipt = join(root, ".atdd-flow", "runtime-launch", `${staleSession}-receipt.yaml`);
  await atomicYaml(staleReceipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, tasks: [takeover], candidate: "economy",
    pi_session: staleSession, pi_session_path: stalePath, herdr_session: herdrSession, pane, created_at: "2026-10-20T08:00:01.000Z",
  });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project, worktree: cwd, branch: "main",
    runtime: { application: "herdr", wake: "native", addresses: { herdr: { session: herdrSession, pane } }, pi_session: staleSession, pi_session_path: stalePath, launch_receipt: staleReceipt },
  });
  await atomicYaml(paths(root).handoverFile(address), { schema: "atdd-workflow/handover/v1", seat: address, handover_id: handover, supersedes: "none", recorded_at: "2026-10-27T10:00:00.000Z", text: "exact handover" });
  await atomicYaml(paths(root).taskFile(project, takeover), { schema: "atdd-workflow/task/v1", title: "Main takeover", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Recovered." }] });
  await createExactSessionAdoptionAuthorization(root, authorizationId, [
    "--by", "operator@desk", "--seat", address, "--pi-session", liveSession, "--pi-session-path", livePath,
    "--source-herdr-session", herdrSession, "--source-pane", pane, "--target-herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", cwd,
  ]);
  const fake = harness(root, livePath);
  if (existing) {
    const session = existing === "live" ? staleSession : "33333333-3333-4333-8333-333333333333";
    const path = existing === "live" ? stalePath : join(root, `old_${session}.jsonl`);
    await atomicYaml(handoverReplacementPath(root, address), {
      schema: "atdd-flow/context-handover-replacement-request/v1", seat: address, task: "older-takeover",
      handover: { id: "H-older", sha256: "1".repeat(64) }, authorization: { id: "A-older", hash: "2".repeat(64) },
      source: { pi_session: session, pi_session_path: path, herdr_session: herdrSession, pane },
      target: { herdr_session: herdrSession, pane, cwd }, created_at: "2026-10-26T08:00:00.000Z",
    });
  }
  const before = existing ? await readFile(handoverReplacementPath(root, address), "utf8") : undefined;
  await requestHandoverReplacement(root, address, [
    "--recover-stale-main", "--handover", handover, "--authorization", authorizationId, "--takeover-task", takeover,
    "--source-pi-session", liveSession, "--source-pi-session-path", livePath, "--source-herdr-session", herdrSession, "--source-pane", pane,
    "--herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", cwd,
  ], { command: fake.command, at: () => "2026-10-27T10:05:00.000Z" }).catch((error: Error) => { if (existing !== "live") throw error; });
  const active = handoverReplacementPath(root, address);
  const request = await readYaml<HandoverReplacementRequest>(active);
  return { root, fake, livePath, staleReceipt, before, staleBytes: await readFile(staleReceipt, "utf8"), active, request };
}

async function adopt(value: Awaited<ReturnType<typeof recovered>>) {
  value.fake.release();
  const launched = await launchPiRuntime(value.root, address, [
    "--pane", pane, "--herdr-session", herdrSession, "--adopt-session", value.livePath,
    "--source-herdr-session", herdrSession, "--source-pane", pane, "--authorization", authorizationId,
  ], { command: value.fake.command, select: selectEconomy, at: () => "2026-10-27T10:10:00.000Z" });
  await registerRuntimeState(value.root, { seat: address, owner_token: `owner-${liveSession}`, pid: 84314, model: "economy", cwd }, "2026-10-27T10:11:00.000Z");
  return launched;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("stale-main recovery adopts the live Pi after source release and reconciles RESUMED 6/6 with the stale receipt archived", async () => {
  const value = await recovered();
  const launched = await adopt(value);
  const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(address));
  expect(seat.runtime).toMatchObject({ pi_session: liveSession, pi_session_path: value.livePath, launch_receipt: launched.receipt });
  const receipt = await readYaml<Record<string, any>>(launched.receipt);
  expect(receipt).toMatchObject({ pi_session: liveSession, handover_replacement: { request: value.request, successor_session: liveSession }, relocation: { authorization: { id: authorizationId } } });
  expect(await readFile(value.request.stale_main_recovery!.prior_receipt.archive, "utf8")).toBe(value.staleBytes);
  expect(await readFile(value.staleReceipt, "utf8")).toBe(value.staleBytes);
  const result = await resumed(value.root);
  expect(result.output).toContain("RESUMED; verified 6/6; discrepancies: none.");
  expect(result.exitCode).toBe(0);
});

test("stale-main recovery cannot be verified RESUMED when the archived stale receipt is damaged or the authorization is reused", async () => {
  const damaged = await recovered();
  await adopt(damaged);
  await writeFile(damaged.request.stale_main_recovery!.prior_receipt.archive, "tampered\n");
  expect(await resumed(damaged.root)).toMatchObject({ exitCode: 1 });
  const reused = await recovered();
  await adopt(reused);
  const result = await resumed(reused.root);
  expect(result.exitCode).toBe(0);
  await expect(launchPiRuntime(reused.root, address, [
    "--pane", pane, "--herdr-session", herdrSession, "--adopt-session", reused.livePath,
    "--source-herdr-session", herdrSession, "--source-pane", pane, "--authorization", authorizationId, "--dry-run",
  ], { command: reused.fake.command, select: selectEconomy })).rejects.toThrow();
});

test("stale-main recovery replaces a stale active request, archives it by hash, and still reconciles RESUMED 6/6", async () => {
  const value = await recovered("stale");
  const prior = value.request.stale_main_recovery!.prior_request!;
  expect(prior.path).toBe(value.active);
  expect(await readFile(prior.archive, "utf8")).toBe(value.before!);
  expect(value.request).toMatchObject({ task: takeover, source: { pi_session: liveSession } });
  await adopt(value);
  const result = await resumed(value.root);
  expect(result.output).toContain("RESUMED; verified 6/6; discrepancies: none.");
  await writeFile(prior.archive, "tampered\n");
  expect(await resumed(value.root)).toMatchObject({ exitCode: 1 });
});

test("stale-main recovery never replaces an active request that still matches the recorded runtime", async () => {
  const value = await recovered("live");
  expect(await readFile(value.active, "utf8")).toBe(value.before!);
});
