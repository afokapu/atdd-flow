// URN: test:flow:stale-binding-adoption-reconcile
// Acceptance: acc:flow:E030-UNIT-001
// Phase: UNIT
// Runtime: bun
// Purpose: An operator-minted exact adoption reconciles a stale-bound main without Path-A request eligibility, and a brand-new main bootstraps from a recorded handover plus one ready task.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml } from "../src/core";
import { handoverReplacementPath } from "../src/handover";
import { launchPiRuntime } from "../src/seats";

const herdrSession = "forge";
const staleSession = "ed0280b7-ab1e-4f93-918a-ab9f6794413c";
const roots: string[] = [];
const noRequest = (address: string) => `${address} requires one validated Path-A replacement request; refusing runtime launch.`;

// The three operator-authorized target tuples refused by the released path (M-20261104T051525Z).
const targets = {
  "atdd-flow": { session: "01a19f3a-7322-748a-bbdb-f1e0ca44975b", pane: "w5:pN", stalePane: "w5:p1", workspace: "w5" },
  "decision-os": { session: "01a19f3a-7335-7056-8911-37031853bc6b", pane: "w2:pC", stalePane: "w2:p1", workspace: "w2" },
  "frg-workstation": { session: "01a19f3a-7322-71a7-af67-bb8fa63be8dd", pane: "w6:pH", stalePane: "w6:p1", workspace: "w6" },
} as const;
type Name = keyof typeof targets;

const selectEconomy = async () => ({ available: true as const, model: "test", selected_model: "economy", confidence: 0.99 });

function harness(root: string, name: Name, cwd: string, initiallyLive?: string) {
  const { pane, workspace } = targets[name];
  const address = `main@${name}`;
  const calls: string[][] = [];
  let writerPath = initiallyLive;
  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const paneRecord = () => writerPath
    ? { pane_id: pane, agent: "pi", agent_status: "idle", agent_session: session(writerPath), cwd, label: address }
    : { pane_id: pane, agent: null, agent_status: "unknown", agent_session: null, cwd, label: address };
  return {
    calls,
    release: () => { writerPath = undefined; },
    mutations: () => calls.filter((call) => ["run", "start"].includes(call[4]!)).length,
    command: async (command: string[]) => {
      calls.push(command);
      const operation = command.slice(3);
      if (operation[0] === "workspace" && operation[1] === "list") return JSON.stringify({ result: { workspaces: [
        { workspace_id: workspace, label: name, worktree: { checkout_path: cwd } },
      ] } });
      if (operation[0] === "tab" && operation[1] === "list") return JSON.stringify({ result: { tabs: [
        { tab_id: `${workspace}:t1`, workspace_id: workspace, label: address },
      ] } });
      if (operation[0] === "pane" && operation[1] === "list") return JSON.stringify({ result: { panes: [
        { pane_id: pane, tab_id: `${workspace}:t1`, label: address, agent: writerPath ? "pi" : null, agent_status: writerPath ? "idle" : "unknown" },
      ] } });
      if (operation[0] === "pane" && operation[1] === "get") return JSON.stringify({ result: { pane: paneRecord() } });
      if (operation[0] === "pane" && operation[1] === "process-info") return JSON.stringify({ result: { process_info: {
        pane_id: pane, shell_pid: 42,
        foreground_processes: writerPath ? [{ name: "node", argv0: "pi", pid: 100, cwd }] : [{ name: "zsh", argv0: "zsh", pid: 42, cwd }],
      } } });
      if (operation[0] === "agent" && operation[1] === "get") return JSON.stringify({ result: { agent: {
        name: `flow-main-${name}`.slice(0, 32), agent: "pi", pane_id: pane, agent_status: "idle", agent_session: session(writerPath!), cwd,
      } } });
      if (operation[0] === "agent" && operation[1] === "list") return JSON.stringify({ result: { agents: [] } });
      if (operation[0] === "pane" && operation[1] === "run") return JSON.stringify({ result: { pane_id: pane } });
      if (operation[0] === "agent" && operation[1] === "start") {
        const piArgs = operation.slice(operation.indexOf("--") + 1);
        const continued = piArgs.indexOf("--session"), minted = piArgs.indexOf("--session-id");
        writerPath = continued >= 0 ? piArgs[continued + 1] : join(root, `fresh_${piArgs[minted + 1]}.jsonl`);
        return JSON.stringify({ result: { name: `flow-main-${name}`.slice(0, 32) } });
      }
      throw new Error(`Unexpected Herdr command: ${command.join(" ")}`);
    },
  };
}

type Options = { bound?: boolean; strayRequest?: boolean; authorize?: boolean; handover?: boolean; tasks?: Array<Record<string, unknown>> };
const readyTask = { title: "Main takeover", status: "todo", done_when: [{ text: "Successor resumes." }] };

async function fixture(name: Name, options: Options = {}) {
  const { bound = true, strayRequest = false, authorize = true, handover = true, tasks = [readyTask] } = options;
  const root = await mkdtemp(join(tmpdir(), `atdd-stale-adopt-${name}-`));
  roots.push(root);
  const address = `main@${name}`, cwd = join(root, "repo", name);
  await mkdir(cwd, { recursive: true });
  const pi = join(root, "bin", "pi");
  await mkdir(join(root, "bin"));
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }] });
  await atomicYaml(paths(root).projectFile(name), { schema: "atdd-workflow/project/v1", project: name, repository: cwd, roles: {} });

  const target = targets[name];
  const livePath = join(root, `2026-11-04T05-00-00-000Z_${target.session}.jsonl`);
  await writeFile(livePath, '{"type":"session"}\n');
  const stalePath = join(root, `2026-10-19T08-22-48-930Z_${staleSession}.jsonl`);
  const staleReceipt = join(root, ".atdd-flow", "runtime-launch", `${staleSession}-stale.yaml`);
  await atomicYaml(staleReceipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, tasks: ["prior"], candidate: "economy",
    pi_session: staleSession, pi_session_path: stalePath, herdr_session: herdrSession, pane: target.stalePane,
    created_at: "2026-10-19T08:22:51.906Z",
  });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project: name, worktree: cwd, branch: "main",
    ...(bound ? { runtime: {
      application: "herdr", addresses: { herdr: { session: herdrSession, pane: target.stalePane } }, wake: "native",
      pi_session: staleSession, pi_session_path: stalePath, launch_receipt: staleReceipt,
    } } : {}),
  });
  if (handover) await atomicYaml(paths(root).handoverFile(address), {
    schema: "atdd-workflow/handover/v1", seat: address, handover_id: "H-20261104T050000Z-main-successor", supersedes: "none",
    recorded_at: "2026-11-04T05:00:00.000Z",
    text: `HANDOVER ${address} | 2026-11-04T05:00:00Z | handover-id H-20261104T050000Z-main-successor | supersedes none\nRuntime: pi | x | model m/m | context 10%\n`,
  });
  for (const [index, task] of tasks.entries()) {
    await atomicYaml(paths(root).taskFile(name, `takeover-${index + 1}`), { schema: "atdd-workflow/task/v1", coordinator: address, assignee: address, ...task });
  }
  if (strayRequest) await atomicYaml(handoverReplacementPath(root, address), {
    schema: "atdd-flow/context-handover-replacement-request/v1", seat: address, task: "takeover-1",
    handover: { id: "H-20261019T000000Z-old", sha256: "1".repeat(64) }, authorization: { id: "A-old", hash: "2".repeat(64) },
    source: { pi_session: staleSession, pi_session_path: stalePath, herdr_session: herdrSession, pane: "w9:p9" },
    target: { herdr_session: herdrSession, pane: "w9:p9", cwd }, created_at: "2026-10-19T08:22:10.722Z",
  });
  const authorizationId = `A-20261104-main-${name}`;
  if (authorize) await authorization(root, name, authorizationId, livePath, cwd);
  return { root, name, address, cwd, livePath, authorizationId, runtime: harness(root, name, cwd, livePath), target };
}

async function authorization(root: string, name: Name, id: string, livePath: string, cwd: string, override: Partial<Record<"pane" | "cwd" | "sourcePane", string>> = {}) {
  const target = targets[name];
  await createExactSessionAdoptionAuthorization(root, id, [
    "--by", "operator@desk", "--seat", `main@${name}`, "--pi-session", target.session, "--pi-session-path", livePath,
    "--source-herdr-session", herdrSession, "--source-pane", override.sourcePane ?? target.pane,
    "--target-herdr-session", herdrSession, "--target-pane", override.pane ?? target.pane, "--target-cwd", override.cwd ?? cwd,
  ]);
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const adoptArgs = (value: Fixture, extra: string[] = []) => [
  "--pane", value.target.pane, "--herdr-session", herdrSession, "--adopt-session", value.livePath,
  "--source-herdr-session", herdrSession, "--source-pane", value.target.pane, "--authorization", value.authorizationId, ...extra,
];
const adopt = (value: Fixture, extra: string[] = []) => launchPiRuntime(value.root, value.address, adoptArgs(value, extra),
  { command: value.runtime.command, select: selectEconomy, at: () => "2026-11-04T05:30:00.000Z" });
const seatFile = (value: Fixture) => readFile(paths(value.root).seatFile(value.address), "utf8");
async function receipts(root: string) {
  try { return (await readdir(join(root, ".atdd-flow", "runtime-launch"))).filter((file) => file.endsWith(".yaml") && !file.includes("stale")); }
  catch { return []; }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

for (const name of Object.keys(targets) as Name[]) {
  test(`dry-run shape: minted exact adoption reconciles stale-bound main@${name} without a Path-A request`, async () => {
    const value = await fixture(name);
    value.runtime.release();
    const seatBefore = await seatFile(value);
    const plan = await adopt(value, ["--dry-run"]);

    expect(plan).toMatchObject({ candidate: "economy", piSession: targets[name].session, pane: targets[name].pane, herdrSession, dryRun: true });
    expect(plan.command).toContain(value.livePath);
    expect(plan.command.slice(0, 6)).toEqual(["herdr", "--session", herdrSession, "agent", "start", `flow-main-${name}`.slice(0, 32)]);
    expect(await seatFile(value)).toBe(seatBefore);
    expect(await receipts(value.root)).toEqual([]);
    expect(value.runtime.mutations()).toBe(0);
  });
}

test("live reconcile binds the adopted target, records authorization provenance, and fabricates no predecessor", async () => {
  const value = await fixture("atdd-flow");
  value.runtime.release();
  const plan = await adopt(value);

  const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(value.address));
  expect(seat.runtime).toMatchObject({
    application: "herdr", addresses: { herdr: { session: herdrSession, pane: value.target.pane } }, wake: "native",
    pi_session: value.target.session, pi_session_path: value.livePath, launch_receipt: plan.receipt,
  });
  const receipt = await readYaml<Record<string, any>>(plan.receipt);
  expect(receipt).toMatchObject({
    seat: value.address, tasks: ["takeover-1"], pi_session: value.target.session, pi_session_path: value.livePath,
    relocation: { source_herdr_session: herdrSession, source_pane: value.target.pane, authorization: { id: value.authorizationId } },
    launch_basis: { kind: "exact-adoption", task: "takeover-1" },
  });
  expect(receipt.handover_replacement).toBeUndefined();
  expect(await Bun.file(receipt.relocation.backup).exists()).toBe(true);
});

test("a stale or invalid Path-A request does not block, and is not rewritten by, a minted exact adoption", async () => {
  const value = await fixture("decision-os", { strayRequest: true });
  value.runtime.release();
  const requestBefore = await readFile(handoverReplacementPath(value.root, value.address), "utf8");
  const plan = await adopt(value);

  expect(plan).toMatchObject({ piSession: value.target.session, pane: value.target.pane });
  expect(await readFile(handoverReplacementPath(value.root, value.address), "utf8")).toBe(requestBefore);
});

test("an evidence-empty IN_PROGRESS self-assigned task is adoptable", async () => {
  const value = await fixture("frg-workstation", { tasks: [{ ...readyTask, status: "in_progress" }] });
  value.runtime.release();
  expect(await adopt(value, ["--dry-run"])).toMatchObject({ dryRun: true, piSession: value.target.session });
});

test("the authorization is one-shot: a second adoption with the same record is refused", async () => {
  const value = await fixture("atdd-flow");
  value.runtime.release();
  await adopt(value);
  value.runtime.release();
  await expect(adopt(value)).rejects.toThrow("already used");
});

test("without a minted authorization a stale-bound main still fails closed", async () => {
  const value = await fixture("atdd-flow", { authorize: false });
  value.runtime.release();
  const before = await seatFile(value);
  await expect(launchPiRuntime(value.root, value.address, ["--pane", value.target.pane, "--herdr-session", herdrSession, "--dry-run"],
    { command: value.runtime.command, select: selectEconomy })).rejects.toThrow(noRequest(value.address));
  await expect(adopt(value)).rejects.toThrow("immutable operator authorization");
  expect(await seatFile(value)).toBe(before);
  expect(value.runtime.mutations()).toBe(0);
});

async function expectRefused(value: Fixture, message: string | RegExp, args = adoptArgs(value)) {
  const before = await seatFile(value);
  await expect(launchPiRuntime(value.root, value.address, args, { command: value.runtime.command, select: selectEconomy })).rejects.toThrow(message);
  expect(await seatFile(value)).toBe(before);
  expect(await receipts(value.root)).toEqual([]);
  expect(value.runtime.mutations()).toBe(0);
}

test("guard: a source Pi that has not exited is refused before mutation", async () => {
  const value = await fixture("atdd-flow");
  await expectRefused(value, /vacant|available shell pane|exited and been released|Run this from a different pane/);
});

test("guard: an authorization bound to a different target pane or working directory is refused", async () => {
  for (const override of [{ pane: "w5:pZ" }, { cwd: "/elsewhere" }]) {
    const value = await fixture("atdd-flow", { authorize: false });
    value.runtime.release();
    await authorization(value.root, "atdd-flow", value.authorizationId, value.livePath, value.cwd, override);
    await expectRefused(value, "bound to the exact adoption tuple");
  }
});

test("guard: an edited authorization record is refused", async () => {
  const value = await fixture("atdd-flow");
  value.runtime.release();
  const file = join(value.root, ".atdd-flow", "exact-session-adoption-authorizations", `${value.authorizationId}.yaml`);
  await writeFile(file, `${await readFile(file, "utf8")}# edited\n`);
  await expectRefused(value, "immutable operator authorization record");
});

test("guard: a missing adopted JSONL is refused", async () => {
  const value = await fixture("atdd-flow");
  value.runtime.release();
  await rm(value.livePath);
  await expectRefused(value, /ENOENT|no such file/i);
});

test("guard: zero, ambiguous (two), or blocked ready tasks refuse adoption", async () => {
  for (const tasks of [[], [readyTask, readyTask], [{ ...readyTask, blocker: "waiting" }]]) {
    const value = await fixture("atdd-flow", { tasks });
    value.runtime.release();
    await expectRefused(value, noRequest(value.address));
  }
});

test("guard: an IN_PROGRESS task carrying proof or handoff evidence refuses adoption", async () => {
  for (const evidence of [{ done_when: [{ text: "x", proof: "pr#1" }] }, { handoff: { phase: "red", evidence: "M-1" } }]) {
    const value = await fixture("atdd-flow", { tasks: [{ ...readyTask, status: "in_progress", ...evidence }] });
    value.runtime.release();
    await expectRefused(value, noRequest(value.address));
  }
});

test("guard: a non-main seat is never launched through the main adoption basis", async () => {
  const value = await fixture("atdd-flow");
  value.runtime.release();
  const record = await readYaml<Record<string, any>>(paths(value.root).seatFile(value.address));
  await atomicYaml(paths(value.root).seatFile(value.address), { ...record, branch: "feature" });
  await expectRefused(value, /no launch-eligible task|authorization record/);
});

const bootstrapArgs = (value: Fixture, extra: string[] = []) => ["--pane", value.target.pane, "--herdr-session", herdrSession, ...extra];
const bootstrap = (value: Fixture, extra: string[] = []) => launchPiRuntime(value.root, value.address, bootstrapArgs(value, extra), {
  command: value.runtime.command, select: selectEconomy, sessionId: () => "01b00000-0000-4000-8000-000000000001", at: () => "2026-11-04T05:40:00.000Z",
});

test("brand-new main bootstrap: recorded handover plus one ready todo task launches without a request or predecessor", async () => {
  const value = await fixture("frg-workstation", { bound: false, authorize: false });
  value.runtime.release();
  const dry = await bootstrap(value, ["--dry-run"]);
  expect(dry).toMatchObject({ dryRun: true, pane: value.target.pane, piSession: "01b00000-0000-4000-8000-000000000001" });
  expect(value.runtime.mutations()).toBe(0);

  const plan = await bootstrap(value);
  const receipt = await readYaml<Record<string, any>>(plan.receipt);
  expect(receipt).toMatchObject({
    seat: value.address, tasks: ["takeover-1"], pi_session: "01b00000-0000-4000-8000-000000000001",
    bootstrap_launch: { task: "takeover-1", handover: { id: "H-20261104T050000Z-main-successor" } },
  });
  expect(receipt.handover_replacement).toBeUndefined();
  expect(receipt.relocation).toBeUndefined();
  const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(value.address));
  expect(seat.runtime).toMatchObject({ pi_session: "01b00000-0000-4000-8000-000000000001", launch_receipt: plan.receipt });
});

test("bootstrap guard: no handover, or zero, two, in-progress, or blocked tasks refuse", async () => {
  const cases: Options[] = [{ handover: false }, { tasks: [] }, { tasks: [readyTask, readyTask] },
    { tasks: [{ ...readyTask, status: "in_progress" }] }, { tasks: [{ ...readyTask, blocker: "waiting" }] }];
  for (const extra of cases) {
    const value = await fixture("atdd-flow", { bound: false, authorize: false, ...extra });
    value.runtime.release();
    await expect(bootstrap(value, ["--dry-run"])).rejects.toThrow(noRequest(value.address));
  }
});

test("bootstrap guard: an already-bound runtime is never bootstrapped without a request", async () => {
  const value = await fixture("atdd-flow", { bound: true, authorize: false });
  value.runtime.release();
  await expect(bootstrap(value, ["--dry-run"])).rejects.toThrow(noRequest(value.address));
});

test("bootstrap guard: an occupied pane still refuses and needs the exact-adoption route", async () => {
  const value = await fixture("atdd-flow", { bound: false, authorize: false });
  await expect(bootstrap(value)).rejects.toThrow(/available shell pane|different pane/);
  expect(value.runtime.mutations()).toBe(0);
});

test("brand-new main with an occupied pane adopts through the exact-adoption record", async () => {
  const value = await fixture("decision-os", { bound: false });
  value.runtime.release();
  expect(await adopt(value, ["--dry-run"])).toMatchObject({ dryRun: true, piSession: value.target.session });
});
