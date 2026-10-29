// URN: test:atdd-flow:stale-main-s1-exited-recovery
// Acceptance: acc:flow:E021-UNIT-001
// Phase: UNIT
// Purpose: S0 (stale recorded runtime) -> active stale_main_recovery request R1 from live source S1 -> S1 exits -> S2 holds the
// canonical pane. --recover-stale-main replaces R1 by S2 only when S1 is provably absent from complete global Pi agent evidence;
// every other refusal stays enforced.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml, seat as readSeat } from "../src/core";
import { handoverReplacementPath, replacementForMainLaunch, requestHandoverReplacement, type HandoverReplacementRequest } from "../src/handover";

const project = "chain-demo", address = `main@${project}`;
const pane = "w9:p1", herdrSession = "forge", cwd = "/work/chain-demo";
const s0 = "11111111-1111-4111-8111-111111111111", s1 = "22222222-2222-4222-8222-222222222222", s2 = "33333333-3333-4333-8333-333333333333";
const handover = "H-20261029T100000Z-main-chain-demo-successor", takeover = "main-takeover-20261029";
const verifiedAt = "2026-10-29T10:05:00.000Z";
const roots: string[] = [];

type Evidence = { s1StillListed: boolean; malformedList: boolean; authorizeS2: boolean };
type Who = "s1" | "s2";

async function fixture(evidence: Partial<Evidence> = {}) {
  const options: Evidence = { s1StillListed: false, malformedList: false, authorizeS2: true, ...evidence };
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
  await atomicYaml(paths(root).taskFile(project, takeover), { schema: "atdd-workflow/task/v1", title: "Main takeover", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Recovered." }] });
  const authorize = (id: string, authorization: string, targetPane = pane) => createExactSessionAdoptionAuthorization(root, authorization, [
    "--by", "operator@desk", "--seat", address, "--pi-session", id, "--pi-session-path", file(id),
    "--source-herdr-session", herdrSession, "--source-pane", pane, "--target-herdr-session", herdrSession, "--target-pane", targetPane, "--target-cwd", cwd,
  ]);
  await authorize(s1, "A-s1-20261029");
  if (options.authorizeS2) await authorize(s2, "A-s2-20261029");

  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const agent = (value: string, agentPane: string) => ({ name: "flow-main-chain-demo", agent: "pi", pane_id: agentPane, agent_status: "idle", agent_session: session(value), cwd });
  const calls: string[][] = [];
  let current: Who = "s1", listed: string[] = [s1], malformed = false;
  const currentFile = () => file(current === "s1" ? s1 : s2);
  const command = async (argv: string[]) => {
    calls.push(argv);
    const op = argv.slice(3);
    if (op[0] === "pane" && op[1] === "get") return JSON.stringify({ result: { pane: { pane_id: pane, agent: "pi", agent_status: "idle", agent_session: session(currentFile()), cwd } } });
    if (op[0] === "agent" && op[1] === "get") return JSON.stringify({ result: { agent: agent(currentFile(), pane) } });
    if (op[0] === "pane" && op[1] === "process-info") return JSON.stringify({ result: { process_info: { pane_id: pane, shell_pid: 42, foreground_processes: [{ name: "node", argv0: "pi", pid: 100, cwd }] } } });
    if (op[0] === "agent" && op[1] === "list") {
      if (malformed) return JSON.stringify({ result: {} });
      return JSON.stringify({ result: { agents: listed.map((id, index) => agent(file(id), index === 0 ? pane : `w9:p${index + 1}`)) } });
    }
    throw new Error(`Unexpected Herdr command: ${argv.join(" ")}`);
  };
  const argsFor = (who: Who) => {
    const id = who === "s1" ? s1 : s2, authorization = who === "s1" ? "A-s1-20261029" : "A-s2-20261029";
    return ["--recover-stale-main", "--handover", handover, "--authorization", authorization, "--takeover-task", takeover,
      "--source-pi-session", id, "--source-pi-session-path", file(id), "--source-herdr-session", herdrSession, "--source-pane", pane,
      "--herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", cwd];
  };
  const recover = (who: Who) => requestHandoverReplacement(root, address, argsFor(who), { command, at: () => verifiedAt });
  const active = handoverReplacementPath(root, address);

  // S0 -> R1: S0 is stale and absent; S1 is the live source in the canonical pane.
  await recover("s1");
  const r1 = await readFile(active, "utf8");
  // S1 exits and S2 takes the canonical pane (optionally S1 is still listed elsewhere, or the list is malformed).
  current = "s2";
  listed = [s2, ...(options.s1StillListed ? [s1] : [])];
  malformed = options.malformedList;
  calls.length = 0;
  const occupy = (who: Who) => { current = who; listed = [who === "s1" ? s1 : s2]; };
  return { root, receipt, active, r1, files: file, recover, occupy, calls, seatBefore: await readFile(paths(root).seatFile(address), "utf8"), receiptBefore: await readFile(receipt, "utf8") };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const mutating = (argv: string[]) => argv.some((part) => ["run", "start", "bind", "attach", "apply", "create", "rename", "close"].includes(part));

async function refusedUnchanged(value: Awaited<ReturnType<typeof fixture>>, who: Who, match: string) {
  const error = await value.recover(who).then(() => undefined, (cause: Error) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toContain(match);
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
  expect(await replacementForMainLaunch(value.root, await readSeat(value.root, address), address)).toMatchObject({ request: { task: takeover, source: { pi_session: s2 } } });
});

test("an active stale_main_recovery request whose source S1 is still listed as a live Pi agent stays rejected and untouched", async () => {
  const value = await fixture({ s1StillListed: true });
  await refusedUnchanged(value, "s2", "still a live Pi agent");
});

test("an active stale_main_recovery request with incomplete global agent-list evidence stays rejected and untouched", async () => {
  const value = await fixture({ malformedList: true });
  await refusedUnchanged(value, "s2", "complete global Herdr agent-list evidence");
});

test("S2 without its exact operator authorization stays rejected and untouched", async () => {
  const value = await fixture({ authorizeS2: false });
  await refusedUnchanged(value, "s2", "operator authorization record");
});

test("retrying the recorded live source S1 against its own active request stays rejected and untouched", async () => {
  const value = await fixture();
  value.occupy("s1"); // S1 is in fact still the live canonical occupant, so its own request remains live.
  await refusedUnchanged(value, "s1", "live Path-A replacement request already exists");
});
