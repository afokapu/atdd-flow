// URN: test:atdd-flow:context-handover-session-replacement
// Acceptance: acc:flow:E003-UNIT-001
// Phase: UNIT
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { handoverReplacementPath, requestHandoverReplacement, type HandoverReplacementRequest } from "../src/handover";
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
  agentPane: string;
  sessionPath: string;
  cwd: string;
  piProcesses: number;
};
type LegacyRequestDependencies = { command: (command: string[]) => Promise<string> };
const requestWithDependencies = requestHandoverReplacement as unknown as
  (root: string, address: string, args: string[], dependencies: LegacyRequestDependencies) => Promise<void>;

async function legacySourceFixture(overrides: Partial<LegacySourceReports> = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-legacy-source-"));
  const address = "main@demo", pane = "w2:p6", herdrSession = "forge";
  const piSession = "01a131ca-1111-4111-8111-111111111111";
  const sessionPath = join(root, `legacy_${piSession}.jsonl`);
  const handover = "HANDOVER main@demo | 2026-10-14T07:00:00Z | handover-id H-legacy | supersedes none\nRuntime: herdr forge:w2:p6 | pi session 01a131ca-1111-4111-8111-111111111111 | model test/pi | context 80%\n\n1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS\n- exact\n\n2. OPEN WORK AND IN-FLIGHT OPERATIONS\n- exact\n\n3. DEPENDENCIES (both directions)\n- none\n\n4. RESUME PROCEDURE AND NEXT ACTIONS\n- exact\n";
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr" });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", repository: "/work/demo", roles: {} });
  await atomicYaml(paths(root).seatFile(address), { schema: "atdd-workflow/seat/v2", address, role: "main", project: "demo", worktree: "/work/demo", branch: "main", runtime: { application: "herdr", addresses: { herdr: pane } } });
  await atomicYaml(paths(root).handoverFile(address), { schema: "atdd-workflow/handover/v1", seat: address, handover_id: "H-legacy", supersedes: "none", recorded_at: "2026-10-14T07:00:00Z", text: handover });
  await atomicYaml(paths(root).taskFile("demo", "takeover"), { schema: "atdd-workflow/task/v1", title: "Take over legacy source", status: "todo", coordinator: address, assignee: address, done_when: [{ text: "Take over safely." }] });
  await writeFile(sessionPath, "legacy source");
  await createExactSessionAdoptionAuthorization(root, "A-legacy", ["--by", "operator@desk", "--seat", address, "--pi-session", piSession, "--pi-session-path", sessionPath, "--source-herdr-session", herdrSession, "--source-pane", pane, "--target-herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", "/work/demo"]);
  const reports: LegacySourceReports = { pane, agent: "flow-main-demo", agentPane: pane, sessionPath, cwd: "/work/demo", piProcesses: 1, ...overrides };
  const calls: string[][] = [];
  const command = async (command: string[]) => {
    calls.push(command);
    const operation = command.slice(3);
    if (operation[0] === "pane" && operation[1] === "get") return JSON.stringify({ result: { pane: { pane_id: reports.pane, agent: reports.agent, agent_status: "idle", agent_session: { kind: "path", value: reports.sessionPath }, cwd: reports.cwd } } });
    if (operation[0] === "pane" && operation[1] === "process-info") return JSON.stringify({ result: { process_info: { shell_pid: 42, foreground_processes: Array.from({ length: reports.piProcesses }, () => ({ name: "pi", argv0: "pi", cmdline: "pi" })) } } });
    if (operation[0] === "agent" && operation[1] === "get") return JSON.stringify({ result: { agent: { name: reports.agent, pane_id: reports.agentPane, agent_status: "idle" } } });
    throw new Error(`Unexpected Herdr command: ${command.join(" ")}`);
  };
  const args = ["--legacy-source-bootstrap", "--handover", "H-legacy", "--authorization", "A-legacy", "--takeover-task", "takeover", "--source-pi-session", piSession, "--source-pi-session-path", sessionPath, "--source-herdr-session", herdrSession, "--source-pane", pane, "--herdr-session", herdrSession, "--target-pane", pane, "--target-cwd", "/work/demo"];
  return { root, address, args, command, calls, request: handoverReplacementPath(root, address), seatFile: paths(root).seatFile(address) };
}

const mutatingHerdrCommand = (command: string[]) => command.some((part) => ["run", "start", "bind", "attach", "apply"].includes(part));

test("RED: an authorized scalar legacy source can create only a verified replacement snapshot", async () => {
  const fixture = await legacySourceFixture();
  try {
    const before = await readFile(fixture.seatFile, "utf8");
    await requestWithDependencies(fixture.root, fixture.address, fixture.args, { command: fixture.command });
    const request = await readYaml<HandoverReplacementRequest & { legacy_source?: Record<string, unknown> }>(fixture.request);
    expect(request).toMatchObject({ seat: fixture.address, authorization: { id: "A-legacy" }, source: { herdr_session: "forge", pane: "w2:p6" }, target: { cwd: "/work/demo" }, legacy_source: { agent: "flow-main-demo", cwd: "/work/demo" } });
    expect(await readFile(fixture.seatFile, "utf8")).toBe(before);
    expect(fixture.calls.map((command) => command.slice(3, 5).join(" "))).toEqual(expect.arrayContaining(["pane get", "pane process-info", "agent get"]));
    expect(fixture.calls.some(mutatingHerdrCommand)).toBe(false);
    expect(await Bun.file(join(fixture.root, ".atdd-flow", "runtime-launch")).exists()).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("RED: legacy source observation mismatches fail closed without Desk or runtime effects", async () => {
  const mismatches: Array<[string, Partial<LegacySourceReports>]> = [
    ["pane", { pane: "w2:p7" }],
    ["session path", { sessionPath: "/wrong/session.jsonl" }],
    ["agent pane", { agentPane: "w2:p7" }],
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

test("RED: legacy bootstrap requires the immutable authorization and unchanged scalar placement", async () => {
  const unauthorized = await legacySourceFixture();
  try {
    const args = unauthorized.args.map((value) => value === "A-legacy" ? "A-missing" : value);
    await expect(requestWithDependencies(unauthorized.root, unauthorized.address, args, { command: unauthorized.command })).rejects.toThrow("immutable operator authorization");
    expect(await Bun.file(unauthorized.request).exists()).toBe(false);
  } finally { await rm(unauthorized.root, { recursive: true, force: true }); }

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
