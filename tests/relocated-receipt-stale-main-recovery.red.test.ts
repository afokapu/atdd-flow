// URN: test:atdd-flow:relocated-receipt-stale-main-recovery
// Acceptance: acc:flow:E021-UNIT-001
// Phase: UNIT
// Purpose: A relocated main (seat binding_mode operator-authorized-manual-in-place-adoption, receipt placement retired, seat
// locator moved) is recoverable through --recover-stale-main only on a fully verified manual rebinding receipt, an authorization
// that names the retired and current panes, and Herdr proof that the exact recorded Pi is the sole writer at the current pane.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml, seat as readSeat } from "../src/core";
import { handoverReplacementPath, replacementForMainLaunch, requestHandoverReplacement, type HandoverReplacementRequest } from "../src/handover";
import { registerRuntimeState } from "../src/runtime-state";
import { launchPiRuntime } from "../src/seats";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const project = "score-demo", address = `main@${project}`;
const retired = "w7:p8", current = "w7:pG", herdrSession = "forge", cwd = "/work/score-demo";
const session = "01a11ada-cce4-75c0-8818-579d290aae28";
const otherSession = "33333333-3333-4333-8333-333333333333";
const handover = "H-20261029T200000Z-main-score-demo-successor", takeover = "main-takeover-20261029";
const authorizationId = "A-relocated-receipt-20261029";
const mode = "operator-authorized-manual-in-place-adoption";
const verifiedAt = "2026-10-29T21:00:00.000Z";
const roots: string[] = [];
const selectEconomy = async () => ({ available: true as const, model: "test", selected_model: "economy", confidence: 0.99 });
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

type Options = {
  receipt?: (receipt: Record<string, any>) => void;
  seatMode?: string | null;
  seatPane?: string;
  /** Rewrites the session JSONL so the backup is no longer its byte prefix. */
  diverge?: boolean;
  deleteBackup?: boolean;
  corruptBackupHash?: boolean;
  /** The retired pane in the stale active request. */
  requestPane?: string;
  takeoverStatus?: string;
  authorization?: { sourcePane?: string; targetPane?: string; session?: string };
  /** Herdr observations. */
  writerAtRetired?: boolean;
  twoWritersAtCurrent?: boolean;
  successorListed?: boolean;
  noWriterAtCurrent?: boolean;
  args?: Record<string, string>;
};

async function fixture(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-relocated-receipt-"));
  roots.push(root);
  const bin = join(root, "bin"), pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }] });
  await atomicYaml(paths(root).projectFile(project), { schema: "atdd-workflow/project/v1", project, repository: cwd, roles: {} });
  const sessionPath = join(root, `2026-10-08T09-31-49-351Z_${session}.jsonl`);
  const prefix = '{"type":"session","id":"adopted"}\n{"type":"message","n":1}\n';
  const backup = join(root, "backups", `2026-10-08T09-31-49-351Z_${session}.jsonl`);
  await mkdir(join(root, "backups"));
  if (!options.deleteBackup) await writeFile(backup, prefix);
  await writeFile(sessionPath, options.diverge ? '{"type":"session","id":"rewritten"}\n' : `${prefix}{"type":"message","n":2}\n`);
  const receiptPath = join(root, ".atdd-flow", "runtime-relocation", "MR-20261010T204020Z-main-score-demo.yaml");
  const receipt: Record<string, any> = {
    schema: "atdd-flow/manual-pi-runtime-rebinding-receipt/v1", id: "MR-20261010T204020Z-main-score-demo", created_at: "2026-10-10T20:40:20Z",
    seat: address, pi_session: session, pi_session_path: sessionPath, herdr_session: herdrSession, pane: retired,
    authorized_by: "operator@desk", authorization: "M-20261010T204010Z-owner-authorized-manual-main-runtime-rebinding_62fd7d2e", mode,
    truthfulness: { launcher_generated: false, session_restarted: false, history_rewritten: false },
    target: { application: "herdr", herdr_session: herdrSession, pane: retired, cwd, pi_session: session, pi_session_path: sessionPath },
    backup: { path: backup, bytes: prefix.length, sha256: options.corruptBackupHash ? "0".repeat(64) : sha256(prefix) },
  };
  options.receipt?.(receipt);
  await atomicYaml(receiptPath, receipt);
  const runtime: Record<string, unknown> = {
    application: "herdr", wake: "native", addresses: { herdr: { session: herdrSession, pane: options.seatPane ?? current } },
    pi_session: session, pi_session_path: sessionPath, launch_receipt: receiptPath,
    ...(options.seatMode === null ? {} : { binding_mode: options.seatMode ?? mode }),
  };
  await atomicYaml(paths(root).seatFile(address), { schema: "atdd-workflow/seat/v2", address, role: "main", project, worktree: cwd, branch: "main", runtime });
  await atomicYaml(paths(root).handoverFile(address), { schema: "atdd-workflow/handover/v1", seat: address, handover_id: handover, supersedes: "none", recorded_at: "2026-10-29T20:00:00.000Z", text: "exact handover" });
  await atomicYaml(paths(root).taskFile(project, takeover), { schema: "atdd-workflow/task/v1", title: "Main takeover", status: options.takeoverStatus ?? "todo", coordinator: address, assignee: address, done_when: [{ text: "Recovered." }] });
  const grant = options.authorization ?? {};
  await createExactSessionAdoptionAuthorization(root, authorizationId, [
    "--by", "operator@desk", "--seat", address, "--pi-session", grant.session ?? session, "--pi-session-path", sessionPath,
    "--source-herdr-session", herdrSession, "--source-pane", grant.sourcePane ?? retired,
    "--target-herdr-session", herdrSession, "--target-pane", grant.targetPane ?? current, "--target-cwd", cwd,
  ]);
  // The stale active request retains the retired pane for both source and target.
  const active = handoverReplacementPath(root, address);
  const stale = options.requestPane ?? retired;
  await atomicYaml(active, {
    schema: "atdd-flow/context-handover-replacement-request/v1", seat: address, task: "older-takeover",
    handover: { id: "H-older", sha256: "1".repeat(64) }, authorization: { id: "A-older", hash: "2".repeat(64) },
    source: { pi_session: session, pi_session_path: sessionPath, herdr_session: herdrSession, pane: stale },
    target: { herdr_session: herdrSession, pane: stale, cwd }, created_at: "2026-10-28T20:06:51.449Z",
  });
  const fake = herdr(sessionPath, options);
  const argValues: Record<string, string> = {
    "--handover": handover, "--authorization": authorizationId, "--takeover-task": takeover,
    "--source-pi-session": session, "--source-pi-session-path": sessionPath, "--source-herdr-session": herdrSession, "--source-pane": retired,
    "--herdr-session": herdrSession, "--target-pane": current, "--target-cwd": cwd, ...options.args,
  };
  const args = ["--recover-stale-main", ...Object.entries(argValues).flat()];
  const recover = () => requestHandoverReplacement(root, address, args, { command: fake.command, at: () => verifiedAt });
  return {
    root, fake, sessionPath, receiptPath, active, recover,
    before: await readFile(active, "utf8"), receiptBefore: await readFile(receiptPath, "utf8"), seatBefore: await readFile(paths(root).seatFile(address), "utf8"),
  };
}

/** Fake Herdr: the exact recorded Pi is the sole writer at the current pane unless an option says otherwise. */
function herdr(sessionPath: string, options: Options) {
  let writer = !options.noWriterAtCurrent;
  const calls: string[][] = [];
  const otherPath = sessionPath.replace(session, otherSession);
  const sessionOf = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const agent = (path: string, pane: string) => ({ name: "flow-main-score-demo", agent: "pi", pane_id: pane, agent_status: "idle", agent_session: sessionOf(path), cwd });
  const command = async (argv: string[]) => {
    calls.push(argv);
    const op = argv.slice(3), pane = op.find((part) => /^w\d+:p\w+$/.test(part)) ?? current;
    const atCurrent = pane === current;
    if (op[0] === "pane" && op[1] === "get") {
      if (atCurrent && writer) return JSON.stringify({ result: { pane: { pane_id: current, agent: "pi", agent_status: "idle", agent_session: sessionOf(sessionPath), cwd } } });
      if (!atCurrent && options.writerAtRetired) return JSON.stringify({ result: { pane: { pane_id: retired, agent: "pi", agent_status: "idle", agent_session: sessionOf(otherPath), cwd } } });
      return JSON.stringify({ result: { pane: { pane_id: pane, agent: null, agent_status: "unknown", agent_session: null, cwd } } });
    }
    if (op[0] === "agent" && op[1] === "get") return JSON.stringify({ result: { agent: agent(sessionPath, current) } });
    if (op[0] === "pane" && op[1] === "process-info") {
      const pis = atCurrent && writer ? (options.twoWritersAtCurrent ? [100, 101] : [100]) : [];
      return JSON.stringify({ result: { process_info: { pane_id: pane, shell_pid: 42,
        foreground_processes: pis.length ? pis.map((pid) => ({ name: "node", argv0: "pi", pid, cwd })) : [{ name: "zsh", argv0: "zsh", pid: 42, cwd }] } } });
    }
    if (op[0] === "agent" && op[1] === "list") {
      const agents = [...(writer ? [agent(sessionPath, current)] : []), ...(options.writerAtRetired ? [agent(otherPath, retired)] : []),
        ...(options.successorListed ? [agent(sessionPath, "w7:p9")] : [])];
      return JSON.stringify({ result: { agents } });
    }
    if (op[0] === "workspace" && op[1] === "list") return JSON.stringify({ result: { workspaces: [{ workspace_id: "w7", label: project, worktree: { checkout_path: cwd } }] } });
    if (op[0] === "tab" && op[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "w7:t1", workspace_id: "w7", label: address }] } });
    if (op[0] === "pane" && op[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: current, tab_id: "w7:t1", label: address, agent: writer ? "pi" : null, agent_status: writer ? "idle" : "unknown" }] } });
    if (op[0] === "pane" && op[1] === "run") return JSON.stringify({ result: { pane_id: current } });
    if (op[0] === "agent" && op[1] === "start") { writer = true; return JSON.stringify({ result: { name: "flow-main-score-demo" } }); }
    throw new Error(`Unexpected Herdr command: ${argv.join(" ")}`);
  };
  return { command, calls, release: () => { writer = false; } };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const mutating = (argv: string[]) => argv.some((part) => ["run", "start", "bind", "attach", "apply", "create", "rename", "close"].includes(part));

async function refusedUnchanged(options: Options, match: string) {
  const value = await fixture(options);
  const error = await value.recover().then(() => undefined, (cause: Error) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toContain(match);
  expect(await readFile(value.active, "utf8")).toBe(value.before);
  expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(value.seatBefore);
  expect(await readFile(value.receiptPath, "utf8")).toBe(value.receiptBefore);
  expect(value.fake.calls.some(mutating)).toBe(false);
}

async function resumed(root: string) {
  const child = Bun.spawn([process.execPath, cli, "handover", "resumed", address], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ATDD_WORKFLOW_ROOT: root } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

test("RED: a relocated main with a verified manual rebinding receipt is recovered; stale request and receipt are archived by hash", async () => {
  const value = await fixture();
  await value.recover();
  const request = await readYaml<HandoverReplacementRequest & { stale_main_recovery: Record<string, any> }>(value.active);
  const recovery = request.stale_main_recovery;
  expect(request).toMatchObject({
    task: takeover, source: { pi_session: session, herdr_session: herdrSession, pane: retired }, target: { herdr_session: herdrSession, pane: current, cwd },
  });
  expect(recovery.canonical_source).toMatchObject({ pi_session: session, pi_session_path: value.sessionPath, launch_receipt: value.receiptPath });
  expect(await readFile(recovery.prior_receipt.archive, "utf8")).toBe(value.receiptBefore);
  expect(recovery.prior_receipt.archive.endsWith(`${recovery.prior_receipt.sha256}.yaml`)).toBe(true);
  expect(await readFile(recovery.prior_request.archive, "utf8")).toBe(value.before);
  expect(recovery.prior_request.archive.endsWith(`${recovery.prior_request.sha256}.yaml`)).toBe(true);
  // Evidence-only: no seat/receipt edit and no Herdr mutation; the new request is launch-eligible against the unchanged binding.
  expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(value.seatBefore);
  expect(await readFile(value.receiptPath, "utf8")).toBe(value.receiptBefore);
  expect(value.fake.calls.some(mutating)).toBe(false);
  expect(await replacementForMainLaunch(value.root, await readSeat(value.root, address), address)).toMatchObject({ request: { task: takeover } });
});

test("RED: the recovered relocated main adopts the exact session at the current pane and reconciles RESUMED 6/6", async () => {
  const value = await fixture();
  await value.recover();
  value.fake.release();
  const launched = await launchPiRuntime(value.root, address, [
    "--pane", current, "--herdr-session", herdrSession, "--adopt-session", value.sessionPath,
    "--source-herdr-session", herdrSession, "--source-pane", retired, "--authorization", authorizationId,
  ], { command: value.fake.command, select: selectEconomy, at: () => "2026-10-29T21:10:00.000Z" });
  await registerRuntimeState(value.root, { seat: address, owner_token: `owner-${session}`, pid: 84314, model: "economy", cwd }, "2026-10-29T21:11:00.000Z");
  const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(address));
  expect(seat.runtime).toMatchObject({ pi_session: session, launch_receipt: launched.receipt });
  expect(await readFile(value.receiptPath, "utf8")).toBe(value.receiptBefore);
  const result = await resumed(value.root);
  expect(result.output).toContain("RESUMED; verified 6/6; discrepancies: none.");
  expect(result.exitCode).toBe(0);
});

// Receipt validity: every refusal leaves the active request, seat binding, receipt and Herdr untouched.
test("a manual rebinding receipt for another schema, seat, session, path, or cwd is refused", async () => {
  await refusedUnchanged({ receipt: (r) => { r.schema = "atdd-flow/manual-pi-runtime-rebinding-receipt/v0"; } }, "relocation receipt");
  await refusedUnchanged({ receipt: (r) => { r.seat = "main@other"; } }, "relocation receipt");
  await refusedUnchanged({ receipt: (r) => { r.pi_session = otherSession; r.target.pi_session = otherSession; } }, "relocation receipt");
  await refusedUnchanged({ receipt: (r) => { r.pi_session_path = `${r.pi_session_path}.other`; r.target.pi_session_path = r.pi_session_path; } }, "relocation receipt");
  await refusedUnchanged({ receipt: (r) => { r.target.cwd = "/work/other"; } }, "relocation receipt");
});

test("a receipt mode that is absent or differs from the seat binding_mode is refused", async () => {
  await refusedUnchanged({ receipt: (r) => { delete r.mode; } }, "relocation receipt");
  await refusedUnchanged({ receipt: (r) => { r.mode = "operator-authorized-other"; } }, "relocation receipt");
  await refusedUnchanged({ seatMode: null }, "relocation receipt");
  await refusedUnchanged({ seatMode: "operator-authorized-other" }, "relocation receipt");
});

test("a receipt without operator@desk authority and an authorization id is refused", async () => {
  await refusedUnchanged({ receipt: (r) => { r.authorized_by = "main@score-demo"; } }, "relocation receipt");
  await refusedUnchanged({ receipt: (r) => { delete r.authorization; } }, "relocation receipt");
});

test("a missing, hash-mismatched, or non-prefix backup is refused", async () => {
  await refusedUnchanged({ deleteBackup: true }, "relocation receipt");
  await refusedUnchanged({ corruptBackupHash: true }, "relocation receipt");
  await refusedUnchanged({ diverge: true }, "relocation receipt");
});

// Lineage and tuple: the receipt placement, the stale request and the authorization must describe one relocation.
test("a receipt placement that differs from the stale request's retired pane is refused", async () => {
  await refusedUnchanged({ requestPane: "w7:pX" }, "relocation receipt");
  await refusedUnchanged({ receipt: (r) => { r.pane = "w7:pX"; r.target.pane = "w7:pX"; } }, "relocation receipt");
});

test("a request target other than the seat's current locator, or a source other than the retired receipt pane, is refused", async () => {
  await refusedUnchanged({ args: { "--target-pane": "w7:pZ" }, authorization: { targetPane: "w7:pZ" } }, "relocation receipt");
  await refusedUnchanged({ args: { "--source-pane": "w7:pZ" }, authorization: { sourcePane: "w7:pZ" } }, "relocation receipt");
  await refusedUnchanged({ seatPane: retired }, "relocation receipt");
});

test("a request source session or path that is not the exact recorded Pi is refused", async () => {
  await refusedUnchanged({ args: { "--source-pi-session": otherSession } }, "relocation receipt");
  await refusedUnchanged({ args: { "--source-pi-session-path": "/tmp/other_01a11ada-cce4-75c0-8818-579d290aae28.jsonl" } }, "relocation receipt");
});

test("an authorization for another session, source pane, or target pane keeps the exact operator authorization guard", async () => {
  await refusedUnchanged({ authorization: { session: otherSession } }, "operator authorization record");
  await refusedUnchanged({ authorization: { sourcePane: current } }, "operator authorization record");
  await refusedUnchanged({ authorization: { targetPane: retired } }, "operator authorization record");
});

test("a terminal or non-ready takeover task keeps the ready takeover guard", async () => {
  await refusedUnchanged({ takeoverStatus: "done" }, "ready self-assigned main takeover task");
  await refusedUnchanged({ takeoverStatus: "in_progress" }, "ready self-assigned main takeover task");
});

// Live source: the exact recorded Pi must be the sole writer at the current locator; the retired pane is lineage only.
test("a live Pi at the retired pane, a second writer at the current pane, no writer, or the exact Pi already running elsewhere (a successor) is refused", async () => {
  await refusedUnchanged({ writerAtRetired: true }, "relocation receipt");
  await refusedUnchanged({ twoWritersAtCurrent: true }, "relocation receipt");
  await refusedUnchanged({ noWriterAtCurrent: true }, "relocation receipt");
  await refusedUnchanged({ successorListed: true }, "relocation receipt");
});

test("the plain stale-main target guard is unchanged: a seat without relocation binding_mode and receipt still refuses a moved target", async () => {
  const value = await fixture({ seatMode: null, receipt: (r) => { r.schema = "atdd-flow/pi-runtime-launch-receipt/v1"; delete r.mode; } });
  const error = await value.recover().then(() => undefined, (cause: Error) => cause);
  expect(error?.message).toContain("Path-A replacement target must be the exact released source pane");
  expect(await readFile(value.active, "utf8")).toBe(value.before);
});

test("an immutable archive collision with different bytes is refused", async () => {
  const value = await fixture();
  const archive = join(value.root, ".atdd-flow", "stale-main-receipt-archive", encodeURIComponent(address), `${sha256(value.receiptBefore)}.yaml`);
  await mkdir(join(archive, ".."), { recursive: true });
  await writeFile(archive, "different immutable bytes\n");
  const error = await value.recover().then(() => undefined, (cause: Error) => cause);
  expect(error?.message).toContain("collides with different immutable evidence");
  expect(await readFile(value.active, "utf8")).toBe(value.before);
  expect(await readFile(archive, "utf8")).toBe("different immutable bytes\n");
});
