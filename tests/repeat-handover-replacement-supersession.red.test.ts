// URN: test:atdd-flow:repeat-handover-replacement-supersession
// Acceptance: acc:flow:E005-UNIT-001
// Phase: UNIT
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml, yaml } from "../src/core";
import { handoverReplacementPath, replacementForMainLaunch, requestHandoverReplacement, type HandoverReplacementDependencies, type HandoverReplacementRequest } from "../src/handover";
import { launchPiRuntime } from "../src/seats";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const projectName = "frg-workstation", address = `main@${projectName}`;
const canonicalSession = "ed0280b7-ab1e-4f93-918a-ab9f6794413c";
const canonicalPath = "/Users/alecfokapu/.pi/agent/sessions/--Users-alecfokapu-Github-frg-workstation--/2026-10-19T08-22-48-930Z_ed0280b7-ab1e-4f93-918a-ab9f6794413c.jsonl";
const liveSession = "01a15391-2a48-7467-aedd-a13f993202d6";
const livePath = "/Users/alecfokapu/.pi/agent/sessions/--Users-alecfokapu-Github-frg-workstation--/2026-10-19T09-49-44-906Z_01a15391-2a48-7467-aedd-a13f993202d6.jsonl";
const pane = "w6:p6", cwd = "/Users/alecfokapu/Github/frg-workstation";
const consumedHandover = "H-20261019T073912Z-main-frg-workstation-successor";
const currentHandover = "H-20261019T143641Z-main-frg-workstation-successor";
const currentSupersedes = "H-20261019T143137Z-main-frg-workstation-successor";
const priorTask = "main-successor-20261019", takeoverTask = "main-sso-successor-20261019";
const authorizationId = "A-frg-main-sso-repeat-20261019";
const consumedRequestHash = "88574bdab0db6c9c3d6cb46204e90b568868e37b17d30a77b5ed53b071b1596c";

type Reports = {
  pane: string;
  agent: string;
  agentPane: string;
  sessionPath: string;
  agentSessionPath: string;
  cwd: string;
  writers: number;
  canonicalAgentPane?: string;
};

type RepeatDependencies = HandoverReplacementDependencies & { publishArchive?: (staging: string, destination: string) => Promise<void>; replaceActive?: (staged: string, active: string) => Promise<void> };

const requestWithDependencies = requestHandoverReplacement as unknown as
  (root: string, seat: string, args: string[], dependencies?: RepeatDependencies) => Promise<void>;

async function invoke(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

async function invokeAtRoot(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ATDD_WORKFLOW_ROOT: root, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

function handoverText(id: string, supersedes: string, sourceSession: string) {
  return `HANDOVER ${address} | 2026-10-19T14:36:41Z | handover-id ${id} | supersedes ${supersedes}\nRuntime: herdr forge:${pane} | pi session ${sourceSession} | model test/pi | context 80%\n\n1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS\n- exact\n\n2. OPEN WORK AND IN-FLIGHT OPERATIONS\n- exact\n\n3. DEPENDENCIES (both directions)\n- none\n\n4. RESUME PROCEDURE AND NEXT ACTIONS\n- exact\n`;
}

type FixtureShape = "direct" | "frg-canonical-source" | "frg-stale-canonical-source";

async function fixture(overrides: Partial<Reports> = {}, shape: FixtureShape = "direct") {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-repeat-handover-"));
  const bin = join(root, "bin"), pi = join(bin, "pi"), fakeHerdr = join(bin, "herdr");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await writeFile(fakeHerdr, `#!/bin/sh
case "$*" in
  *"pane get"*) printf '%s\\n' '${JSON.stringify({ result: { pane: { pane_id: pane, agent: "pi", agent_status: "idle", agent_session: { kind: "path", source: "herdr:pi", value: livePath }, cwd, label: address } } })}' ;;
  *"agent get"*) printf '%s\\n' '${JSON.stringify({ result: { agent: { name: "flow-main-frg-workstation", agent: "pi", pane_id: pane, agent_status: "idle", agent_session: { kind: "path", source: "herdr:pi", value: livePath }, cwd } } })}' ;;
  *"agent list"*) printf '%s\\n' '${JSON.stringify({ result: { agents: [{ name: "flow-main-frg-workstation", agent: "pi", pane_id: pane, agent_status: "idle", agent_session: { kind: "path", source: "herdr:pi", value: livePath }, cwd }] } })}' ;;
  *"pane process-info"*) printf '%s\\n' '${JSON.stringify({ result: { process_info: { pane_id: pane, shell_pid: 42, foreground_processes: [{ name: "node", argv0: "pi", pid: 100, cwd }] } } })}' ;;
  *) exit 2 ;;
esac
`);
  await Promise.all([chmod(pi, 0o755), chmod(fakeHerdr, 0o755)]);
  await atomicYaml(paths(root).desk, {
    schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi },
  });
  await atomicYaml(paths(root).models, {
    schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }],
  });
  await atomicYaml(paths(root).projectFile(projectName), {
    schema: "atdd-workflow/project/v1", project: projectName, repository: cwd, roles: {},
  });

  const sourceSession = shape === "frg-canonical-source" ? canonicalSession : liveSession;
  const sourcePath = shape === "frg-canonical-source" ? canonicalPath : livePath;
  const requestedHandover = shape === "direct" ? "H-direct-main-frg-workstation-successor" : currentHandover;
  const supersedes = shape === "direct" ? consumedHandover : currentSupersedes;
  const prior: HandoverReplacementRequest = {
    schema: "atdd-flow/context-handover-replacement-request/v1",
    seat: address,
    task: priorTask,
    handover: {
      id: consumedHandover,
      sha256: "18bc3ac546de35157fc722b6a703363381fc49c6b3fe4fbcbaa7a3896e5a39b8",
    },
    authorization: {
      id: "A-frg-main-path-a-20261019T0820Z",
      hash: "0942cfed6ba44dbc130c249fe67de65dd873128a5a6a8a322bc854ee0a738838",
    },
    source: {
      pi_session: "01a1531e-966a-744e-b902-dea5900e53a8",
      pi_session_path: "/Users/alecfokapu/.pi/agent/sessions/--Users-alecfokapu-Github-frg-workstation--/2026-10-19T07-44-35-947Z_01a1531e-966a-744e-b902-dea5900e53a8.jsonl",
      herdr_session: "forge",
      pane,
    },
    target: { herdr_session: "forge", pane, cwd },
    legacy_source: {
      authorization_hash: "0942cfed6ba44dbc130c249fe67de65dd873128a5a6a8a322bc854ee0a738838",
      pi_session: "01a1531e-966a-744e-b902-dea5900e53a8",
      pi_session_path: "/Users/alecfokapu/.pi/agent/sessions/--Users-alecfokapu-Github-frg-workstation--/2026-10-19T07-44-35-947Z_01a1531e-966a-744e-b902-dea5900e53a8.jsonl",
      herdr_session: "forge",
      pane,
      cwd,
      agent: "main-frg-workstation",
      verified_at: "2026-10-19T08:22:10.722Z",
    },
    created_at: "2026-10-19T08:22:10.722Z",
  };
  const active = handoverReplacementPath(root, address);
  await atomicYaml(active, prior);
  const priorBytes = await readFile(active, "utf8");
  const priorSha = createHash("sha256").update(priorBytes).digest("hex");
  expect(priorSha).toBe(consumedRequestHash);

  const receipt = join(root, ".atdd-flow", "runtime-launch", `${canonicalSession}-receipt.yaml`);
  await atomicYaml(receipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1",
    seat: address,
    tasks: [priorTask],
    candidate: "economy",
    pi_session: canonicalSession,
    pi_session_path: canonicalPath,
    herdr_session: "forge",
    pane,
    handover_replacement: { request: prior, successor_session: canonicalSession },
    created_at: "2026-10-19T08:22:51.906Z",
  });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project: projectName, worktree: cwd, branch: "main",
    runtime: {
      application: "herdr", addresses: { herdr: { session: "forge", pane } },
      pi_session: canonicalSession, pi_session_path: canonicalPath, launch_receipt: receipt,
    },
  });
  await atomicYaml(paths(root).handoverFile(address), {
    schema: "atdd-workflow/handover/v1", seat: address, handover_id: requestedHandover, supersedes,
    recorded_at: "2026-10-19T14:37:16.062Z", text: handoverText(requestedHandover, supersedes, sourceSession),
  });
  await atomicYaml(paths(root).taskFile(projectName, priorTask), {
    schema: "atdd-workflow/task/v1", title: "Prior takeover", status: "done", coordinator: address,
    assignee: address, done_when: [{ text: "Prior successor resumed.", proof: "receipt" }],
  });
  await atomicYaml(paths(root).taskFile(projectName, takeoverTask), {
    schema: "atdd-workflow/task/v1", title: "Next takeover", status: "todo", coordinator: address,
    assignee: address, done_when: [{ text: "Next successor resumes." }],
  });
  await createExactSessionAdoptionAuthorization(root, authorizationId, [
    "--by", "operator@desk", "--seat", address,
    "--pi-session", sourceSession, "--pi-session-path", sourcePath,
    "--source-herdr-session", "forge", "--source-pane", pane,
    "--target-herdr-session", "forge", "--target-pane", pane, "--target-cwd", cwd,
  ]);

  const reports: Reports = {
    pane, agent: "pi", agentPane: pane, sessionPath: sourcePath, agentSessionPath: sourcePath,
    cwd, writers: 1, ...overrides,
  };
  const calls: string[][] = [];
  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const command = async (command: string[]) => {
    calls.push(command);
    const operation = command.slice(3);
    if (operation[0] === "workspace" && operation[1] === "list") return JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: projectName, worktree: { checkout_path: cwd } }] } });
    if (operation[0] === "tab" && operation[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "w6:t1", workspace_id: "w6", label: address }] } });
    if (operation[0] === "pane" && operation[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: pane, tab_id: "w6:t1", label: address, agent: "pi", agent_status: "idle" }] } });
    if (operation[0] === "pane" && operation[1] === "get") return JSON.stringify({ result: { pane: {
      pane_id: reports.pane, agent: reports.agent, agent_status: "idle", agent_session: session(reports.sessionPath),
      cwd: reports.cwd, label: address,
    } } });
    if (operation[0] === "agent" && operation[1] === "get") return JSON.stringify({ result: { agent: {
      name: "flow-main-frg-workstation", agent: reports.agent, pane_id: reports.agentPane, agent_status: "idle",
      agent_session: session(reports.agentSessionPath), cwd: reports.cwd,
    } } });
    if (operation[0] === "agent" && operation[1] === "list") return JSON.stringify({ result: { agents: [
      { name: "flow-main-frg-workstation", agent: reports.agent, pane_id: reports.agentPane, agent_status: "idle", agent_session: session(reports.agentSessionPath), cwd: reports.cwd },
      ...(reports.canonicalAgentPane ? [{ name: "old-main-frg-workstation", agent: "pi", pane_id: reports.canonicalAgentPane, agent_status: "idle", agent_session: session(canonicalPath), cwd: reports.cwd }] : []),
    ] } });
    if (operation[0] === "pane" && operation[1] === "process-info") return JSON.stringify({ result: { process_info: {
      pane_id: pane, shell_pid: 42,
      foreground_processes: Array.from({ length: reports.writers }, (_, index) => ({ name: "node", argv0: "pi", pid: 100 + index, cwd: reports.cwd })),
    } } });
    throw new Error(`Unexpected Herdr command: ${command.join(" ")}`);
  };
  const args = [
    "--supersede-consumed", "--handover", requestedHandover, "--authorization", authorizationId,
    "--takeover-task", takeoverTask, "--source-pi-session", sourceSession,
    "--source-pi-session-path", sourcePath, "--source-herdr-session", "forge", "--source-pane", pane,
    "--herdr-session", "forge", "--target-pane", pane, "--target-cwd", cwd,
  ];
  const archive = join(root, ".atdd-flow", "handover-replacement-archive", encodeURIComponent(address), priorSha);
  return { root, active, archive, receipt, prior, priorBytes, priorSha, canonicalPath, livePath: sourcePath, args, command, calls, sourceSession, currentHandover: requestedHandover };
}

async function snapshot(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    active: await readFile(value.active, "utf8"),
    seat: await readFile(paths(value.root).seatFile(address), "utf8"),
    receipt: await readFile(value.receipt, "utf8"),
  };
}

const stalePid = 2_147_483_647;
const supersessionLock = (value: Awaited<ReturnType<typeof fixture>>) => `${value.active}.lock`;
async function writeSupersessionLock(value: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  await writeFile(supersessionLock(value), yaml.print({
    schema: "atdd-flow/handover-replacement-supersession-lock/v1", seat: address,
    active_request_sha256: value.priorSha, pid: stalePid, token: "stale-owner", ...overrides,
  }), { flag: "wx" });
}

async function stageExactArchive(value: Awaited<ReturnType<typeof fixture>>) {
  const receiptBytes = await readFile(value.receipt, "utf8");
  const receiptSha = createHash("sha256").update(receiptBytes).digest("hex");
  await mkdir(value.archive, { recursive: true });
  await Promise.all([
    writeFile(join(value.archive, "request.yaml"), value.priorBytes),
    writeFile(join(value.archive, "launch-receipt.yaml"), receiptBytes),
    writeFile(join(value.archive, "supersession.yaml"), yaml.print({
      schema: "atdd-flow/context-handover-replacement-supersession/v1", seat: address,
      prior_request: { path: value.active, sha256: value.priorSha, task: priorTask, handover: consumedHandover, handover_sha256: value.prior.handover.sha256 },
      prior_receipt: { path: value.receipt, sha256: receiptSha, successor_session: canonicalSession },
    })),
  ]);
}

async function assertUnchanged(value: Awaited<ReturnType<typeof fixture>>, before: Awaited<ReturnType<typeof snapshot>>) {
  expect(await snapshot(value)).toEqual(before);
  expect(await Bun.file(join(value.archive, "request.yaml")).exists()).toBe(false);
}

const mutatingHerdrCommand = (command: string[]) => command.some((part) => ["run", "start", "bind", "attach", "apply", "create", "rename"].includes(part));

async function cleanup(value: Awaited<ReturnType<typeof fixture>>) {
  await rm(value.root, { recursive: true, force: true });
}

test("RED: CLI exposes explicit consumed-request supersession without weakening default create-only replacement", async () => {
  const { output } = await invoke("--help");
  expect(output).toContain("handover replace <address> [--supersede-consumed]");
});

test("RED: public handover replace command accepts the exact FRG authorized source while canonical runtime is stale", async () => {
  const value = await fixture({}, "frg-stale-canonical-source");
  try {
    const before = await snapshot(value);
    const result = await invokeAtRoot(value.root, "handover", "replace", address, ...value.args);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain(`Recorded superseding Path-A replacement request for ${address}.`);
    const successor = await readYaml<HandoverReplacementRequest & { supersession?: Record<string, any> }>(value.active);
    expect(value.priorSha).toBe(consumedRequestHash);
    expect(successor).toMatchObject({
      task: takeoverTask,
      handover: { id: currentHandover },
      authorization: { id: authorizationId },
      source: { pi_session: liveSession, pi_session_path: livePath, herdr_session: "forge", pane },
      target: { herdr_session: "forge", pane, cwd },
      supersession: {
        prior_request: { sha256: consumedRequestHash, task: priorTask, handover: consumedHandover },
        canonical_source: { pi_session: canonicalSession, pi_session_path: canonicalPath, herdr_session: "forge", pane, cwd },
        live_source: { pi_session: liveSession, pi_session_path: livePath, herdr_session: "forge", pane, cwd },
      },
    });
    expect(await readFile(join(value.archive, "request.yaml"), "utf8")).toBe(value.priorBytes);
    expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(before.seat);
    expect(await readFile(value.receipt, "utf8")).toBe(before.receipt);
    expect(value.calls).toHaveLength(0);
  } finally { await cleanup(value); }
});

test("RED: the existing canonical-source fast path remains accepted for the exact current handover", async () => {
  const value = await fixture({}, "frg-canonical-source");
  try {
    await requestWithDependencies(value.root, address, value.args, { command: value.command });
    const successor = await readYaml<HandoverReplacementRequest & { supersession?: Record<string, any> }>(value.active);
    expect(successor).toMatchObject({
      handover: { id: currentHandover },
      source: { pi_session: canonicalSession, pi_session_path: canonicalPath },
      supersession: {
        prior_request: { sha256: consumedRequestHash },
        canonical_source: { pi_session: canonicalSession, pi_session_path: canonicalPath },
        live_source: { pi_session: canonicalSession, pi_session_path: canonicalPath },
      },
    });
    expect(value.calls.some(mutatingHerdrCommand)).toBe(false);
  } finally { await cleanup(value); }
});

test("RED: the prior canonical source occupying the authorized pane is a live competitor and refuses publication", async () => {
  const value = await fixture({ sessionPath: canonicalPath, agentSessionPath: canonicalPath }, "frg-stale-canonical-source");
  try {
    const before = await snapshot(value);
    await expect(requestWithDependencies(value.root, address, value.args, { command: value.command })).rejects.toThrow(
      "live pane/session/path/cwd does not match the authorized source tuple",
    );
    expect(value.calls.length).toBeGreaterThan(0);
    expect(value.calls.some(mutatingHerdrCommand)).toBe(false);
    await assertUnchanged(value, before);
  } finally { await cleanup(value); }
});

test("RED: the prior canonical source live on another pane refuses publication", async () => {
  const value = await fixture({ canonicalAgentPane: "w6:p9" }, "frg-stale-canonical-source");
  try {
    const before = await snapshot(value);
    await expect(requestWithDependencies(value.root, address, value.args, { command: value.command })).rejects.toThrow(
      "prior canonical source is still a live Pi agent",
    );
    expect(value.calls).toContainEqual(["herdr", "--session", "forge", "agent", "list"]);
    expect(value.calls.some(mutatingHerdrCommand)).toBe(false);
    await assertUnchanged(value, before);
  } finally { await cleanup(value); }
});

test("RED: duplicate Pi writers on the authorized stale-canonical source tuple refuse publication", async () => {
  const value = await fixture({ writers: 2 }, "frg-stale-canonical-source");
  try {
    const before = await snapshot(value);
    await expect(requestWithDependencies(value.root, address, value.args, { command: value.command })).rejects.toThrow(
      "exactly one live Pi writer",
    );
    expect(value.calls.length).toBeGreaterThan(0);
    expect(value.calls.some(mutatingHerdrCommand)).toBe(false);
    await assertUnchanged(value, before);
  } finally { await cleanup(value); }
});

test("RED: a consumed request and receipt are archived byte-identically before one stale-canonical successor becomes active", async () => {
  const value = await fixture();
  try {
    const before = await snapshot(value);
    await requestWithDependencies(value.root, address, value.args, { command: value.command, at: () => "2026-10-19T16:00:00.000Z" });
    const successor = await readYaml<HandoverReplacementRequest & { supersession?: Record<string, any> }>(value.active);
    expect(successor).toMatchObject({
      seat: address, task: takeoverTask, handover: { id: value.currentHandover }, authorization: { id: authorizationId },
      source: { pi_session: liveSession, pi_session_path: value.livePath, herdr_session: "forge", pane },
      supersession: {
        prior_request: { sha256: consumedRequestHash, task: priorTask, handover: consumedHandover },
        prior_receipt: { path: value.receipt, successor_session: canonicalSession },
        canonical_source: { pi_session: canonicalSession, pi_session_path: value.canonicalPath },
        live_source: { pi_session: liveSession, pi_session_path: value.livePath, pane, cwd },
      },
    });
    expect(await readFile(join(value.archive, "request.yaml"), "utf8")).toBe(value.priorBytes);
    expect(await readFile(join(value.archive, "launch-receipt.yaml"), "utf8")).toBe(before.receipt);
    expect(await Bun.file(join(value.archive, "supersession.yaml")).exists()).toBe(true);
    expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(before.seat);
    expect(await readFile(value.receipt, "utf8")).toBe(before.receipt);
    await expect(replacementForMainLaunch(value.root, await readYaml(paths(value.root).seatFile(address)), address)).resolves.toMatchObject({ request: { task: takeoverTask } });
    expect(value.calls.some(mutatingHerdrCommand)).toBe(false);
  } finally { await cleanup(value); }
});

test("RED: nonterminal prior takeover and missing or substituted prior receipt refuse before live observation", async () => {
  const cases: Array<[string, (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>]> = [
    ["prior todo", async (value) => { const task = await readYaml<any>(paths(value.root).taskFile(projectName, priorTask)); await atomicYaml(paths(value.root).taskFile(projectName, priorTask), { ...task, status: "todo" }); }],
    ["prior in progress", async (value) => { const task = await readYaml<any>(paths(value.root).taskFile(projectName, priorTask)); await atomicYaml(paths(value.root).taskFile(projectName, priorTask), { ...task, status: "in_progress" }); }],
    ["prior review", async (value) => { const task = await readYaml<any>(paths(value.root).taskFile(projectName, priorTask)); await atomicYaml(paths(value.root).taskFile(projectName, priorTask), { ...task, status: "review" }); }],
    ["missing receipt", async (value) => { await rm(value.receipt); }],
    ["substituted receipt", async (value) => { await atomicYaml(value.receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, pi_session: canonicalSession, handover_replacement: { request: { ...value.prior, task: "other" }, successor_session: canonicalSession } }); }],
  ];
  for (const [label, arrange] of cases) {
    const value = await fixture();
    try {
      await arrange(value);
      const before = await snapshot(value).catch(async () => ({ active: await readFile(value.active, "utf8"), seat: await readFile(paths(value.root).seatFile(address), "utf8"), receipt: "missing" }));
      await expect(requestWithDependencies(value.root, address, value.args, { command: value.command }), label).rejects.toThrow();
      expect(value.calls, `${label} validates before Herdr`).toHaveLength(0);
      expect(await readFile(value.active, "utf8")).toBe(before.active);
      expect(await readFile(paths(value.root).seatFile(address), "utf8")).toBe(before.seat);
      expect(await Bun.file(join(value.archive, "request.yaml")).exists()).toBe(false);
    } finally { await cleanup(value); }
  }
});

test("RED: handover, authorization, topology, and sole-ready-task mismatches fail before Herdr and publication", async () => {
  const cases: Array<[string, (value: Awaited<ReturnType<typeof fixture>>) => Promise<string[]>]> = [
    ["handover", async (value) => value.args.map((entry) => entry === value.currentHandover ? currentSupersedes : entry)],
    ["authorization tuple", async (value) => value.args.map((entry) => entry === value.livePath ? `${value.livePath}.wrong` : entry)],
    ["source session", async (value) => value.args.map((entry) => entry === value.sourceSession ? canonicalSession : entry)],
    ["canonical pane", async (value) => { const seat = await readYaml<any>(paths(value.root).seatFile(address)); await atomicYaml(paths(value.root).seatFile(address), { ...seat, runtime: { ...seat.runtime, addresses: { herdr: { session: "forge", pane: "w6:p9" } } } }); return value.args; }],
    ["wrong named task", async (value) => value.args.map((entry) => entry === takeoverTask ? priorTask : entry)],
    ["blocked task", async (value) => { const task = await readYaml<any>(paths(value.root).taskFile(projectName, takeoverTask)); await atomicYaml(paths(value.root).taskFile(projectName, takeoverTask), { ...task, blocker: "hold" }); return value.args; }],
    ["dependency waiting task", async (value) => {
      await atomicYaml(paths(value.root).taskFile(projectName, "dependency"), { schema: "atdd-workflow/task/v1", title: "Dependency", status: "in_progress", coordinator: address, done_when: [{ text: "Dependency" }] });
      const task = await readYaml<any>(paths(value.root).taskFile(projectName, takeoverTask));
      await atomicYaml(paths(value.root).taskFile(projectName, takeoverTask), { ...task, depends_on: ["dependency"] });
      return value.args;
    }],
    ["multiple ready tasks", async (value) => { await atomicYaml(paths(value.root).taskFile(projectName, "other-ready"), { schema: "atdd-workflow/task/v1", title: "Other", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Other" }] }); return value.args; }],
  ];
  for (const [label, arrange] of cases) {
    const value = await fixture();
    try {
      const args = await arrange(value), before = await snapshot(value);
      await expect(requestWithDependencies(value.root, address, args, { command: value.command }), label).rejects.toThrow();
      expect(value.calls, `${label} validates before Herdr`).toHaveLength(0);
      await assertUnchanged(value, before);
    } finally { await cleanup(value); }
  }
});

test("RED: missing, tampered, and reused authorization refuse before live Herdr observation", async () => {
  const cases: Array<[string, (value: Awaited<ReturnType<typeof fixture>>) => Promise<string[]>]> = [
    ["missing", async (value) => value.args.map((entry) => entry === authorizationId ? "A-missing" : entry)],
    ["tampered", async (value) => { const file = join(value.root, ".atdd-flow", "exact-session-adoption-authorizations", `${authorizationId}.yaml`); await writeFile(file, `${await readFile(file, "utf8")}\n# tampered\n`); return value.args; }],
    ["reused", async (value) => { await atomicYaml(join(value.root, ".atdd-flow", "runtime-launch", "used.yaml"), { schema: "atdd-flow/pi-runtime-launch-receipt/v1", relocation: { authorization: { id: authorizationId } } }); return value.args; }],
  ];
  for (const [label, arrange] of cases) {
    const value = await fixture();
    try {
      const args = await arrange(value), before = await snapshot(value);
      await expect(requestWithDependencies(value.root, address, args, { command: value.command }), label).rejects.toThrow("authorization");
      expect(value.calls).toHaveLength(0);
      await assertUnchanged(value, before);
    } finally { await cleanup(value); }
  }
});

test("RED: exact live source mismatches and zero or duplicate Pi writers refuse without mutating Herdr or Desk", async () => {
  const cases: Array<[string, Partial<Reports>]> = [
    ["pane", { pane: "w6:p9" }],
    ["agent pane", { agentPane: "w6:p9" }],
    ["agent kind", { agent: "codex" }],
    ["session path", { sessionPath: "/wrong/source.jsonl" }],
    ["agent session path", { agentSessionPath: "/wrong/agent.jsonl" }],
    ["cwd", { cwd: "/wrong/worktree" }],
    ["missing writer", { writers: 0 }],
    ["duplicate writer", { writers: 2 }],
  ];
  for (const [label, reports] of cases) {
    const value = await fixture(reports);
    try {
      const before = await snapshot(value);
      await expect(requestWithDependencies(value.root, address, value.args, { command: value.command }), label).rejects.toThrow();
      expect(value.calls.length, `${label} uses read-only live evidence`).toBeGreaterThan(0);
      expect(value.calls.some(mutatingHerdrCommand)).toBe(false);
      await assertUnchanged(value, before);
    } finally { await cleanup(value); }
  }
});

test("RED: archive and active-swap publication failures roll back to the byte-identical original state", async () => {
  const failures: Array<[string, RepeatDependencies]> = [
    ["archive", { publishArchive: async () => { throw new Error("injected archive publication failure"); } }],
    ["active swap", { replaceActive: async () => { throw new Error("injected active swap failure"); } }],
  ];
  for (const [label, dependencies] of failures) {
    const value = await fixture();
    try {
      const before = await snapshot(value);
      await expect(requestWithDependencies(value.root, address, value.args, { ...dependencies, command: value.command }), label).rejects.toThrow("injected");
      await assertUnchanged(value, before);
      const activeFolder = dirname(value.active);
      expect((await readdir(activeFolder)).filter((entry) => entry.includes("tmp"))).toEqual([]);
    } finally { await cleanup(value); }
  }
});

test("GREEN: a dead-owner lock recovers and reuses an exact crash-published archive", async () => {
  const value = await fixture();
  try {
    await stageExactArchive(value);
    await writeSupersessionLock(value);
    await requestWithDependencies(value.root, address, value.args, { command: value.command });
    expect((await readYaml<HandoverReplacementRequest>(value.active)).task).toBe(takeoverTask);
    expect(await readFile(join(value.archive, "request.yaml"), "utf8")).toBe(value.priorBytes);
    expect(await Bun.file(supersessionLock(value)).exists()).toBe(false);
  } finally { await cleanup(value); }
});

test("GREEN: live, malformed, and changed lock owners refuse without state or Herdr effects", async () => {
  const cases: Array<[string, (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>]> = [
    ["live", async (value) => writeSupersessionLock(value, { pid: process.pid, token: "live-owner" })],
    ["malformed", async (value) => { await writeFile(supersessionLock(value), "{not-valid-yaml", { flag: "wx" }); }],
    ["changed", async (value) => writeSupersessionLock(value, { active_request_sha256: "f".repeat(64) })],
  ];
  for (const [label, arrange] of cases) {
    const value = await fixture();
    try {
      await arrange(value);
      const before = await snapshot(value), lockBefore = await readFile(supersessionLock(value), "utf8");
      await expect(requestWithDependencies(value.root, address, value.args, { command: value.command }), label).rejects.toThrow();
      await assertUnchanged(value, before);
      expect(value.calls, `${label} refuses before Herdr`).toHaveLength(0);
      expect(await readFile(supersessionLock(value), "utf8")).toBe(lockBefore);
    } finally { await cleanup(value); }
  }
});

test("RED: concurrent supersession attempts after stale cleanup publish one successor and cannot overwrite its immutable archive", async () => {
  const value = await fixture();
  try {
    await writeSupersessionLock(value);
    const settled = await Promise.allSettled([
      requestWithDependencies(value.root, address, value.args, { command: value.command }),
      requestWithDependencies(value.root, address, value.args, { command: value.command }),
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect((await readYaml<HandoverReplacementRequest>(value.active)).task).toBe(takeoverTask);
    expect(await readFile(join(value.archive, "request.yaml"), "utf8")).toBe(value.priorBytes);
    expect(await Bun.file(supersessionLock(value)).exists()).toBe(false);
  } finally { await cleanup(value); }
});

test("RED: the normal launcher still refuses the occupied exact source before run, bind, or a new receipt", async () => {
  const value = await fixture();
  try {
    await requestWithDependencies(value.root, address, value.args, { command: value.command });
    value.calls.length = 0;
    await expect(launchPiRuntime(value.root, address, [
      "--pane", pane, "--herdr-session", "forge", "--adopt-session", value.livePath,
      "--source-herdr-session", "forge", "--source-pane", pane, "--authorization", authorizationId,
    ], {
      command: value.command,
      select: async () => ({ available: true as const, model: "test", selected_model: "economy", confidence: 0.99 }),
    })).rejects.toThrow("available shell pane");
    expect(value.calls.some(mutatingHerdrCommand)).toBe(false);
    expect((await readdir(join(value.root, ".atdd-flow", "runtime-launch"))).sort()).toEqual([`${canonicalSession}-receipt.yaml`]);
  } finally { await cleanup(value); }
});
