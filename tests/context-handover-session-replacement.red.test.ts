// URN: test:atdd-flow:context-handover-session-replacement
// Acceptance: acc:flow:E003-UNIT-001
// Phase: UNIT
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { handoverReplacementPath, replacementForMainLaunch, requestHandoverReplacement, type HandoverReplacementRequest } from "../src/handover";
import { launchPiRuntime } from "../src/seats";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const extension = join(import.meta.dir, "..", "extensions", "pi", "index.ts");

async function invoke(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

test("RED: CLI advertises the supported Path-A replacement and reconciled RESUMED receipt commands", async () => {
  const { output } = await invoke("--help");
  expect(output).toContain("atdd-flow handover replace <address>");
  expect(output).toContain("atdd-flow handover resumed <address>");
});

test("RED: bundled Pi runtime has a configurable context threshold handover trigger without invoking compaction", async () => {
  const source = await readFile(extension, "utf8");
  expect(source).toContain("getContextUsage()");
  expect(source).toContain("context-handover-replacement");
  expect(source).not.toMatch(/\.compact\s*\(/);
});

test("RED: Path-A request requires validated handover, immutable source authorization, and an exact ready main takeover task", async () => {
  const { output } = await invoke("handover", "replace", "main@demo", "--help");
  expect(output).toContain("--handover");
  expect(output).toContain("--authorization");
  expect(output).toContain("--source-pi-session");
  expect(output).toContain("--source-pi-session-path");
  expect(output).toContain("--source-herdr-session");
  expect(output).toContain("--source-pane");
  expect(output).toContain("--herdr-session");
});

test("GREEN: Path-A writes one create-only request only for the exact ready project main", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-path-a-"));
  const seat = "main@demo";
  const handover = "HANDOVER main@demo | 2026-10-13T04:00:00Z | handover-id H-demo | supersedes none\nRuntime: herdr forge:w1:p2 | pi session 11111111-1111-1111-1111-111111111111 | model test/pi | context 80%\n\n1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS\n- exact\n\n2. OPEN WORK AND IN-FLIGHT OPERATIONS\n- exact\n\n3. DEPENDENCIES (both directions)\n- none\n\n4. RESUME PROCEDURE AND NEXT ACTIONS\n- exact\n";
  try {
    await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr" });
    await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", repository: "/work/demo", roles: {} });
    const session = "11111111-1111-1111-1111-111111111111";
    const sourcePath = join(root, `source_${session}.jsonl`);
    await writeFile(sourcePath, "source");
    await atomicYaml(paths(root).seatFile(seat), { schema: "atdd-workflow/seat/v2", address: seat, role: "main", project: "demo", worktree: "/work/demo", branch: "main", runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, pi_session: session, pi_session_path: sourcePath } });
    await atomicYaml(paths(root).handoverFile(seat), { schema: "atdd-workflow/handover/v1", seat, handover_id: "H-demo", supersedes: "none", recorded_at: "2026-10-13T04:00:00Z", text: handover });
    await atomicYaml(paths(root).taskFile("demo", "takeover"), { schema: "atdd-workflow/task/v1", title: "Take over", status: "todo", coordinator: seat, assignee: seat, done_when: [{ text: "Take over safely." }] });
    await createExactSessionAdoptionAuthorization(root, "A-demo", ["--by", "operator@desk", "--seat", seat, "--pi-session", session, "--pi-session-path", sourcePath, "--source-herdr-session", "forge", "--source-pane", "w1:p2", "--target-herdr-session", "forge", "--target-pane", "w1:p2", "--target-cwd", "/work/demo"]);
    const args = ["--handover", "H-demo", "--authorization", "A-demo", "--takeover-task", "takeover", "--source-pi-session", session, "--source-pi-session-path", sourcePath, "--source-herdr-session", "forge", "--source-pane", "w1:p2", "--herdr-session", "forge", "--target-pane", "w1:p2", "--target-cwd", "/work/demo"];
    await expect(launchPiRuntime(root, seat, ["--herdr-session", "forge", "--dry-run"])).rejects.toThrow("validated Path-A replacement request");
    await expect(requestHandoverReplacement(root, seat, args.map((value) => value === "A-demo" ? "M-owner" : value))).rejects.toThrow("immutable operator authorization");
    await expect(requestHandoverReplacement(root, seat, args.map((value) => value === sourcePath ? `${sourcePath}.wrong` : value))).rejects.toThrow("source tuple");
    await requestHandoverReplacement(root, seat, args);
    const request = await readYaml<HandoverReplacementRequest>(join(root, ".atdd-flow", "handover-replacements", `${encodeURIComponent(seat)}.yaml`));
    expect(request).toMatchObject({ seat, task: "takeover", handover: { id: "H-demo" }, authorization: { id: "A-demo" }, source: { pi_session: "11111111-1111-1111-1111-111111111111", pane: "w1:p2" }, target: { herdr_session: "forge", pane: "w1:p2", cwd: "/work/demo" } });
    await expect(requestHandoverReplacement(root, seat, args)).rejects.toThrow();
    const changed = await readYaml<Record<string, any>>(paths(root).seatFile(seat));
    await atomicYaml(paths(root).seatFile(seat), { ...changed, runtime: { ...changed.runtime, pi_session: "22222222-2222-2222-2222-222222222222" } });
    await expect(launchPiRuntime(root, seat, ["--herdr-session", "forge", "--dry-run"])).rejects.toThrow("source tuple no longer matches");
  } finally { await rm(root, { recursive: true, force: true }); }
});

type LegacySourceReports = {
  pane: string;
  agent?: string;
  agentName: string;
  agentPane: string;
  agentSessionPath?: string;
  sessionPath: string;
  cwd: string;
  piProcesses: number;
};
type LegacyRequestDependencies = {
  command: (command: string[]) => Promise<string>;
  at?: () => string;
  publish?: (file: string, content: string) => Promise<void>;
};
const requestWithDependencies = requestHandoverReplacement as unknown as
  (root: string, address: string, args: string[], dependencies: LegacyRequestDependencies) => Promise<void>;

async function legacySourceFixture(overrides: Partial<LegacySourceReports> = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-legacy-source-"));
  const address = "main@demo", pane = "w2:p6", herdrSession = "forge";
  const piSession = "01a131ca-1111-4111-8111-111111111111";
  const sessionPath = join(root, `legacy_${piSession}.jsonl`);
  const handover = "HANDOVER main@demo | 2026-10-14T07:00:00Z | handover-id H-legacy | supersedes none\nRuntime: herdr forge:w2:p6 | pi session 01a131ca-1111-4111-8111-111111111111 | model test/pi | context 80%\n\n1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS\n- exact\n\n2. OPEN WORK AND IN-FLIGHT OPERATIONS\n- exact\n\n3. DEPENDENCIES (both directions)\n- none\n\n4. RESUME PROCEDURE AND NEXT ACTIONS\n- exact\n";
  const bin = join(root, "bin"), pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi", args: ["--model", "economy"] }] });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", repository: "/work/demo", roles: {} });
  await atomicYaml(paths(root).seatFile(address), { schema: "atdd-workflow/seat/v2", address, role: "main", project: "demo", worktree: "/work/demo", branch: "main", runtime: { application: "herdr", addresses: { herdr: pane } } });
  await atomicYaml(paths(root).handoverFile(address), { schema: "atdd-workflow/handover/v1", seat: address, handover_id: "H-legacy", supersedes: "none", recorded_at: "2026-10-14T07:00:00Z", text: handover });
  await atomicYaml(paths(root).taskFile("demo", "takeover"), { schema: "atdd-workflow/task/v1", title: "Take over legacy source", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Take over safely." }] });
  await writeFile(sessionPath, "legacy source");
  await createExactSessionAdoptionAuthorization(root, "A-legacy", ["--by", "operator@desk", "--seat", address, "--pi-session", piSession, "--pi-session-path", sessionPath, "--source-herdr-session", herdrSession, "--source-pane", pane, "--target-herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", "/work/demo"]);
  // Fakes mirror live Herdr shapes: pane/agent `agent` is the KIND ("pi"), only `agent get <pane-id>` carries `name`,
  // kind labels are not agent targets, and the Pi writer is reported as `name: "node"`, `argv0: "pi"` with no cmdline.
  const reports: LegacySourceReports = { pane, agent: "pi", agentName: "flow-main-demo", agentPane: pane, sessionPath, cwd: "/work/demo", piProcesses: 1, ...overrides };
  const agentSession = (value: string) => ({ agent: "pi", kind: "path", source: "herdr:pi", value });
  const calls: string[][] = [];
  const command = async (command: string[]) => {
    calls.push(command);
    const operation = command.slice(3);
    if (operation[0] === "workspace" && operation[1] === "list") return JSON.stringify({ result: { workspaces: [{ workspace_id: "w2", label: "demo", worktree: { checkout_path: "/work/demo" } }] } });
    if (operation[0] === "tab" && operation[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "w2:t1", workspace_id: "w2", label: address }] } });
    if (operation[0] === "pane" && operation[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: pane, tab_id: "w2:t1", label: address, agent: reports.agent, agent_status: "idle" }] } });
    if (operation[0] === "pane" && operation[1] === "get") return JSON.stringify({ id: "cli:pane:get", result: { pane: { pane_id: reports.pane, agent: reports.agent, agent_status: "idle", agent_session: agentSession(reports.sessionPath), cwd: reports.cwd, label: address }, type: "pane_info" } });
    if (operation[0] === "pane" && operation[1] === "process-info") return JSON.stringify({ id: "cli:pane:process_info", result: { process_info: { pane_id: pane, shell_pid: 42, foreground_processes: Array.from({ length: reports.piProcesses }, (_, index) => ({ argv0: "pi", cwd: reports.cwd, name: "node", pid: 100 + index })) }, type: "pane_process_info" } });
    if (operation[0] === "agent" && operation[1] === "get") {
      if (operation[2] !== pane) throw new Error(JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${operation[2]} not found` }, id: "cli:agent:get" }));
      return JSON.stringify({ id: "cli:agent:get", result: { agent: { agent: reports.agent, agent_session: agentSession(reports.agentSessionPath ?? reports.sessionPath), agent_status: "idle", cwd: reports.cwd, name: reports.agentName, pane_id: reports.agentPane }, type: "agent_info" } });
    }
    throw new Error(`Unexpected Herdr command: ${command.join(" ")}`);
  };
  const args = ["--legacy-source-bootstrap", "--handover", "H-legacy", "--authorization", "A-legacy", "--takeover-task", "takeover", "--source-pi-session", piSession, "--source-pi-session-path", sessionPath, "--source-herdr-session", herdrSession, "--source-pane", pane, "--herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", "/work/demo"];
  return { root, address, args, command, calls, request: handoverReplacementPath(root, address), seatFile: paths(root).seatFile(address) };
}

const mutatingHerdrCommand = (command: string[]) => command.some((part) => ["run", "start", "bind", "attach", "apply", "create", "rename"].includes(part));
const verifiedAt = "2026-10-14T07:30:00.000Z";

async function replacementArtifacts(root: string) {
  try { return await readdir(join(root, ".atdd-flow", "handover-replacements")); }
  catch { return []; }
}

test("RED: an authorized scalar legacy source can create only a verified replacement snapshot", async () => {
  const fixture = await legacySourceFixture();
  try {
    const before = await readFile(fixture.seatFile, "utf8");
    await requestWithDependencies(fixture.root, fixture.address, fixture.args, { command: fixture.command, at: () => verifiedAt });
    const request = await readYaml<HandoverReplacementRequest & { legacy_source?: Record<string, unknown> }>(fixture.request);
    expect(request.authorization.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(request).toMatchObject({
      seat: fixture.address, authorization: { id: "A-legacy" },
      source: { pi_session: "01a131ca-1111-4111-8111-111111111111", pi_session_path: join(fixture.root, "legacy_01a131ca-1111-4111-8111-111111111111.jsonl"), herdr_session: "forge", pane: "w2:p6" },
      target: { cwd: "/work/demo" },
      legacy_source: { authorization_hash: request.authorization.hash, pi_session: "01a131ca-1111-4111-8111-111111111111", pi_session_path: join(fixture.root, "legacy_01a131ca-1111-4111-8111-111111111111.jsonl"), herdr_session: "forge", pane: "w2:p6", cwd: "/work/demo", agent: "flow-main-demo", verified_at: verifiedAt },
    });
    expect(await readFile(fixture.seatFile, "utf8")).toBe(before);
    expect(fixture.calls.map((command) => command.slice(3, 5).join(" "))).toEqual(expect.arrayContaining(["pane get", "pane process-info", "agent get"]));
    expect(fixture.calls).toContainEqual(["herdr", "--session", "forge", "agent", "get", "w2:p6"]);
    expect(fixture.calls.some(mutatingHerdrCommand)).toBe(false);
    expect(await Bun.file(join(fixture.root, ".atdd-flow", "runtime-launch")).exists()).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("RED: legacy source observation mismatches fail closed without Desk or runtime effects", async () => {
  const mismatches: Array<[string, Partial<LegacySourceReports>]> = [
    ["pane", { pane: "w2:p7" }],
    ["session path", { sessionPath: "/wrong/session.jsonl" }],
    ["agent pane", { agentPane: "w2:p7" }],
    ["agent kind", { agent: "codex" }],
    ["agent session path", { agentSessionPath: "/wrong/agent-session.jsonl" }],
    ["cwd", { cwd: "/wrong/worktree" }],
    ["missing writer", { piProcesses: 0 }],
    ["duplicate writer", { piProcesses: 2 }],
  ];
  for (const [label, overrides] of mismatches) {
    const fixture = await legacySourceFixture(overrides);
    try {
      const before = await readFile(fixture.seatFile, "utf8");
      await expect(requestWithDependencies(fixture.root, fixture.address, fixture.args, { command: fixture.command }), label).rejects.toThrow();
      expect(fixture.calls.length, `${label} must be checked through read-only Herdr evidence`).toBeGreaterThan(0);
      expect(fixture.calls.some(mutatingHerdrCommand)).toBe(false);
      expect(await Bun.file(fixture.request).exists()).toBe(false);
      expect(await readFile(fixture.seatFile, "utf8")).toBe(before);
      expect(await Bun.file(join(fixture.root, ".atdd-flow", "runtime-launch")).exists()).toBe(false);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  }
});

test("RED: invalid authorization is rejected before any live Herdr observation", async () => {
  const cases: Array<[string, (fixture: Awaited<ReturnType<typeof legacySourceFixture>>) => Promise<string[]>]> = [
    ["invalid", async (fixture) => fixture.args.map((value) => value === "A-legacy" ? "not-an-authorization" : value)],
    ["missing", async (fixture) => fixture.args.map((value) => value === "A-legacy" ? "A-missing" : value)],
    ["tampered", async (fixture) => {
      const file = join(fixture.root, ".atdd-flow", "exact-session-adoption-authorizations", "A-legacy.yaml");
      await writeFile(file, `${await readFile(file, "utf8")}\n# tampered\n`);
      return fixture.args;
    }],
    ["reused", async (fixture) => {
      await atomicYaml(join(fixture.root, ".atdd-flow", "runtime-launch", "used.yaml"), { schema: "atdd-flow/pi-runtime-launch-receipt/v1", relocation: { authorization: { id: "A-legacy" } } });
      return fixture.args;
    }],
  ];
  for (const [label, arrange] of cases) {
    const fixture = await legacySourceFixture();
    try {
      const before = await readFile(fixture.seatFile, "utf8"), args = await arrange(fixture);
      await expect(requestWithDependencies(fixture.root, fixture.address, args, { command: fixture.command }), label).rejects.toThrow("authorization");
      expect(fixture.calls, `${label} authorization must resolve before Herdr observation`).toHaveLength(0);
      expect(await Bun.file(fixture.request).exists()).toBe(false);
      expect(await readFile(fixture.seatFile, "utf8")).toBe(before);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  }
});

test("RED: legacy bootstrap requires unchanged scalar placement", async () => {
  const moved = await legacySourceFixture();
  try {
    const record = await readYaml<Record<string, any>>(moved.seatFile);
    await atomicYaml(moved.seatFile, { ...record, runtime: { ...record.runtime, addresses: { herdr: "w2:p9" } } });
    const before = await readFile(moved.seatFile, "utf8");
    await expect(requestWithDependencies(moved.root, moved.address, moved.args, { command: moved.command })).rejects.toThrow();
    expect(await Bun.file(moved.request).exists()).toBe(false);
    expect(await readFile(moved.seatFile, "utf8")).toBe(before);
    expect(moved.calls.some(mutatingHerdrCommand)).toBe(false);
  } finally { await rm(moved.root, { recursive: true, force: true }); }
});

test("RED: duplicate and failed atomic publication leave no new request, temp, receipt, or runtime effect", async () => {
  const duplicate = await legacySourceFixture();
  try {
    await mkdir(dirname(duplicate.request), { recursive: true });
    await writeFile(duplicate.request, "existing immutable request\n", { flag: "wx" });
    const before = await readFile(duplicate.seatFile, "utf8");
    await expect(requestWithDependencies(duplicate.root, duplicate.address, duplicate.args, { command: duplicate.command })).rejects.toThrow();
    expect(await readFile(duplicate.request, "utf8")).toBe("existing immutable request\n");
    expect(duplicate.calls).toHaveLength(0);
    expect((await replacementArtifacts(duplicate.root)).filter((name) => name.includes("tmp"))).toEqual([]);
    expect(await readFile(duplicate.seatFile, "utf8")).toBe(before);
    expect(await Bun.file(join(duplicate.root, ".atdd-flow", "runtime-launch")).exists()).toBe(false);
  } finally { await rm(duplicate.root, { recursive: true, force: true }); }

  const failed = await legacySourceFixture();
  try {
    const before = await readFile(failed.seatFile, "utf8");
    await expect(requestWithDependencies(failed.root, failed.address, failed.args, {
      command: failed.command,
      publish: async () => { throw new Error("injected atomic publication failure"); },
    })).rejects.toThrow("injected atomic publication failure");
    expect(await Bun.file(failed.request).exists()).toBe(false);
    expect(await replacementArtifacts(failed.root)).toEqual([]);
    expect(await readFile(failed.seatFile, "utf8")).toBe(before);
    expect(failed.calls.some(mutatingHerdrCommand)).toBe(false);
    expect(await Bun.file(join(failed.root, ".atdd-flow", "runtime-launch")).exists()).toBe(false);
  } finally { await rm(failed.root, { recursive: true, force: true }); }
});

test("RED: a legacy snapshot is valid only for unchanged scalar state and still requires source release", async () => {
  for (const runtime of [
    { application: "herdr", addresses: { herdr: "w2:p9" } },
    { application: "herdr", addresses: { herdr: "w2:p6" }, pi_session: "partial" },
    { application: "herdr", addresses: { herdr: { session: "forge", pane: "w2:p6" } }, pi_session: "01a131ca-1111-4111-8111-111111111111", pi_session_path: "unexpected" },
  ]) {
    const fixture = await legacySourceFixture();
    try {
      await requestWithDependencies(fixture.root, fixture.address, fixture.args, { command: fixture.command, at: () => verifiedAt });
      const record = await readYaml<Record<string, unknown>>(fixture.seatFile);
      await atomicYaml(fixture.seatFile, { ...record, runtime });
      await expect(replacementForMainLaunch(fixture.root, await readYaml(fixture.seatFile), fixture.address)).rejects.toThrow("source tuple");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  }

  const occupied = await legacySourceFixture();
  try {
    await requestWithDependencies(occupied.root, occupied.address, occupied.args, { command: occupied.command, at: () => verifiedAt });
    occupied.calls.length = 0;
    await expect(launchPiRuntime(occupied.root, occupied.address, ["--herdr-session", "forge", "--dry-run"], {
      select: async () => ({ available: true as const, model: "fake-jev", selected_model: "economy", confidence: 0.93 }),
      command: occupied.command,
    })).rejects.toThrow("available shell pane");
    expect(occupied.calls.some(mutatingHerdrCommand)).toBe(false);
    expect(await Bun.file(join(occupied.root, ".atdd-flow", "runtime-launch")).exists()).toBe(false);
  } finally { await rm(occupied.root, { recursive: true, force: true }); }
});
