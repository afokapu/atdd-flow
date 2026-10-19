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

const cli = join(import.meta.dir, "..", "src", "cli.ts"), address = "main@demo";
const canonicalSession = "11111111-1111-4111-8111-111111111111", liveSession = "22222222-2222-4222-8222-222222222222";
const pane = "w6:p6", cwd = "/work/demo";

type Reports = {
  pane: string;
  agent: string;
  agentPane: string;
  sessionPath: string;
  agentSessionPath: string;
  cwd: string;
  writers: number;
};

type RepeatDependencies = HandoverReplacementDependencies & { publishArchive?: (staging: string, destination: string) => Promise<void>; replaceActive?: (staged: string, active: string) => Promise<void> };

const requestWithDependencies = requestHandoverReplacement as unknown as
  (root: string, seat: string, args: string[], dependencies?: RepeatDependencies) => Promise<void>;

async function invoke(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

function handoverText() {
  return `HANDOVER ${address} | 2026-10-19T14:31:37Z | handover-id H-current | supersedes H-prior\nRuntime: herdr forge:${pane} | pi session ${liveSession} | model test/pi | context 80%\n\n1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS\n- exact\n\n2. OPEN WORK AND IN-FLIGHT OPERATIONS\n- exact\n\n3. DEPENDENCIES (both directions)\n- none\n\n4. RESUME PROCEDURE AND NEXT ACTIONS\n- exact\n`;
}

async function fixture(overrides: Partial<Reports> = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-repeat-handover-"));
  const bin = join(root, "bin"), pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, {
    schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi },
  });
  await atomicYaml(paths(root).models, {
    schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }],
  });
  await atomicYaml(paths(root).projectFile("demo"), {
    schema: "atdd-workflow/project/v1", project: "demo", repository: cwd, roles: {},
  });

  const canonicalPath = join(root, `canonical_${canonicalSession}.jsonl`);
  const livePath = join(root, `live_${liveSession}.jsonl`);
  await writeFile(canonicalPath, "canonical predecessor session");
  await writeFile(livePath, "exact live source session");

  const prior: HandoverReplacementRequest = {
    schema: "atdd-flow/context-handover-replacement-request/v1",
    seat: address,
    task: "prior-takeover",
    handover: { id: "H-prior", sha256: "a".repeat(64) },
    authorization: { id: "A-prior", hash: "b".repeat(64) },
    source: {
      pi_session: "00000000-0000-4000-8000-000000000000",
      pi_session_path: join(root, "prior_00000000-0000-4000-8000-000000000000.jsonl"),
      herdr_session: "forge",
      pane,
    },
    target: { herdr_session: "forge", pane, cwd },
    created_at: "2026-10-19T07:39:12.000Z",
  };
  const active = handoverReplacementPath(root, address);
  await atomicYaml(active, prior);
  const priorBytes = await readFile(active, "utf8");
  const priorSha = createHash("sha256").update(priorBytes).digest("hex");

  const receipt = join(root, ".atdd-flow", "runtime-launch", "prior-successor.yaml");
  await atomicYaml(receipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1",
    seat: address,
    tasks: ["prior-takeover"],
    candidate: "economy",
    pi_session: canonicalSession,
    pi_session_path: canonicalPath,
    herdr_session: "forge",
    pane,
    handover_replacement: { request: prior, successor_session: canonicalSession },
    created_at: "2026-10-19T07:45:00.000Z",
  });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project: "demo", worktree: cwd, branch: "main",
    runtime: {
      application: "herdr", addresses: { herdr: { session: "forge", pane } },
      pi_session: canonicalSession, pi_session_path: canonicalPath, launch_receipt: receipt,
    },
  });
  await atomicYaml(paths(root).handoverFile(address), {
    schema: "atdd-workflow/handover/v1", seat: address, handover_id: "H-current", supersedes: "H-prior",
    recorded_at: "2026-10-19T14:31:37.000Z", text: handoverText(),
  });
  await atomicYaml(paths(root).taskFile("demo", "prior-takeover"), {
    schema: "atdd-workflow/task/v1", title: "Prior takeover", status: "done", coordinator: address,
    assignee: address, done_when: [{ text: "Prior successor resumed.", proof: "receipt" }],
  });
  await atomicYaml(paths(root).taskFile("demo", "next-takeover"), {
    schema: "atdd-workflow/task/v1", title: "Next takeover", status: "todo", coordinator: address,
    assignee: address, done_when: [{ text: "Next successor resumes." }],
  });
  await createExactSessionAdoptionAuthorization(root, "A-next", [
    "--by", "operator@desk", "--seat", address,
    "--pi-session", liveSession, "--pi-session-path", livePath,
    "--source-herdr-session", "forge", "--source-pane", pane,
    "--target-herdr-session", "forge", "--target-pane", pane, "--target-cwd", cwd,
  ]);

  const reports: Reports = {
    pane, agent: "pi", agentPane: pane, sessionPath: livePath, agentSessionPath: livePath,
    cwd, writers: 1, ...overrides,
  };
  const calls: string[][] = [];
  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const command = async (command: string[]) => {
    calls.push(command);
    const operation = command.slice(3);
    if (operation[0] === "workspace" && operation[1] === "list") return JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: "demo", worktree: { checkout_path: cwd } }] } });
    if (operation[0] === "tab" && operation[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "w6:t1", workspace_id: "w6", label: address }] } });
    if (operation[0] === "pane" && operation[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: pane, tab_id: "w6:t1", label: address, agent: "pi", agent_status: "idle" }] } });
    if (operation[0] === "pane" && operation[1] === "get") return JSON.stringify({ result: { pane: {
      pane_id: reports.pane, agent: reports.agent, agent_status: "idle", agent_session: session(reports.sessionPath),
      cwd: reports.cwd, label: address,
    } } });
    if (operation[0] === "agent" && operation[1] === "get") return JSON.stringify({ result: { agent: {
      name: "flow-main-demo", agent: reports.agent, pane_id: reports.agentPane, agent_status: "idle",
      agent_session: session(reports.agentSessionPath), cwd: reports.cwd,
    } } });
    if (operation[0] === "pane" && operation[1] === "process-info") return JSON.stringify({ result: { process_info: {
      pane_id: pane, shell_pid: 42,
      foreground_processes: Array.from({ length: reports.writers }, (_, index) => ({ name: "node", argv0: "pi", pid: 100 + index, cwd: reports.cwd })),
    } } });
    throw new Error(`Unexpected Herdr command: ${command.join(" ")}`);
  };
  const args = [
    "--supersede-consumed", "--handover", "H-current", "--authorization", "A-next",
    "--takeover-task", "next-takeover", "--source-pi-session", liveSession,
    "--source-pi-session-path", livePath, "--source-herdr-session", "forge", "--source-pane", pane,
    "--herdr-session", "forge", "--target-pane", pane, "--target-cwd", cwd,
  ];
  const archive = join(root, ".atdd-flow", "handover-replacement-archive", encodeURIComponent(address), priorSha);
  return { root, active, archive, receipt, prior, priorBytes, priorSha, canonicalPath, livePath, args, command, calls };
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
      prior_request: { path: value.active, sha256: value.priorSha, task: "prior-takeover", handover: "H-prior", handover_sha256: "a".repeat(64) },
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

test("RED: a consumed request and receipt are archived byte-identically before one stale-canonical successor becomes active", async () => {
  const value = await fixture();
  try {
    const before = await snapshot(value);
    await requestWithDependencies(value.root, address, value.args, { command: value.command, at: () => "2026-10-19T16:00:00.000Z" });
    const successor = await readYaml<HandoverReplacementRequest & { supersession?: Record<string, any> }>(value.active);
    expect(successor).toMatchObject({
      seat: address, task: "next-takeover", handover: { id: "H-current" }, authorization: { id: "A-next" },
      source: { pi_session: liveSession, pi_session_path: value.livePath, herdr_session: "forge", pane },
      supersession: {
        prior_request: { sha256: value.priorSha, task: "prior-takeover", handover: "H-prior" },
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
    await expect(replacementForMainLaunch(value.root, await readYaml(paths(value.root).seatFile(address)), address)).resolves.toMatchObject({ request: { task: "next-takeover" } });
    expect(value.calls.some(mutatingHerdrCommand)).toBe(false);
  } finally { await cleanup(value); }
});

test("RED: nonterminal prior takeover and missing or substituted prior receipt refuse before live observation", async () => {
  const cases: Array<[string, (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>]> = [
    ["prior todo", async (value) => { const task = await readYaml<any>(paths(value.root).taskFile("demo", "prior-takeover")); await atomicYaml(paths(value.root).taskFile("demo", "prior-takeover"), { ...task, status: "todo" }); }],
    ["prior in progress", async (value) => { const task = await readYaml<any>(paths(value.root).taskFile("demo", "prior-takeover")); await atomicYaml(paths(value.root).taskFile("demo", "prior-takeover"), { ...task, status: "in_progress" }); }],
    ["prior review", async (value) => { const task = await readYaml<any>(paths(value.root).taskFile("demo", "prior-takeover")); await atomicYaml(paths(value.root).taskFile("demo", "prior-takeover"), { ...task, status: "review" }); }],
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
    ["handover", async (value) => value.args.map((entry) => entry === "H-current" ? "H-wrong" : entry)],
    ["authorization tuple", async (value) => value.args.map((entry) => entry === value.livePath ? `${value.livePath}.wrong` : entry)],
    ["canonical pane", async (value) => { const seat = await readYaml<any>(paths(value.root).seatFile(address)); await atomicYaml(paths(value.root).seatFile(address), { ...seat, runtime: { ...seat.runtime, addresses: { herdr: { session: "forge", pane: "w6:p9" } } } }); return value.args; }],
    ["wrong named task", async (value) => value.args.map((entry) => entry === "next-takeover" ? "prior-takeover" : entry)],
    ["blocked task", async (value) => { const task = await readYaml<any>(paths(value.root).taskFile("demo", "next-takeover")); await atomicYaml(paths(value.root).taskFile("demo", "next-takeover"), { ...task, blocker: "hold" }); return value.args; }],
    ["dependency waiting task", async (value) => {
      await atomicYaml(paths(value.root).taskFile("demo", "dependency"), { schema: "atdd-workflow/task/v1", title: "Dependency", status: "in_progress", coordinator: address, done_when: [{ text: "Dependency" }] });
      const task = await readYaml<any>(paths(value.root).taskFile("demo", "next-takeover"));
      await atomicYaml(paths(value.root).taskFile("demo", "next-takeover"), { ...task, depends_on: ["dependency"] });
      return value.args;
    }],
    ["multiple ready tasks", async (value) => { await atomicYaml(paths(value.root).taskFile("demo", "other-ready"), { schema: "atdd-workflow/task/v1", title: "Other", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Other" }] }); return value.args; }],
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
    ["missing", async (value) => value.args.map((entry) => entry === "A-next" ? "A-missing" : entry)],
    ["tampered", async (value) => { const file = join(value.root, ".atdd-flow", "exact-session-adoption-authorizations", "A-next.yaml"); await writeFile(file, `${await readFile(file, "utf8")}\n# tampered\n`); return value.args; }],
    ["reused", async (value) => { await atomicYaml(join(value.root, ".atdd-flow", "runtime-launch", "used.yaml"), { schema: "atdd-flow/pi-runtime-launch-receipt/v1", relocation: { authorization: { id: "A-next" } } }); return value.args; }],
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
    expect((await readYaml<HandoverReplacementRequest>(value.active)).task).toBe("next-takeover");
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
    expect((await readYaml<HandoverReplacementRequest>(value.active)).task).toBe("next-takeover");
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
      "--source-herdr-session", "forge", "--source-pane", pane, "--authorization", "A-next",
    ], {
      command: value.command,
      select: async () => ({ available: true as const, model: "test", selected_model: "economy", confidence: 0.99 }),
    })).rejects.toThrow("available shell pane");
    expect(value.calls.some(mutatingHerdrCommand)).toBe(false);
    expect((await readdir(join(value.root, ".atdd-flow", "runtime-launch"))).sort()).toEqual(["prior-successor.yaml"]);
  } finally { await cleanup(value); }
});
