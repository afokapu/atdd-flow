// URN: test:atdd-flow:stale-launcher-receipt-pane-gone
// Acceptance: acc:flow:E021-UNIT-001
// Phase: UNIT
// Purpose: Public-command E2E (`handover replace --recover-stale-main` through the CLI with a fake `herdr` on PATH). A main seat whose
// launcher-generated receipt records a retired canonical pane, and whose seat locator now names a different current pane, is recoverable
// ONLY when the retired pane and the exact recorded Pi are both absent from one complete global Herdr agent/pane snapshot and the
// request target equals the seat's current locator. Every present, mismatched, or incomplete case keeps the existing fail-closed guards.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const project = "score-demo", address = `main@${project}`;
const retired = "w7:p8", current = "w7:pG", herdrSession = "forge", cwd = "/work/score-demo";
const session = "01a11ada-cce4-75c0-8818-579d290aae28", otherSession = "33333333-3333-4333-8333-333333333333";
const handover = "H-20261030T010000Z-main-score-demo-successor", takeover = "main-takeover-20261030", authorizationId = "A-pane-gone-20261030";
const manualMode = "operator-authorized-manual-in-place-adoption";
const roots: string[] = [];
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

type Options = {
  /** Mutates the launcher receipt before it is written. */
  receipt?: (receipt: Record<string, any>) => void;
  /** Herdr global observations. */
  agents?: "complete" | "exact-pi-at-retired" | "exact-pi-elsewhere" | "exact-pi-at-current" | "other-pi-at-retired" | "no-agent-session" | "not-a-list";
  retiredPanePresent?: boolean;
  /** A binding_mode that lingers in the seat runtime; with `manual`, the genuine manual rebinding mode and receipt. */
  bindingMode?: string;
  manual?: boolean;
  /**
   * An active request left by the launch that produced the receipt, shaped as a relocation (source at an older pane, target at the
   * receipt placement). `embedded` is also recorded in the receipt's handover_replacement.request; the others break one listed link.
   */
  active?: "embedded" | "not-embedded" | "embedded-other-request" | "other-pi" | "other-target";
  /** Request flag overrides and authorization tuple. */
  args?: Record<string, string>;
  authorization?: { pi_session?: string; source_pane?: string; target_pane?: string };
};

async function fixture(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-pane-gone-"));
  roots.push(root);
  const bin = join(root, "bin"), pi = join(bin, "pi"), log = join(root, "herdr.log"), state = join(root, "herdr.json");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }] });
  await atomicYaml(paths(root).projectFile(project), { schema: "atdd-workflow/project/v1", project, repository: cwd, roles: {} });
  const sessionPath = join(root, `2026-10-08T09-31-49-351Z_${session}.jsonl`);
  await writeFile(sessionPath, '{"type":"session","id":"recorded"}\n');
  // Launcher-generated receipt: records the retired pane, not the seat's current locator.
  const receiptPath = join(root, ".atdd-flow", "runtime-launch", `${session}-receipt.yaml`);
  const receipt: Record<string, any> = {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, tasks: [takeover], candidate: "economy",
    pi_session: session, pi_session_path: sessionPath, herdr_session: herdrSession, pane: retired, created_at: "2026-10-20T08:00:01.000Z",
  };
  if (options.manual) {
    // A genuine operator manual rebinding receipt for the same retired placement, with its transcript-prefix backup.
    const prefix = '{"type":"session","id":"recorded"}\n', backup = join(root, "backup.jsonl");
    await writeFile(backup, prefix);
    Object.assign(receipt, {
      schema: "atdd-flow/manual-pi-runtime-rebinding-receipt/v1", id: "MR-20261030T000000Z-main-score-demo", mode: manualMode,
      authorized_by: "operator@desk", authorization: "M-20261030T000000Z-owner-authorized-manual-main-runtime-rebinding",
      target: { application: "herdr", herdr_session: herdrSession, pane: retired, cwd, pi_session: session, pi_session_path: sessionPath },
      backup: { path: backup, bytes: prefix.length, sha256: sha256(prefix) },
    });
  }
  const activePath = join(root, ".atdd-flow", "handover-replacements", `${encodeURIComponent(address)}.yaml`);
  let activeBefore: string | undefined;
  if (options.active) {
    const otherPath = sessionPath.replace(session, otherSession);
    const request = {
      schema: "atdd-flow/context-handover-replacement-request/v1", seat: address, task: "older-takeover",
      handover: { id: "H-older", sha256: "1".repeat(64) }, authorization: { id: "A-older", hash: "2".repeat(64) },
      source: options.active === "other-pi" ? { pi_session: otherSession, pi_session_path: otherPath, herdr_session: herdrSession, pane: "w7:p3" }
        : { pi_session: session, pi_session_path: sessionPath, herdr_session: herdrSession, pane: "w7:p3" },
      target: { herdr_session: herdrSession, pane: options.active === "other-target" ? "w7:pQ" : retired, cwd }, created_at: "2026-10-20T07:50:00.000Z",
    };
    await atomicYaml(activePath, request);
    if (options.active === "embedded" || options.active === "other-pi" || options.active === "other-target") {
      receipt.handover_replacement = { request, successor_session: session };
    } else if (options.active === "embedded-other-request") {
      receipt.handover_replacement = { request: { ...request, task: "different-takeover" }, successor_session: session };
    }
    activeBefore = await readFile(activePath, "utf8");
  }
  options.receipt?.(receipt);
  await atomicYaml(receiptPath, receipt);
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project, worktree: cwd, branch: "main",
    runtime: { application: "herdr", wake: "native", addresses: { herdr: { session: herdrSession, pane: current } }, pi_session: session, pi_session_path: sessionPath, launch_receipt: receiptPath,
      ...(options.manual || options.bindingMode ? { binding_mode: options.bindingMode ?? manualMode } : {}) },
  });
  await atomicYaml(paths(root).handoverFile(address), { schema: "atdd-workflow/handover/v1", seat: address, handover_id: handover, supersedes: "none", recorded_at: "2026-10-30T01:00:00.000Z", text: "exact handover" });
  await atomicYaml(paths(root).taskFile(project, takeover), { schema: "atdd-workflow/task/v1", title: "Main takeover", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Recovered." }] });
  const grant = options.authorization ?? {};
  const authorized = await invoke(root, "pi", "runtime", "authorize-adoption", authorizationId, "--by", "operator@desk", "--seat", address,
    "--pi-session", grant.pi_session ?? session, "--pi-session-path", sessionPath, "--source-herdr-session", herdrSession, "--source-pane", grant.source_pane ?? retired,
    "--target-herdr-session", herdrSession, "--target-pane", grant.target_pane ?? current, "--target-cwd", cwd);
  expect(authorized.exitCode).toBe(0);
  await writeFile(state, JSON.stringify({ agents: options.agents ?? "complete", retiredPanePresent: Boolean(options.retiredPanePresent), session, otherSession, sessionPath, retired, current, cwd }));
  await writeFile(join(bin, "herdr"), fakeHerdr(process.execPath));
  await chmod(join(bin, "herdr"), 0o755);
  const argValues: Record<string, string> = {
    "--handover": handover, "--authorization": authorizationId, "--takeover-task": takeover,
    "--source-pi-session": session, "--source-pi-session-path": sessionPath, "--source-herdr-session": herdrSession, "--source-pane": retired,
    "--herdr-session": herdrSession, "--target-pane": current, "--target-cwd": cwd, ...options.args,
  };
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_HERDR_STATE: state, FAKE_HERDR_LOG: log };
  const recover = () => invoke(root, "handover", "replace", address, "--recover-stale-main", ...Object.entries(argValues).flat(), env);
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return {
    root, receiptPath, sessionPath, recover, calls, active: activePath, activeBefore,
    seatBefore: await readFile(paths(root).seatFile(address), "utf8"), receiptBefore: await readFile(receiptPath, "utf8"),
  };
}

/** Fake Herdr CLI: a recorded, read-only global snapshot; the retired pane is gone unless an option keeps it listed. */
function fakeHerdr(bun: string) {
  return `#!${bun}
const { readFileSync, appendFileSync } = require("node:fs");
const state = JSON.parse(readFileSync(process.env.FAKE_HERDR_STATE, "utf8"));
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(argv) + "\\n");
const op = argv.slice(2), out = (value) => { console.log(JSON.stringify({ result: value })); };
const agent = (path, pane, name) => ({ name, agent: "pi", pane_id: pane, agent_status: "idle", agent_session: { kind: "path", source: "herdr:pi", value: path }, cwd: state.cwd });
const otherPath = state.sessionPath.replace(state.session, state.otherSession);
if (op[0] === "agent" && op[1] === "list") {
  if (state.agents === "not-a-list") { out({ agents: "unavailable" }); process.exit(0); }
  const agents = [agent(otherPath, "w7:p2", "driver-unrelated")];
  if (state.agents === "exact-pi-at-retired") agents.push(agent(state.sessionPath, state.retired, "flow-main-score-demo"));
  if (state.agents === "exact-pi-elsewhere") agents.push(agent(state.sessionPath, "w7:p9", "flow-main-score-demo"));
  if (state.agents === "exact-pi-at-current") agents.push(agent(state.sessionPath, state.current, "flow-main-score-demo"));
  if (state.agents === "other-pi-at-retired") agents.push(agent(otherPath, state.retired, "someone-else"));
  if (state.agents === "no-agent-session") agents.push({ name: "mystery", agent: "pi", pane_id: "w7:p3", agent_status: "unknown", agent_session: null, cwd: state.cwd });
  out({ agents });
} else if (op[0] === "pane" && op[1] === "list") {
  out({ panes: [{ pane_id: "w7:p2", tab_id: "w7:t1", agent: "pi" }, { pane_id: state.current, tab_id: "w7:t1", agent: null },
    ...(state.retiredPanePresent ? [{ pane_id: state.retired, tab_id: "w7:t1", agent: null }] : [])] });
} else if (op[0] === "pane" && (op[1] === "get" || op[1] === "process-info") && op.includes(state.retired) && !state.retiredPanePresent) {
  console.error("pane not found: " + state.retired); process.exit(1);
} else if (op[0] === "pane" && op[1] === "get" && op.includes(state.current)) {
  out({ pane: { pane_id: state.current, agent: null, agent_status: "unknown", agent_session: null, cwd: state.cwd } });
} else { console.error("Unexpected Herdr command: " + argv.join(" ")); process.exit(2); }
`;
}

async function invoke(root: string, ...input: (string | Record<string, string>)[]) {
  const env = typeof input.at(-1) === "object" ? input.pop() as Record<string, string> : {};
  const child = Bun.spawn([process.execPath, cli, ...input as string[]], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: undefined, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const mutating = (argv: string[]) => argv.some((part) => ["run", "start", "bind", "attach", "apply", "create", "rename", "close"].includes(part));

/** Every refusal exits non-zero without a usage error and leaves the active request, seat binding, receipt and Herdr untouched. */
async function refusedUnchanged(options: Options) {
  const value = await fixture(options);
  const result = await value.recover();
  expect(result.exitCode).not.toBe(0);
  expect(result.output).not.toContain("Unknown command");
  expect(result.output).not.toContain("Unexpected Herdr command");
  expect(await Bun.file(value.active).exists() ? await readFile(value.active, "utf8") : undefined).toBe(value.activeBefore);
  expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(value.seatBefore);
  expect(await readFile(value.receiptPath, "utf8")).toBe(value.receiptBefore);
  expect((await value.calls()).some(mutating)).toBe(false);
}

test("RED: a launcher receipt whose canonical pane and exact Pi are absent globally is recovered onto the current locator only; present or mismatched cases are refused", async () => {
  // Existing guards stay fail-closed: anything present, incomplete, mismatched, or not the current locator is refused.
  await refusedUnchanged({ agents: "exact-pi-at-retired" });
  await refusedUnchanged({ agents: "exact-pi-elsewhere" });
  await refusedUnchanged({ agents: "exact-pi-at-current" });
  await refusedUnchanged({ agents: "other-pi-at-retired" });
  await refusedUnchanged({ retiredPanePresent: true });
  await refusedUnchanged({ agents: "no-agent-session" });
  await refusedUnchanged({ agents: "not-a-list" });
  await refusedUnchanged({ args: { "--target-pane": "w7:pZ" }, authorization: { target_pane: "w7:pZ" } });
  await refusedUnchanged({ args: { "--source-pane": "w7:pX" }, authorization: { source_pane: "w7:pX" } });
  await refusedUnchanged({ args: { "--source-pi-session": otherSession } });
  await refusedUnchanged({ receipt: (r) => { r.seat = "main@other"; } });
  await refusedUnchanged({ receipt: (r) => { r.schema = "atdd-flow/pi-runtime-launch-receipt/v0"; } });
  await refusedUnchanged({ receipt: (r) => { r.pi_session = otherSession; } });
  await refusedUnchanged({ authorization: { pi_session: otherSession } });

  // The exact pane-gone case: recorded Pi and retired pane absent from one complete global snapshot; target is the current locator.
  await recoveredPaneGone(await fixture());

  // Routing is by receipt schema: a launcher receipt reaches pane-gone recovery even when the seat runtime retains a manual binding_mode.
  await recoveredPaneGone(await fixture({ bindingMode: manualMode }));
  await recoveredPaneGone(await fixture({ bindingMode: "operator-authorized-other" }));

  // Lineage: the active request left by the launch (relocation-shaped, embedded in the receipt's handover_replacement.request) is archived
  // by hash and replaced; every listed break in that chain keeps the request refused and untouched.
  await recoveredPaneGone(await fixture({ active: "embedded" }));
  await refusedUnchanged({ active: "not-embedded" });
  await refusedUnchanged({ active: "embedded-other-request" });
  await refusedUnchanged({ active: "other-pi" });
  await refusedUnchanged({ active: "other-target" });

  // A genuine manual rebinding receipt keeps manual routing: pane-gone absence is never accepted for it.
  const manual = await fixture({ manual: true });
  const routed = await manual.recover();
  expect(routed.exitCode).not.toBe(0);
  expect(routed.output).toContain("Stale main relocation receipt recovery refused");
  expect(routed.output).not.toContain("pane-gone");
  expect(await Bun.file(manual.active).exists()).toBe(false);
  expect((await manual.calls()).some(mutating)).toBe(false);
}, 60_000);

async function recoveredPaneGone(value: Awaited<ReturnType<typeof fixture>>) {
  const result = await value.recover();
  expect(result.output).toContain(`Recorded Path-A replacement request for ${address}.`);
  expect(result.exitCode).toBe(0);
  const request = await readYaml<Record<string, any>>(value.active);
  expect(request).toMatchObject({
    task: takeover, authorization: { id: authorizationId },
    source: { pi_session: session, pi_session_path: value.sessionPath, herdr_session: herdrSession, pane: retired },
    target: { herdr_session: herdrSession, pane: current, cwd },
    stale_main_recovery: { canonical_source: { pi_session: session, pi_session_path: value.sessionPath, launch_receipt: value.receiptPath } },
  });
  // The launcher receipt is archived by hash, create-only; the seat binding and receipt are untouched; Herdr is read-only.
  const archive = request.stale_main_recovery.prior_receipt;
  expect(archive.sha256).toBe(sha256(value.receiptBefore));
  expect(archive.archive.endsWith(`${archive.sha256}.yaml`)).toBe(true);
  expect(await readFile(archive.archive, "utf8")).toBe(value.receiptBefore);
  if (value.activeBefore !== undefined) {
    const prior = request.stale_main_recovery.prior_request;
    expect(prior.sha256).toBe(sha256(value.activeBefore));
    expect(await readFile(prior.archive, "utf8")).toBe(value.activeBefore);
  }
  expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(value.seatBefore);
  expect(await readFile(value.receiptPath, "utf8")).toBe(value.receiptBefore);
  const calls = await value.calls();
  expect(calls.some(mutating)).toBe(false);
  expect(calls.some((argv) => argv.slice(2, 4).join(" ") === "agent list")).toBe(true);
}
