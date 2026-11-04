// URN: test:atdd-flow:patha-stale-request-archive
// Acceptance: acc:flow:E005-UNIT-001
// Phase: UNIT
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createExactSessionAdoptionAuthorization, resolveExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml, yaml } from "../src/core";
import { handoverReplacementPath, requestHandoverReplacement, type HandoverReplacementDependencies, type HandoverReplacementRequest } from "../src/handover";

// Isolated fixtures only: every path lives under a fresh tmp Desk; no live Desk, Herdr or Pi is touched.
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const projectName = "atdd-flow", address = `main@${projectName}`;
const recordedSession = "01a1a1a1-0000-7000-8000-00000000aaaa";
const recordedPath = `/tmp/sessions/2026-11-04T10-00-00-000Z_${recordedSession}.jsonl`;
const oldSession = "01a1a1a1-0000-7000-8000-00000000bbbb";
const oldPath = `/tmp/sessions/2026-10-31T10-00-00-000Z_${oldSession}.jsonl`;
const session = "forge", pane = "w5:p1", cwd = "/tmp/atdd-flow-main-fixture";
const priorTask = "main-successor-20261031", takeoverTask = "main-successor-20261104";
const priorHandover = "H-20261031T000000Z-main-atdd-flow-successor", currentHandover = "H-20261104T100000Z-main-atdd-flow-successor";
const freshAuthorization = "A-20261104-pathA-main-atdd-flow", priorAuthorization = "A-20261031-pathA-main-atdd-flow";
const flag = "--archive-stale-request";

type Value = Awaited<ReturnType<typeof fixture>>;
type Options = { priorTaskStatus?: string; priorRequest?: (prior: HandoverReplacementRequest) => unknown; reuseAuthorization?: boolean };

function handoverText(id: string) {
  return `HANDOVER ${address} | 2026-11-04T10:00:00Z | handover-id ${id} | supersedes ${priorHandover}\nRuntime: herdr ${session}:${pane} | pi session ${recordedSession} | model test/pi | context 80%\n\n1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS\n- exact\n\n2. OPEN WORK AND IN-FLIGHT OPERATIONS\n- exact\n\n3. DEPENDENCIES (both directions)\n- none\n\n4. RESUME PROCEDURE AND NEXT ACTIONS\n- exact\n`;
}

async function fixture(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-patha-archive-"));
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr" });
  await atomicYaml(paths(root).projectFile(projectName), { schema: "atdd-workflow/project/v1", project: projectName, repository: cwd, roles: {} });
  // The recorded runtime is a Flow-launched Pi whose launch receipt does NOT embed the stale Oct-31 request,
  // so --supersede-consumed cannot prove it consumed, and the source IS the recorded runtime so --recover-stale-main refuses.
  const receipt = join(root, ".atdd-flow", "runtime-launch", `${recordedSession}-receipt.yaml`);
  await atomicYaml(receipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, tasks: ["rebound-later-20261102"],
    pi_session: recordedSession, pi_session_path: recordedPath, herdr_session: session, pane, created_at: "2026-11-02T00:00:00.000Z",
  });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project: projectName, worktree: cwd, branch: "main",
    runtime: { application: "herdr", addresses: { herdr: { session, pane } }, pi_session: recordedSession, pi_session_path: recordedPath, launch_receipt: receipt },
  });
  await atomicYaml(paths(root).handoverFile(address), {
    schema: "atdd-workflow/handover/v1", seat: address, handover_id: currentHandover, supersedes: priorHandover,
    recorded_at: "2026-11-04T10:00:00.000Z", text: handoverText(currentHandover),
  });
  await atomicYaml(paths(root).taskFile(projectName, priorTask), {
    schema: "atdd-workflow/task/v1", title: "Prior takeover", status: options.priorTaskStatus ?? "done", coordinator: address, assignee: address,
    done_when: [{ text: "Prior successor resumed.", proof: "receipt" }],
  });
  await atomicYaml(paths(root).taskFile(projectName, takeoverTask), {
    schema: "atdd-workflow/task/v1", title: "Fresh takeover", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Fresh successor resumes." }],
  });
  const tuple = { seat: address, pi_session: recordedSession, pi_session_path: recordedPath, source: { herdr_session: session, pane }, target: { herdr_session: session, pane, cwd } };
  const authorize = (id: string, overrides: string[] = []) => createExactSessionAdoptionAuthorization(root, id, [
    "--by", "operator@desk", "--seat", address, "--pi-session", recordedSession, "--pi-session-path", recordedPath,
    "--source-herdr-session", session, "--source-pane", pane, "--target-herdr-session", session, "--target-pane", pane, "--target-cwd", cwd, ...overrides,
  ]);
  const stdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { await authorize(freshAuthorization); await authorize(priorAuthorization, []); } finally { process.stdout.write = stdout; }
  const fresh = await resolveExactSessionAdoptionAuthorization(root, freshAuthorization, tuple);
  const priorAuth = options.reuseAuthorization ? fresh : { id: priorAuthorization, hash: createHash("sha256").update(priorAuthorization).digest("hex") };
  const prior: HandoverReplacementRequest = {
    schema: "atdd-flow/context-handover-replacement-request/v1", seat: address, task: priorTask,
    handover: { id: priorHandover, sha256: "18bc3ac546de35157fc722b6a703363381fc49c6b3fe4fbcbaa7a3896e5a39b8" },
    authorization: priorAuth, source: { pi_session: oldSession, pi_session_path: oldPath, herdr_session: session, pane },
    target: { herdr_session: session, pane, cwd }, created_at: "2026-10-31T10:00:00.000Z",
  };
  const active = handoverReplacementPath(root, address);
  await mkdir(join(active, ".."), { recursive: true });
  if (options.priorRequest) await writeFile(active, typeof options.priorRequest(prior) === "string" ? options.priorRequest(prior) as string : yaml.print(options.priorRequest(prior)));
  else await atomicYaml(active, prior);
  const priorBytes = await readFile(active, "utf8");
  const priorSha = createHash("sha256").update(priorBytes).digest("hex");
  const archive = join(root, ".atdd-flow", "handover-replacement-stale-archive", encodeURIComponent(address), priorSha);
  const args = (...extra: string[]) => [
    ...extra, "--handover", currentHandover, "--authorization", freshAuthorization, "--takeover-task", takeoverTask,
    "--source-pi-session", recordedSession, "--source-pi-session-path", recordedPath, "--source-herdr-session", session, "--source-pane", pane,
    "--herdr-session", session, "--target-pane", pane, "--target-cwd", cwd,
  ];
  const calls: string[][] = [];
  const command = async (argv: string[]) => { calls.push(argv); throw new Error(`Unexpected Herdr command: ${argv.join(" ")}`); };
  return { root, active, archive, priorBytes, priorSha, prior, args, calls, command, authorize };
}

async function state(value: Value) {
  const read = async (file: string) => readFile(file, "utf8").catch(() => undefined);
  return {
    active: await read(value.active), seat: await read(paths(value.root).seatFile(address)), handover: await read(paths(value.root).handoverFile(address)),
    tasks: await readdir(paths(value.root).tasks(projectName)).catch(() => []),
    archiveRoot: await readdir(join(value.root, ".atdd-flow", "handover-replacement-stale-archive", encodeURIComponent(address))).catch(() => undefined),
    siblings: (await readdir(join(value.active, ".."))).sort(),
  };
}

async function run(value: Value, extra: string[], dependencies: HandoverReplacementDependencies = {}, overrides: (args: string[]) => string[] = (args) => args) {
  return requestHandoverReplacement(value.root, address, overrides(value.args(...extra)), { command: value.command, at: () => "2026-11-04T12:00:00.000Z", ...dependencies });
}

async function refused(value: Value, message: string | RegExp, extra: string[] = [flag], dependencies: HandoverReplacementDependencies = {}, overrides?: (args: string[]) => string[]) {
  const before = await state(value);
  await expect(run(value, extra, dependencies, overrides)).rejects.toThrow(message);
  expect(await state(value)).toEqual(before);
  expect(value.calls).toHaveLength(0);
}

async function withValue(options: Options, body: (value: Value) => Promise<void>) {
  const value = await fixture(options);
  try { await body(value); } finally { await rm(value.root, { recursive: true, force: true }); }
}

const replaceFlag = (args: string[], from: string, to: string) => args.map((arg, index) => args[index - 1] === from ? to : arg);

test("RED: CLI help exposes explicit --archive-stale-request without weakening the default guard", async () => {
  const child = Bun.spawn([process.execPath, cli, "--help"], { stdout: "pipe", stderr: "pipe" });
  const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
  await child.exited;
  expect(output).toContain("[--archive-stale-request]");
});

test("RED: the exact deadlock — ordinary, supersede and recover refuse unchanged; the flagged call archives by hash and permits the canonical released-source request", async () => {
  await withValue({}, async (value) => {
    await refused(value, "Path-A replacement request already exists", []);
    await refused(value, /Consumed Path-A replacement/, ["--supersede-consumed"]);
    await refused(value, "differs from the recorded runtime", ["--recover-stale-main"]);

    await run(value, [flag]);
    const request = await readYaml<HandoverReplacementRequest & { archived_request?: Record<string, string> }>(value.active);
    expect(request).toMatchObject({
      task: takeoverTask, handover: { id: currentHandover }, authorization: { id: freshAuthorization },
      source: { pi_session: recordedSession, pi_session_path: recordedPath, herdr_session: session, pane },
      target: { herdr_session: session, pane, cwd },
      archived_request: { path: value.active, sha256: value.priorSha, task: priorTask, archive: value.archive },
    });
    expect(request.supersession).toBeUndefined();
    expect(request.stale_main_recovery).toBeUndefined();
    expect(await readFile(join(value.archive, "request.yaml"), "utf8")).toBe(value.priorBytes);
    expect((await readdir(value.archive)).sort()).toEqual(["archive.yaml", "request.yaml"]);
    expect((await state(value)).siblings).toEqual([`${encodeURIComponent(address)}.yaml`]);
    expect(value.calls).toHaveLength(0);
    // One-shot: the fresh request is pending (its task is not terminal), so a second archive refuses and changes nothing.
    await refused(value, /prior takeover task to be terminal|already used/);
  });
});

test("RED: rollback restores the exact active bytes, removes a newly created archive and releases the lock when the swap fails after it renamed", async () => {
  await withValue({}, async (value) => {
    const before = await state(value);
    const swapThenFail = async (staged: string, active: string) => { await rename(staged, active); throw new Error("swap-failed-after-rename"); };
    await expect(run(value, [flag], { replaceActive: swapThenFail })).rejects.toThrow("swap-failed-after-rename");
    expect(await state(value)).toEqual(before);
    expect(await Bun.file(join(value.archive, "request.yaml")).exists()).toBe(false);
  });
});

test("RED: rollback leaves bytes unchanged when archive publication or successor staging fails", async () => {
  await withValue({}, async (value) => {
    await refused(value, "archive-publish-failed", [flag], { publishArchive: async () => { throw new Error("archive-publish-failed"); } });
    await refused(value, "successor-stage-failed", [flag], { publish: async () => { throw new Error("successor-stage-failed"); } });
  });
});

test("RED: a pre-existing byte-identical archive (crash after publish) is reused and a different one is refused", async () => {
  await withValue({}, async (value) => {
    await run(value, [flag]);
    const published = await readdir(value.archive);
    expect(published.length).toBe(2);
  });
  await withValue({}, async (value) => {
    await mkdir(value.archive, { recursive: true });
    await writeFile(join(value.archive, "request.yaml"), "different: bytes\n");
    await writeFile(join(value.archive, "archive.yaml"), "different: manifest\n");
    const before = await state(value);
    await expect(run(value, [flag])).rejects.toThrow("collides with different immutable evidence");
    expect(await state(value)).toEqual(before);
    expect(await readFile(join(value.archive, "request.yaml"), "utf8")).toBe("different: bytes\n");
  });
});

test("RED: a pending (non-terminal) prior takeover task keeps the request guard", async () => {
  for (const priorTaskStatus of ["todo", "in_progress", "blocked"]) {
    // A todo prior task is also a second ready takeover task, so the existing exactly-one-ready guard may refuse first.
    await withValue({ priorTaskStatus }, async (value) => refused(value, /prior takeover task to be terminal|exactly one ready/));
  }
});

test("RED: a reused authorization, wrong source, wrong target pane or cwd, or missing authorization refuses unchanged", async () => {
  await withValue({ reuseAuthorization: true }, async (value) => refused(value, /authorization.*(fresh|differ)|already used/i));
  await withValue({}, async (value) => refused(value, /exact live runtime|source tuple/, [flag], {}, (args) => replaceFlag(args, "--source-pi-session", oldSession)));
  await withValue({}, async (value) => refused(value, "exact released source pane", [flag], {}, (args) => replaceFlag(args, "--target-pane", "w5:p9")));
  await withValue({}, async (value) => refused(value, "exact canonical main worktree", [flag], {}, (args) => replaceFlag(args, "--target-cwd", "/tmp/other-worktree")));
  await withValue({}, async (value) => refused(value, /authorization/i, [flag], {}, (args) => replaceFlag(args, "--authorization", "A-does-not-exist")));
});

test("RED: a missing, malformed, wrong-seat or wrong-schema active request refuses unchanged", async () => {
  await withValue({ priorRequest: () => "not: [valid" }, async (value) => refused(value, /malformed|invalid/i));
  await withValue({ priorRequest: (prior) => ({ ...prior, seat: "main@other" }) }, async (value) => refused(value, /invalid/i));
  await withValue({ priorRequest: (prior) => ({ ...prior, schema: "wrong/v1" }) }, async (value) => refused(value, /invalid/i));
  await withValue({}, async (value) => {
    await rm(value.active);
    await expect(run(value, [flag])).rejects.toThrow(/does not exist/);
  });
});

test("RED: a live lock holder refuses and a malformed or foreign lock never lets the archive proceed", async () => {
  await withValue({}, async (value) => {
    await writeFile(`${value.active}.lock`, yaml.print({ schema: "atdd-flow/handover-replacement-supersession-lock/v1", seat: address, active_request_sha256: value.priorSha, pid: process.pid, token: "live-owner" }), { flag: "wx" });
    await refused(value, "already in progress");
  });
  await withValue({}, async (value) => {
    await writeFile(`${value.active}.lock`, "not: [yaml", { flag: "wx" });
    await refused(value, "lock is malformed");
  });
});

test("RED: --archive-stale-request cannot combine with another replacement mode", async () => {
  await withValue({}, async (value) => {
    for (const other of ["--supersede-consumed", "--recover-stale-main", "--legacy-source-bootstrap"]) {
      await refused(value, /cannot be combined/i, [flag, other]);
    }
  });
});
