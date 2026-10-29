// URN: test:atdd-flow:stale-main-s1-exited-recovery
// Acceptance: acc:flow:E021-UNIT-001
// Phase: UNIT
// Purpose: S0 (stale recorded runtime) -> active stale_main_recovery request R1 from live source S1 -> S1 exits -> S2 holds the
// canonical pane. --recover-stale-main replaces R1 by S2 only when S1 is provably absent from complete global Pi agent evidence;
// every other refusal stays enforced.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml, seat as readSeat } from "../src/core";
import { handoverReplacementPath, replacementForMainLaunch, requestHandoverReplacement, type HandoverReplacementRequest } from "../src/handover";
import { registerRuntimeState } from "../src/runtime-state";
import { launchPiRuntime } from "../src/seats";

const project = "chain-demo", address = `main@${project}`;
const pane = "w9:p1", herdrSession = "forge", cwd = "/work/chain-demo";
const s0 = "11111111-1111-4111-8111-111111111111", s1 = "22222222-2222-4222-8222-222222222222", s2 = "33333333-3333-4333-8333-333333333333";
const handover = "H-20261029T100000Z-main-chain-demo-successor", takeover = "main-takeover-20261029";
const verifiedAt = "2026-10-29T10:05:00.000Z";
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const roots: string[] = [];

type Evidence = { s1StillListed: boolean; malformedList: boolean; authorizeS2: boolean };
type Who = "s1" | "s2";
/** What the fake Herdr reports: the Pi in the canonical pane (or none once released), plus Pis listed elsewhere. */
type Occupancy = { writer?: string; extra?: string[]; malformed?: boolean };
const selectEconomy = async () => ({ available: true as const, model: "test", selected_model: "economy", confidence: 0.99 });
const agentListCall = (argv: string[]) => argv.slice(3, 5).join(" ") === "agent list";

async function desk(authorizeS2 = true, existingS0Request = false) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-s1-exited-"));
  roots.push(root);
  const bin = join(root, "bin"), pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }] });
  await atomicYaml(paths(root).projectFile(project), { schema: "atdd-workflow/project/v1", project, repository: cwd, roles: {} });
  const file = (id: string) => join(root, `${id === s0 ? "stale" : id === s1 ? "one" : "two"}_${id}.jsonl`);
  for (const id of [s1, s2]) await writeFile(file(id), '{"type":"session"}\n');
  const receipt = join(root, ".atdd-flow", "runtime-launch", `${s0}-receipt.yaml`);
  await atomicYaml(receipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, tasks: [takeover], candidate: "economy",
    pi_session: s0, pi_session_path: file(s0), herdr_session: herdrSession, pane, created_at: "2026-10-20T08:00:01.000Z",
  });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project, worktree: cwd, branch: "main",
    runtime: { application: "herdr", wake: "native", addresses: { herdr: { session: herdrSession, pane } }, pi_session: s0, pi_session_path: file(s0), launch_receipt: receipt },
  });
  await atomicYaml(paths(root).handoverFile(address), { schema: "atdd-workflow/handover/v1", seat: address, handover_id: handover, supersedes: "none", recorded_at: "2026-10-29T10:00:00.000Z", text: "exact handover" });
  const task = (status: string) => atomicYaml(paths(root).taskFile(project, takeover), { schema: "atdd-workflow/task/v1", title: "Main takeover", status, coordinator: address, assignee: address, done_when: [{ text: "Recovered." }] });
  await task("todo");
  const active = handoverReplacementPath(root, address);
  if (existingS0Request) {
    await atomicYaml(active, {
      schema: "atdd-flow/context-handover-replacement-request/v1", seat: address, task: "older-takeover",
      handover: { id: "H-older", sha256: "1".repeat(64) }, authorization: { id: "A-older", hash: "2".repeat(64) },
      source: { pi_session: s0, pi_session_path: file(s0), herdr_session: herdrSession, pane },
      target: { herdr_session: herdrSession, pane, cwd }, created_at: "2026-10-26T08:00:00.000Z",
    });
  }
  const authorize = (id: string, authorization: string) => createExactSessionAdoptionAuthorization(root, authorization, [
    "--by", "operator@desk", "--seat", address, "--pi-session", id, "--pi-session-path", file(id),
    "--source-herdr-session", herdrSession, "--source-pane", pane, "--target-herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", cwd,
  ]);
  await authorize(s1, "A-s1-20261029");
  if (authorizeS2) await authorize(s2, "A-s2-20261029");

  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const calls: string[][] = [];
  const state: Required<Occupancy> = { writer: file(s1), extra: [], malformed: false };
  const command = async (argv: string[]) => {
    calls.push(argv);
    const op = argv.slice(3), agent = (path: string, agentPane = pane) => ({ name: "flow-main-chain-demo", agent: "pi", pane_id: agentPane, agent_status: "idle", agent_session: session(path), cwd });
    if (op[0] === "workspace" && op[1] === "list") return JSON.stringify({ result: { workspaces: [{ workspace_id: "w9", label: project, worktree: { checkout_path: cwd } }] } });
    if (op[0] === "tab" && op[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "w9:t1", workspace_id: "w9", label: address }] } });
    if (op[0] === "pane" && op[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: pane, tab_id: "w9:t1", label: address, agent: state.writer ? "pi" : null, agent_status: state.writer ? "idle" : "unknown" }] } });
    if (op[0] === "pane" && op[1] === "get") return JSON.stringify({ result: { pane: state.writer
      ? { pane_id: pane, agent: "pi", agent_status: "idle", agent_session: session(state.writer), cwd, label: address }
      : { pane_id: pane, agent: null, agent_status: "unknown", agent_session: null, cwd, label: address } } });
    if (op[0] === "pane" && op[1] === "process-info") return JSON.stringify({ result: { process_info: { pane_id: pane, shell_pid: 42,
      foreground_processes: state.writer ? [{ name: "node", argv0: "pi", pid: 100, cwd }] : [{ name: "zsh", argv0: "zsh", pid: 42, cwd }] } } });
    if (op[0] === "agent" && op[1] === "get") return JSON.stringify({ result: { agent: agent(state.writer!) } });
    if (op[0] === "agent" && op[1] === "list") {
      if (state.malformed) return JSON.stringify({ result: {} });
      return JSON.stringify({ result: { agents: [...(state.writer ? [agent(state.writer)] : []), ...state.extra.map((id, index) => agent(file(id), `w9:p${index + 2}`))] } });
    }
    if (op[0] === "pane" && op[1] === "run") return JSON.stringify({ result: { pane_id: pane } });
    if (op[0] === "agent" && op[1] === "start") {
      const args = op.slice(op.indexOf("--") + 1);
      state.writer = args[args.indexOf("--session") + 1];
      return JSON.stringify({ result: { name: "flow-main-chain-demo" } });
    }
    throw new Error(`Unexpected Herdr command: ${argv.join(" ")}`);
  };
  const argsFor = (who: Who, overrides: Record<string, string> = {}) => {
    const id = who === "s1" ? s1 : s2, authorization = who === "s1" ? "A-s1-20261029" : "A-s2-20261029";
    const flags: Record<string, string> = { "--handover": handover, "--authorization": authorization, "--takeover-task": takeover,
      "--source-pi-session": id, "--source-pi-session-path": file(id), "--source-herdr-session": herdrSession, "--source-pane": pane,
      "--herdr-session": herdrSession, "--target-pane": pane, "--target-cwd": cwd, ...overrides };
    return ["--recover-stale-main", ...Object.entries(flags).flat()];
  };
  const recover = (who: Who, overrides?: Record<string, string>) => requestHandoverReplacement(root, address, argsFor(who, overrides), { command, at: () => verifiedAt });
  const occupy = (next: Occupancy) => Object.assign(state, { writer: undefined, extra: [], malformed: false }, next);
  const launch = (who: Who) => launchPiRuntime(root, address, [
    "--pane", pane, "--herdr-session", herdrSession, "--adopt-session", file(who === "s1" ? s1 : s2),
    "--source-herdr-session", herdrSession, "--source-pane", pane, "--authorization", who === "s1" ? "A-s1-20261029" : "A-s2-20261029",
  ], { command, select: selectEconomy, at: () => "2026-10-29T10:10:00.000Z" });
  return { root, receipt, active, files: file, recover, occupy, launch, task, calls, state };
}

async function fixture(evidence: Partial<Evidence> = {}) {
  const options: Evidence = { s1StillListed: false, malformedList: false, authorizeS2: true, ...evidence };
  const value = await desk(options.authorizeS2);
  // S0 -> R1: S0 is stale and absent; S1 is the live source in the canonical pane.
  await value.recover("s1");
  const r1 = await readFile(value.active, "utf8");
  // S1 exits and S2 takes the canonical pane (optionally S1 is still listed elsewhere, or the list is malformed).
  value.occupy({ writer: value.files(s2), extra: options.s1StillListed ? [s1] : [], malformed: options.malformedList });
  value.calls.length = 0;
  return { ...value, r1, seatBefore: await readFile(paths(value.root).seatFile(address), "utf8"), receiptBefore: await readFile(value.receipt, "utf8") };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const mutating = (argv: string[]) => argv.some((part) => ["run", "start", "bind", "attach", "apply", "create", "rename", "close"].includes(part));

async function refusedUnchanged(value: Awaited<ReturnType<typeof fixture>>, who: Who, match: RegExp) {
  const error = await value.recover(who).then(() => undefined, (cause: Error) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toMatch(match);
  expect(await readFile(value.active, "utf8")).toBe(value.r1);
  expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(value.seatBefore);
  expect(await readFile(value.receipt, "utf8")).toBe(value.receiptBefore);
  expect(value.calls.some(mutating)).toBe(false);
}

test("RED: an active stale_main_recovery request whose live source S1 has exited is replaced by authorized S2 and archived by hash", async () => {
  const value = await fixture();
  await value.recover("s2");
  const request = await readYaml<HandoverReplacementRequest & { stale_main_recovery: Record<string, any> }>(value.active);
  const prior = request.stale_main_recovery.prior_request;
  expect(request).toMatchObject({ task: takeover, source: { pi_session: s2, pi_session_path: value.files(s2) }, stale_main_recovery: { canonical_source: { pi_session: s0 } } });
  expect(prior.path).toBe(value.active);
  expect(await readFile(prior.archive, "utf8")).toBe(value.r1);
  expect(prior.archive.endsWith(`${prior.sha256}.yaml`)).toBe(true);
  expect(prior.live_source_exited).toMatchObject({ pi_session: s1, pi_session_path: value.files(s1), herdr_session: herdrSession, pane, verified_at: verifiedAt });
  // Evidence-only: seat binding and stale receipt untouched, no Herdr mutation, and the new request matches the still-stale binding.
  expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(value.seatBefore);
  expect(await readFile(value.receipt, "utf8")).toBe(value.receiptBefore);
  expect(value.calls.some(mutating)).toBe(false);
  expect(value.calls.filter(agentListCall)).toHaveLength(1); // S0 and S1 absence come from one complete agent-list snapshot
  expect(await replacementForMainLaunch(value.root, await readSeat(value.root, address), address)).toMatchObject({ request: { task: takeover, source: { pi_session: s2 } } });
});

test("an active stale_main_recovery request whose source S1 is still listed as a live Pi agent stays rejected and untouched", async () => {
  const value = await fixture({ s1StillListed: true });
  await refusedUnchanged(value, "s2", /live Path-A replacement request already exists|still a live Pi agent/);
});

test("an active stale_main_recovery request with incomplete global agent-list evidence stays rejected and untouched", async () => {
  const value = await fixture({ malformedList: true });
  await refusedUnchanged(value, "s2", /complete global Herdr agent-list evidence/);
});

test("S2 without its exact operator authorization stays rejected and untouched", async () => {
  const value = await fixture({ authorizeS2: false });
  await refusedUnchanged(value, "s2", /operator authorization record/);
});

test("retrying the recorded live source S1 against its own active request stays rejected and untouched", async () => {
  const value = await fixture();
  value.occupy({ writer: value.files(s1) }); // S1 is in fact still the live canonical occupant, so its own request remains live.
  await refusedUnchanged(value, "s1", /live Path-A replacement request already exists/);
});

async function resumed(root: string) {
  const child = Bun.spawn([process.execPath, cli, "handover", "resumed", address], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ATDD_WORKFLOW_ROOT: root } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

/** One recovery attempt that must be refused with the active request, seat binding and stale receipt left exactly as they were. */
async function expectRefused(value: Awaited<ReturnType<typeof desk>>, attempt: () => Promise<unknown>, match: RegExp) {
  const [request, seatBytes, receipt] = await Promise.all([readFile(value.active, "utf8"), readFile(paths(value.root).seatFile(address), "utf8"), readFile(value.receipt, "utf8")]);
  const error = await attempt().then(() => undefined, (cause: Error) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toMatch(match);
  expect([await readFile(value.active, "utf8"), await readFile(paths(value.root).seatFile(address), "utf8"), await readFile(value.receipt, "utf8")]).toEqual([request, seatBytes, receipt]);
}

test("end to end: S0 request -> S1 replacement -> S1 exits before adoption -> S2 replacement -> S2 adoption launch -> handover resumed", async () => {
  const value = await desk(true, true);
  // S0 stale record with an active request naming S0. S0 still listed as a live Pi: S1 cannot replace it.
  value.occupy({ writer: value.files(s1), extra: [s0] });
  await expectRefused(value, () => value.recover("s1"), /still a live Pi agent/);
  // S0 gone: authorized S1 replacement is recorded (S0 request archived with its source-exit evidence).
  value.occupy({ writer: value.files(s1) });
  await value.recover("s1");
  const r1Bytes = await readFile(value.active, "utf8"), r1 = await readYaml<HandoverReplacementRequest>(value.active);
  expect(r1).toMatchObject({ source: { pi_session: s1 }, stale_main_recovery: { prior_request: { source_exited: { pi_session: s0 } } } });
  // S1 exits before adopting; S2 takes the canonical pane. Live S1, a wrong tuple, a wrong authorization and a terminal task are all refused.
  value.occupy({ writer: value.files(s2), extra: [s1] });
  await expectRefused(value, () => value.recover("s2"), /still a live Pi agent/);
  value.occupy({ writer: value.files(s2) });
  await expectRefused(value, () => value.recover("s2", { "--source-pane": "w9:p2" }), /exact released source pane/);
  await expectRefused(value, () => value.recover("s2", { "--authorization": "A-s1-20261029" }), /immutable operator authorization record bound to the exact adoption tuple/);
  await value.task("done");
  await expectRefused(value, () => value.recover("s2"), /ready self-assigned main takeover task/);
  await value.task("todo");
  // Authorized S2 replaces R1 (archived by hash with S1's exit evidence).
  await value.recover("s2");
  const r2 = await readYaml<HandoverReplacementRequest>(value.active);
  const prior = r2.stale_main_recovery!.prior_request!;
  expect(await readFile(prior.archive, "utf8")).toBe(r1Bytes);
  expect(prior.live_source_exited).toMatchObject({ pi_session: s1 });
  expect(r2).toMatchObject({ source: { pi_session: s2 }, stale_main_recovery: { canonical_source: { pi_session: s0 } } });
  // Adoption: refused while S2 is still the live writer, and with S2's transcript missing; then succeeds after release.
  await expect(value.launch("s2")).rejects.toThrow(/requires an available shell pane/);
  value.occupy({});
  const transcript = value.files(s2), hidden = `${transcript}.hidden`;
  await rename(transcript, hidden);
  await expect(value.launch("s2")).rejects.toThrow(/ENOENT|no such file/i);
  await rename(hidden, transcript);
  expect(value.state.writer).toBeUndefined();
  const launched = await value.launch("s2");
  await registerRuntimeState(value.root, { seat: address, owner_token: `owner-${s2}`, pid: 84314, model: "economy", cwd }, "2026-10-29T10:11:00.000Z");
  const record = await readYaml<Record<string, any>>(paths(value.root).seatFile(address));
  expect(record.runtime).toMatchObject({ pi_session: s2, pi_session_path: transcript, launch_receipt: launched.receipt });
  const result = await resumed(value.root);
  expect(result.output).toContain("RESUMED; verified 6/6; discrepancies: none.");
  expect(result.exitCode).toBe(0);
});
