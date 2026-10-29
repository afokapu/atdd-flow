// URN: test:atdd-flow:stale-main-source-exited-path-a
// Acceptance: acc:flow:E021-UNIT-001
// Phase: UNIT
// Purpose: An active Path-A request that exactly matches the stale recorded runtime is replaceable by --recover-stale-main
// only when its recorded source Pi has provably exited; a live source and every other refusal stay enforced.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml, seat as readSeat } from "../src/core";
import { handoverReplacementPath, replacementForMainLaunch, requestHandoverReplacement, type HandoverReplacementRequest } from "../src/handover";

const project = "exit-demo", address = `main@${project}`;
const pane = "w9:p1", herdrSession = "forge", cwd = "/work/exit-demo";
const staleSession = "11111111-1111-4111-8111-111111111111";
const liveSession = "22222222-2222-4222-8222-222222222222";
const handover = "H-20261029T100000Z-main-exit-demo-successor", takeover = "main-takeover-20261029";
const authorizationId = "A-source-exited-path-a-20261029";
const verifiedAt = "2026-10-29T10:05:00.000Z";
const roots: string[] = [];

/** "matching" names the recorded stale runtime as the active request's source; "older" names an unrelated old Pi. */
type Existing = "matching" | "older" | undefined;
type Evidence = { staleStillListed: boolean; malformedList: boolean; authorize: boolean };

async function fixture(existing: Existing, evidence: Partial<Evidence> = {}) {
  const options: Evidence = { staleStillListed: false, malformedList: false, authorize: true, ...evidence };
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-source-exited-"));
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
  const receipt = join(root, ".atdd-flow", "runtime-launch", `${staleSession}-receipt.yaml`);
  await atomicYaml(receipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, tasks: [takeover], candidate: "economy",
    pi_session: staleSession, pi_session_path: stalePath, herdr_session: herdrSession, pane, created_at: "2026-10-20T08:00:01.000Z",
  });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project, worktree: cwd, branch: "main",
    runtime: { application: "herdr", wake: "native", addresses: { herdr: { session: herdrSession, pane } }, pi_session: staleSession, pi_session_path: stalePath, launch_receipt: receipt },
  });
  await atomicYaml(paths(root).handoverFile(address), { schema: "atdd-workflow/handover/v1", seat: address, handover_id: handover, supersedes: "none", recorded_at: "2026-10-29T10:00:00.000Z", text: "exact handover" });
  await atomicYaml(paths(root).taskFile(project, takeover), { schema: "atdd-workflow/task/v1", title: "Main takeover", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Recovered." }] });
  if (options.authorize) {
    await createExactSessionAdoptionAuthorization(root, authorizationId, [
      "--by", "operator@desk", "--seat", address, "--pi-session", liveSession, "--pi-session-path", livePath,
      "--source-herdr-session", herdrSession, "--source-pane", pane, "--target-herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", cwd,
    ]);
  }
  const active = handoverReplacementPath(root, address);
  if (existing) {
    const session = existing === "matching" ? staleSession : "33333333-3333-4333-8333-333333333333";
    const path = existing === "matching" ? stalePath : join(root, `old_${session}.jsonl`);
    await atomicYaml(active, {
      schema: "atdd-flow/context-handover-replacement-request/v1", seat: address, task: "older-takeover",
      handover: { id: "H-older", sha256: "1".repeat(64) }, authorization: { id: "A-older", hash: "2".repeat(64) },
      source: { pi_session: session, pi_session_path: path, herdr_session: herdrSession, pane },
      target: { herdr_session: herdrSession, pane, cwd }, created_at: "2026-10-26T08:00:00.000Z",
    });
  }
  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const agent = (value: string, agentPane: string) => ({ name: "flow-main-exit-demo", agent: "pi", pane_id: agentPane, agent_status: "idle", agent_session: session(value), cwd });
  const calls: string[][] = [];
  const command = async (argv: string[]) => {
    calls.push(argv);
    const op = argv.slice(3);
    if (op[0] === "pane" && op[1] === "get") return JSON.stringify({ result: { pane: { pane_id: pane, agent: "pi", agent_status: "idle", agent_session: session(livePath), cwd } } });
    if (op[0] === "agent" && op[1] === "get") return JSON.stringify({ result: { agent: agent(livePath, pane) } });
    if (op[0] === "pane" && op[1] === "process-info") return JSON.stringify({ result: { process_info: { pane_id: pane, shell_pid: 42, foreground_processes: [{ name: "node", argv0: "pi", pid: 100, cwd }] } } });
    if (op[0] === "agent" && op[1] === "list") {
      if (options.malformedList) return JSON.stringify({ result: {} });
      return JSON.stringify({ result: { agents: [agent(livePath, pane), ...(options.staleStillListed ? [agent(stalePath, "w9:p2")] : [])] } });
    }
    throw new Error(`Unexpected Herdr command: ${argv.join(" ")}`);
  };
  const args = ["--recover-stale-main", "--handover", handover, "--authorization", authorizationId, "--takeover-task", takeover,
    "--source-pi-session", liveSession, "--source-pi-session-path", livePath, "--source-herdr-session", herdrSession, "--source-pane", pane,
    "--herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", cwd];
  const recover = () => requestHandoverReplacement(root, address, args, { command, at: () => verifiedAt });
  const before = existing ? await readFile(active, "utf8") : undefined;
  return { root, receipt, stalePath, livePath, active, before, recover, calls, seatBefore: await readFile(paths(root).seatFile(address), "utf8"), receiptBefore: await readFile(receipt, "utf8") };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const mutating = (argv: string[]) => argv.some((part) => ["run", "start", "bind", "attach", "apply", "create", "rename", "close"].includes(part));

async function refusedUnchanged(value: Awaited<ReturnType<typeof fixture>>, match: string) {
  const error = await value.recover().then(() => undefined, (cause: Error) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toContain(match);
  expect(await readFile(value.active, "utf8")).toBe(value.before!);
  expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(value.seatBefore);
  expect(value.calls.some(mutating)).toBe(false);
}

test("RED: an active request matching the stale runtime whose source Pi has exited is replaced, archived by hash with source-exit evidence", async () => {
  const value = await fixture("matching");
  // The exact stale recorded source is absent from the global Pi agent list, yet the matching request is treated as live.
  await value.recover();
  const request = await readYaml<HandoverReplacementRequest & { stale_main_recovery: Record<string, any> }>(value.active);
  const prior = request.stale_main_recovery.prior_request;
  expect(request).toMatchObject({ task: takeover, source: { pi_session: liveSession, pi_session_path: value.livePath }, stale_main_recovery: { canonical_source: { pi_session: staleSession } } });
  expect(prior.path).toBe(value.active);
  expect(await readFile(prior.archive, "utf8")).toBe(value.before!);
  expect(prior.archive.endsWith(`${prior.sha256}.yaml`)).toBe(true);
  expect(prior.source_exited).toMatchObject({ pi_session: staleSession, pi_session_path: value.stalePath, herdr_session: herdrSession, pane, verified_at: verifiedAt });
  // Evidence-only: seat binding and stale receipt untouched, no Herdr mutation, and the new request matches the still-stale binding.
  expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(value.seatBefore);
  expect(await readFile(value.receipt, "utf8")).toBe(value.receiptBefore);
  expect(value.calls.some(mutating)).toBe(false);
  expect(await replacementForMainLaunch(value.root, await readSeat(value.root, address), address)).toMatchObject({ request: { task: takeover } });
});

test("a matching active request whose source Pi is still listed as live stays rejected and untouched", async () => {
  const value = await fixture("matching", { staleStillListed: true });
  await refusedUnchanged(value, "still a live Pi agent");
});

test("a matching active request with incomplete global agent-list evidence stays rejected and untouched", async () => {
  const value = await fixture("matching", { malformedList: true });
  await refusedUnchanged(value, "complete global Herdr agent-list evidence");
});

test("a matching active request without the exact operator authorization stays rejected and untouched", async () => {
  const value = await fixture("matching", { authorize: false });
  await refusedUnchanged(value, "operator authorization record");
});

test("a non-matching stale active request is still replaced and archived without source-exit evidence", async () => {
  const value = await fixture("older");
  await value.recover();
  const request = await readYaml<HandoverReplacementRequest & { stale_main_recovery: Record<string, any> }>(value.active);
  const prior = request.stale_main_recovery.prior_request;
  expect(await readFile(prior.archive, "utf8")).toBe(value.before!);
  expect(prior.source_exited).toBeUndefined();
});
