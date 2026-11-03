// URN: test:atdd-flow:consumed-request-shell-pane-succession
// Acceptance: acc:flow:E023-UNIT-001
// Phase: UNIT
// Purpose: Live main@atdd-flow incident shape. A context-exhausted main whose consumed Path-A request, launch receipt and seat Pi
// all name a closed pane, while the seat is rebound to an available shell pane, is succeeded by an ordinary fresh-context launch
// through the public handover/launch/resumed commands, with no manual record edit, and every unsafe variant stays fail-closed.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml } from "../src/core";
import { handoverReplacementPath, requestHandoverReplacement, type HandoverReplacementRequest } from "../src/handover";
import { registerRuntimeState } from "../src/runtime-state";
import { bind, launchPiRuntime } from "../src/seats";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const project = "incident", address = `main@${project}`;
const retired = "w5:pB", current = "w5:pN", herdrSession = "forge", cwd = "/work/incident";
const sourceSession = "01a19062-d75b-7254-a25c-de81605255e9", canonicalSession = "314d651e-e796-4c28-b91c-9539822dd65f";
const handover = "H-20261103T020000Z-main-incident-successor", takeover = "main-context-successor-recovery-20261028";
const authorizationId = "A-incident-succession-20261103";
const verifiedAt = "2026-11-03T02:05:00.000Z";
const roots: string[] = [];
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const selectEconomy = async () => ({ available: true as const, model: "test", selected_model: "economy", confidence: 0.99 });
const mutating = (argv: string[]) => argv.some((part) => ["run", "start", "bind", "attach", "apply", "create", "rename", "close"].includes(part));

type Options = {
  /** How the seat records its current shell pane; the live incident recorded `forge/w5:pN`. */
  locator?: string;
  retiredPanePresent?: boolean;
  sourceListed?: boolean;
  targetOccupied?: boolean;
  noActive?: boolean;
  twoReady?: boolean;
  authorize?: boolean;
  hostPane?: string;
};

async function fixture(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-gone-source-"));
  roots.push(root);
  const bin = join(root, "bin"), pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }] });
  await atomicYaml(paths(root).projectFile(project), { schema: "atdd-workflow/project/v1", project, repository: cwd, roles: {} });
  const sourcePath = join(root, `src_${sourceSession}.jsonl`), canonicalPath = join(root, `canon_${canonicalSession}.jsonl`);
  await writeFile(sourcePath, '{"type":"session","id":"exhausted"}\n');
  // The consumed request, as the earlier stale-main recovery left it: it names the retired pane as source and target.
  const consumed = {
    schema: "atdd-flow/context-handover-replacement-request/v1", seat: address, task: takeover,
    handover: { id: "H-20261031T051530Z-main-incident-context", sha256: "1".repeat(64) }, authorization: { id: "A-old", hash: "2".repeat(64) },
    source: { pi_session: sourceSession, pi_session_path: sourcePath, herdr_session: herdrSession, pane: retired },
    target: { herdr_session: herdrSession, pane: retired, cwd }, created_at: "2026-10-31T05:16:08.075Z",
    stale_main_recovery: {
      canonical_source: { pi_session: canonicalSession, pi_session_path: canonicalPath, herdr_session: herdrSession, pane: retired, cwd, launch_receipt: join(root, "gone-receipt.yaml") },
      prior_receipt: { path: join(root, "gone-receipt.yaml"), sha256: "3".repeat(64), archive: join(root, "gone-archive.yaml") },
    },
  };
  const receipt = join(root, ".atdd-flow", "runtime-launch", `${sourceSession}-e858a282.yaml`);
  await atomicYaml(receipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, tasks: [takeover], candidate: "economy",
    pi_session: sourceSession, pi_session_path: sourcePath, herdr_session: herdrSession, pane: retired,
    handover_replacement: { request: consumed, successor_session: sourceSession },
    relocation: { source_herdr_session: herdrSession, source_pane: retired, authorization: { id: "A-old", hash: "2".repeat(64) } },
    created_at: "2026-10-31T05:16:20.000Z",
  });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project, worktree: cwd, branch: "main",
    runtime: { application: "herdr", wake: "native", addresses: { herdr: { session: herdrSession, pane: options.locator ?? current } }, pi_session: sourceSession, pi_session_path: sourcePath, launch_receipt: receipt },
  });
  await atomicYaml(paths(root).handoverFile(address), { schema: "atdd-workflow/handover/v1", seat: address, handover_id: handover, supersedes: "none", recorded_at: "2026-11-03T01:00:00.000Z", text: "exact handover" });
  await atomicYaml(paths(root).taskFile(project, takeover), { schema: "atdd-workflow/task/v1", title: "Main takeover", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Recovered." }] });
  if (options.twoReady) await atomicYaml(paths(root).taskFile(project, "another-ready"), { schema: "atdd-workflow/task/v1", title: "Other", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "x" }] });
  const active = handoverReplacementPath(root, address);
  if (!options.noActive) await atomicYaml(active, consumed);
  if (options.authorize !== false) {
    await createExactSessionAdoptionAuthorization(root, authorizationId, [
      "--by", "operator@desk", "--seat", address, "--pi-session", sourceSession, "--pi-session-path", sourcePath,
      "--source-herdr-session", herdrSession, "--source-pane", retired, "--target-herdr-session", herdrSession, "--target-pane", current, "--target-cwd", cwd,
    ]);
  }
  const fake = harness(root, options, sourcePath);
  const args = ["--recover-stale-main", "--handover", handover, "--authorization", authorizationId, "--takeover-task", takeover,
    "--source-pi-session", sourceSession, "--source-pi-session-path", sourcePath, "--source-herdr-session", herdrSession, "--source-pane", retired,
    "--herdr-session", herdrSession, "--target-pane", current, "--target-cwd", cwd];
  const succeed = () => requestHandoverReplacement(root, address, args, { command: fake.command, at: () => verifiedAt });
  const launch = (extra: string[] = []) => launchPiRuntime(root, address, ["--herdr-session", herdrSession, ...extra],
    { command: fake.command, select: selectEconomy, at: () => verifiedAt, hostPane: options.hostPane });
  return {
    root, active, sourcePath, receipt, fake, succeed, launch,
    activeBefore: options.noActive ? undefined : await readFile(active, "utf8"),
    seatBefore: await readFile(paths(root).seatFile(address), "utf8"), receiptBefore: await readFile(receipt, "utf8"),
  };
}

/** Fake Herdr: the retired pane is closed; the current pane is an available shell until a Pi is started on it. */
function harness(root: string, options: Options, sourcePath: string) {
  const calls: string[][] = [];
  let writerPath: string | undefined = options.targetOccupied ? join(root, "intruder_99999999-9999-4999-8999-999999999999.jsonl") : undefined;
  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const agent = (path: string, pane: string) => ({ name: "flow-main-incident", agent: "pi", pane_id: pane, agent_status: "idle", agent_session: session(path), cwd });
  const command = async (argv: string[]) => {
    calls.push(argv);
    const op = argv.slice(3);
    if (op[0] === "workspace" && op[1] === "list") return JSON.stringify({ result: { workspaces: [{ workspace_id: "w5", label: project, worktree: { checkout_path: cwd } }] } });
    if (op[0] === "tab" && op[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "w5:t5", workspace_id: "w5", label: address }] } });
    if (op[0] === "pane" && op[1] === "list") return JSON.stringify({ result: { panes: [
      { pane_id: current, tab_id: "w5:t5", label: address, agent: writerPath ? "pi" : null, agent_status: writerPath ? "idle" : "unknown" },
      ...(options.retiredPanePresent ? [{ pane_id: retired, tab_id: "w5:t1", agent: null }] : [])] } });
    if (op[0] === "pane" && op[1] === "get") return JSON.stringify({ result: { pane: writerPath
      ? { pane_id: current, agent: "pi", agent_status: "idle", agent_session: session(writerPath), cwd, label: address }
      : { pane_id: current, agent: null, agent_status: "unknown", agent_session: null, cwd, label: address } } });
    if (op[0] === "pane" && op[1] === "process-info") return JSON.stringify({ result: { process_info: { pane_id: current, shell_pid: 42,
      foreground_processes: writerPath ? [{ name: "node", argv0: "pi", pid: 100, cwd }] : [{ name: "zsh", argv0: "zsh", pid: 42, cwd }] } } });
    if (op[0] === "agent" && op[1] === "get") return JSON.stringify({ result: { agent: agent(writerPath!, current) } });
    if (op[0] === "agent" && op[1] === "list") return JSON.stringify({ result: { agents: [
      ...(writerPath ? [agent(writerPath, current)] : []), ...(options.sourceListed ? [agent(sourcePath, "w5:pZ")] : [])] } });
    if (op[0] === "pane" && op[1] === "run") return JSON.stringify({ result: { pane_id: current } });
    if (op[0] === "agent" && op[1] === "start") {
      const args = op.slice(op.indexOf("--") + 1);
      writerPath = join(root, `fresh_${args[args.indexOf("--session-id") + 1]}.jsonl`);
      await writeFile(writerPath, '{"type":"session"}\n');
      return JSON.stringify({ result: { name: "flow-main-incident" } });
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

async function succeeded(options: Options = {}) {
  const value = await fixture(options);
  await value.succeed();
  return value;
}

async function refusedUnchanged(options: Options, match: string, step: "succeed" | "launch" = "succeed") {
  const value = await fixture(options);
  if (step === "launch") await value.succeed();
  const activeNow = await Bun.file(value.active).exists() ? await readFile(value.active, "utf8") : undefined;
  const seatNow = await readFile(paths(value.root).seatFile(address), "utf8");
  const mutationsBefore = value.fake.calls.filter(mutating).length;
  const error = await (step === "launch" ? value.launch() : value.succeed()).then(() => undefined, (cause: Error) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toContain(match);
  expect(await Bun.file(value.active).exists() ? await readFile(value.active, "utf8") : undefined).toBe(activeNow);
  expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(seatNow);
  expect(await readFile(value.receipt, "utf8")).toBe(value.receiptBefore);
  expect(value.fake.calls.filter(mutating).length).toBe(mutationsBefore);
  return value;
}

for (const locator of [current, `${herdrSession}/${current}`]) {
  test(`RED: a consumed request, closed source pane and seat locator ${locator} succeed to a fresh RESUMED main through public commands`, async () => {
    const value = await succeeded({ locator });
    const request = await readYaml<HandoverReplacementRequest & Record<string, any>>(value.active);
    expect(request).toMatchObject({
      task: takeover, handover: { id: handover }, authorization: { id: authorizationId },
      source: { pi_session: sourceSession, pi_session_path: value.sourcePath, herdr_session: herdrSession, pane: retired },
      target: { herdr_session: herdrSession, pane: current, cwd },
    });
    // The consumed request is archived by hash, create-only, with its exact bytes.
    const prior = request.stale_main_recovery.prior_request;
    expect(prior.sha256).toBe(sha256(value.activeBefore!));
    expect(prior.archive.endsWith(`${prior.sha256}.yaml`)).toBe(true);
    expect(await readFile(prior.archive, "utf8")).toBe(value.activeBefore!);
    expect(request.stale_main_recovery.relocation).toMatchObject({ retired: { herdr_session: herdrSession, pane: retired }, absence: { verified_at: verifiedAt } });
    // Evidence only: the seat, the receipt and Herdr are untouched.
    expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(value.seatBefore);
    expect(await readFile(value.receipt, "utf8")).toBe(value.receiptBefore);
    expect(value.fake.calls.some(mutating)).toBe(false);

    // Ordinary fresh launch (no adoption, no resume): a new session in the available shell pane.
    const dry = await value.launch(["--dry-run"]);
    expect(dry.pane).toBe(current);
    const launched = await value.launch();
    expect(launched.piSession).not.toBe(sourceSession);
    const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(address));
    expect(seat.runtime).toMatchObject({ pi_session: launched.piSession, addresses: { herdr: { session: herdrSession, pane: current } }, launch_receipt: launched.receipt });
    expect(await readYaml<Record<string, any>>(launched.receipt)).toMatchObject({ pi_session: launched.piSession, handover_replacement: { request, successor_session: launched.piSession } });
    expect(JSON.stringify(value.fake.calls)).not.toContain(`--session\",\"${value.sourcePath}`);

    await registerRuntimeState(value.root, { seat: address, owner_token: `owner-${launched.piSession}`, pid: 84314, model: "economy", cwd }, verifiedAt);
    const result = await resumed(value.root);
    expect(result.output).toContain("RESUMED; verified 6/6; discrepancies: none.");
    expect(result.exitCode).toBe(0);
  }, 60_000);
}

test("a consumed request is only replaced once: the new request is consumed by the launch and cannot launch twice", async () => {
  const value = await succeeded();
  await value.launch();
  await expect(value.launch()).rejects.toThrow();
});

test("a missing active request still succeeds without an archive", async () => {
  const value = await succeeded({ noActive: true });
  const request = await readYaml<Record<string, any>>(value.active);
  expect(request.stale_main_recovery.prior_request).toBeUndefined();
  expect((await value.launch()).pane).toBe(current);
});

test("fail-closed: source Pi still listed as a live agent", async () => { await refusedUnchanged({ sourceListed: true }, "exact recorded Pi is still a live Pi agent"); });
test("fail-closed: retired source pane still listed by Herdr", async () => { await refusedUnchanged({ retiredPanePresent: true }, "still listed"); });
test("fail-closed: target pane is occupied by a Pi", async () => { await refusedUnchanged({ targetOccupied: true }, "available shell", "launch"); });
test("fail-closed: host pane is the target pane", async () => { await refusedUnchanged({ hostPane: current }, "different pane", "launch"); });
test("fail-closed: no operator authorization record", async () => { await refusedUnchanged({ authorize: false }, "operator authorization record"); });
test("fail-closed: two ready takeover tasks", async () => { await refusedUnchanged({ twoReady: true }, "exactly one ready"); });

test("fail-closed: the new request cannot launch once the seat runtime no longer matches it", async () => {
  const moved = await succeeded();
  const seat = await readYaml<Record<string, any>>(paths(moved.root).seatFile(address));
  seat.runtime.pi_session = "44444444-4444-4444-8444-444444444444";
  await atomicYaml(paths(moved.root).seatFile(address), seat);
  await expect(moved.launch()).rejects.toThrow("Path-A replacement source tuple no longer matches");
});

test("binding a Herdr pane typed as <session>/<pane> records the pane id, not the session-qualified text", async () => {
  const value = await fixture();
  await bind(value.root, address, ["--application", "herdr", "--address", `${herdrSession}/${current}`, "--session", herdrSession]);
  const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(address));
  expect(seat.runtime.addresses.herdr).toEqual({ session: herdrSession, pane: current });
});
