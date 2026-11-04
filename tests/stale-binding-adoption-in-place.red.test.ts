// URN: test:flow:stale-binding-adoption-in-place
// Acceptance: acc:flow:E031-UNIT-001
// Phase: UNIT
// Runtime: bun
// Purpose: An operator-authorized Pi that already occupies the target pane is reconciled in place, without a second launch, and every tuple, authorization, writer and task guard stays strict.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths, readYaml } from "../src/core";
import { launchPiRuntime } from "../src/seats";

const herdrSession = "forge", staleSession = "ed0280b7-ab1e-4f93-918a-ab9f6794413c";
const roots: string[] = [];
const noRequest = (address: string) => `${address} requires one validated Path-A replacement request; refusing runtime launch.`;
// Operator-authorized live targets (M-20261104T051525Z); the source pane IS the target pane.
const targets = {
  "atdd-flow": { session: "01a19f3a-7322-748a-bbdb-f1e0ca44975b", pane: "w5:pN", stalePane: "w5:p1" },
  "decision-os": { session: "01a19f3a-7335-7056-8911-37031853bc6b", pane: "w2:pC", stalePane: "w2:p1" },
  "frg-workstation": { session: "01a19f3a-7322-71a7-af67-bb8fa63be8dd", pane: "w6:pH", stalePane: "w6:p1" },
} as const;
type Name = keyof typeof targets;
const selectEconomy = async () => ({ available: true as const, model: "test", selected_model: "economy", confidence: 0.99 });
const readyTask = { title: "Main takeover", status: "todo", done_when: [{ text: "Successor resumes." }] };

type Live = { path?: string; cwd: string; pi: number; others: Array<{ pane: string; path: string }> };
function harness(name: Name, live: Live, repository: string) {
  const { pane } = targets[name], calls: string[][] = [];
  const session = (value: string) => ({ kind: "path", source: "herdr:pi", value });
  const agentName = `flow-main-${name}`.slice(0, 32);
  return {
    live, calls,
    mutations: () => calls.filter((call) => ["run", "start"].includes(call[4]!)).length,
    command: async (command: string[]) => {
      calls.push(command);
      const op = command.slice(3);
      if (op[0] === "workspace" && op[1] === "list") return JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: name, worktree: { checkout_path: repository } }] } });
      if (op[0] === "tab" && op[1] === "list") return JSON.stringify({ result: { tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: `main@${name}` }] } });
      if (op[0] === "pane" && op[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: pane, tab_id: "w1:t1", label: `main@${name}`, agent: live.path ? "pi" : null, agent_status: live.path ? "working" : "unknown" }] } });
      if (op[0] === "pane" && op[1] === "get") return JSON.stringify({ result: { pane: live.path
        ? { pane_id: pane, agent: "pi", agent_status: "working", agent_session: session(live.path), cwd: live.cwd }
        : { pane_id: pane, agent: null, agent_status: "unknown", agent_session: null, cwd: live.cwd } } });
      if (op[0] === "pane" && op[1] === "process-info") return JSON.stringify({ result: { process_info: { pane_id: pane, shell_pid: 42,
        foreground_processes: Array.from({ length: live.pi }, (_, index) => ({ name: "node", argv0: "pi", pid: 100 + index, cwd: live.cwd })) } } });
      if (op[0] === "agent" && op[1] === "get") return JSON.stringify({ result: { agent: { name: agentName, agent: "pi", pane_id: pane, agent_status: "working", agent_session: session(live.path!), cwd: live.cwd } } });
      if (op[0] === "agent" && op[1] === "list") return JSON.stringify({ result: { agents: [
        ...(live.path ? [{ name: agentName, agent: "pi", pane_id: pane, agent_session: session(live.path) }] : []),
        ...live.others.map((other) => ({ name: "other", agent: "pi", pane_id: other.pane, agent_session: session(other.path) })),
      ] } });
      throw new Error(`Unexpected Herdr command (a second launch must not occur): ${command.join(" ")}`);
    },
  };
}

type Options = { tasks?: Array<Record<string, unknown>>; authorize?: boolean; authorizedSourcePane?: string; live?: Partial<Live> };
async function fixture(name: Name, options: Options = {}) {
  const { tasks = [readyTask], authorize = true, authorizedSourcePane, live = {} } = options;
  const root = await mkdtemp(join(tmpdir(), `atdd-in-place-${name}-`));
  roots.push(root);
  const address = `main@${name}`, cwd = join(root, "repo", name), target = targets[name];
  await mkdir(cwd, { recursive: true });
  const pi = join(root, "bin", "pi");
  await mkdir(join(root, "bin"));
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }] });
  await atomicYaml(paths(root).projectFile(name), { schema: "atdd-workflow/project/v1", project: name, repository: cwd, roles: {} });
  const livePath = join(root, `2026-11-04T05-00-00-000Z_${target.session}.jsonl`);
  await writeFile(livePath, '{"type":"session"}\n');
  const stalePath = join(root, `2026-10-19T08-22-48-930Z_${staleSession}.jsonl`);
  const staleReceipt = join(root, ".atdd-flow", "runtime-launch", `${staleSession}-stale.yaml`);
  await atomicYaml(staleReceipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, tasks: ["prior"], candidate: "economy",
    pi_session: staleSession, pi_session_path: stalePath, herdr_session: herdrSession, pane: target.stalePane, created_at: "2026-10-19T08:22:51.906Z" });
  await atomicYaml(paths(root).seatFile(address), { schema: "atdd-workflow/seat/v2", address, role: "main", project: name, worktree: cwd, branch: "main",
    runtime: { application: "herdr", addresses: { herdr: { session: herdrSession, pane: target.stalePane } }, wake: "native",
      pi_session: staleSession, pi_session_path: stalePath, launch_receipt: staleReceipt } });
  for (const [index, task] of tasks.entries()) await atomicYaml(paths(root).taskFile(name, `takeover-${index + 1}`), { schema: "atdd-workflow/task/v1", coordinator: address, assignee: address, ...task });
  const authorizationId = `A-20261104-main-${name}`;
  if (authorize) await createExactSessionAdoptionAuthorization(root, authorizationId, ["--by", "operator@desk", "--seat", address,
    "--pi-session", target.session, "--pi-session-path", livePath, "--source-herdr-session", herdrSession, "--source-pane", authorizedSourcePane ?? target.pane,
    "--target-herdr-session", herdrSession, "--target-pane", target.pane, "--target-cwd", cwd]);
  return { root, name, address, cwd, livePath, stalePath, authorizationId, target, runtime: harness(name, { path: livePath, cwd, pi: 1, others: [], ...live }, cwd) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const args = (value: Fixture, extra: string[] = []) => ["--pane", value.target.pane, "--herdr-session", herdrSession, "--adopt-session", value.livePath,
  "--source-herdr-session", herdrSession, "--source-pane", value.target.pane, "--authorization", value.authorizationId, ...extra];
const reconcile = (value: Fixture, extra: string[] = ["--in-place"]) => launchPiRuntime(value.root, value.address, args(value, extra),
  { command: value.runtime.command, select: selectEconomy, hostPane: "w9:p9", at: () => "2026-11-04T08:00:00.000Z" });
const seatFile = (value: Fixture) => readFile(paths(value.root).seatFile(value.address), "utf8");
const receipts = async (root: string) => (await readdir(join(root, ".atdd-flow", "runtime-launch")).catch(() => [] as string[])).filter((file) => !file.includes("stale") && file.endsWith(".yaml"));

async function expectRefused(value: Fixture, message: string | RegExp, extra: string[] = ["--in-place"]) {
  const before = await seatFile(value);
  await expect(reconcile(value, extra)).rejects.toThrow(message);
  expect(await seatFile(value)).toBe(before);
  expect(await receipts(value.root)).toEqual([]);
  expect(value.runtime.mutations()).toBe(0);
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

for (const name of Object.keys(targets) as Name[]) {
  test(`dry-run shape: authorized Pi occupying ${targets[name].pane} for main@${name} is reconciled in place with no launch command`, async () => {
    const value = await fixture(name);
    const before = await seatFile(value);
    const plan = await reconcile(value, ["--in-place", "--dry-run"]);
    expect(plan).toMatchObject({ dryRun: true, inPlace: true, piSession: targets[name].session, pane: targets[name].pane, herdrSession, command: [] });
    expect(await seatFile(value)).toBe(before);
    expect(await receipts(value.root)).toEqual([]);
    expect(value.runtime.mutations()).toBe(0);
  });
}

test("live in-place reconcile binds the existing Pi and records authorization provenance without a second launch", async () => {
  const value = await fixture("atdd-flow");
  const plan = await reconcile(value);
  const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(value.address));
  expect(seat.runtime).toMatchObject({ application: "herdr", addresses: { herdr: { session: herdrSession, pane: value.target.pane } }, wake: "native",
    pi_session: value.target.session, pi_session_path: value.livePath, launch_receipt: plan.receipt });
  const receipt = await readYaml<Record<string, any>>(plan.receipt);
  expect(receipt).toMatchObject({ seat: value.address, tasks: ["takeover-1"], pi_session: value.target.session, pi_session_path: value.livePath,
    pane: value.target.pane, relocation: { source_pane: value.target.pane, authorization: { id: value.authorizationId } },
    launch_basis: { kind: "exact-adoption", task: "takeover-1", in_place: true } });
  expect(receipt.handover_replacement).toBeUndefined();
  expect(await readFile(receipt.relocation.backup, "utf8")).toBe(await readFile(value.livePath, "utf8"));
  expect(value.runtime.mutations()).toBe(0);
  expect(value.runtime.calls.some((call) => call[4] === "run" || call[4] === "start")).toBe(false);
});

test("without --in-place an occupied target is still refused as before", async () => {
  const value = await fixture("atdd-flow");
  await expectRefused(value, "New launch requires an available shell pane", []);
});

test("the authorization is one-shot for in-place reconcile", async () => {
  const value = await fixture("atdd-flow");
  await reconcile(value);
  await expect(reconcile(value)).rejects.toThrow("already used");
});

test("guard: the authorized Pi must actually be live in the target pane", async () => {
  await expectRefused(await fixture("atdd-flow", { live: { path: undefined } }), "In-place adoption requires the authorized Pi to be live");
});

test("guard: a different Pi session or working directory in the pane is refused", async () => {
  const other = await fixture("atdd-flow");
  other.runtime.live.path = join(other.root, "2026-11-04T05-00-00-000Z_01a19f3a-0000-7000-8000-000000000000.jsonl");
  await expectRefused(other, /authorized source tuple|does not match/);
  const moved = await fixture("atdd-flow");
  moved.runtime.live.cwd = "/elsewhere";
  await expectRefused(moved, /authorized source tuple|does not match/);
});

test("guard: more than one Pi writer in the pane is refused", async () => {
  await expectRefused(await fixture("atdd-flow", { live: { pi: 2 } }), "exactly one live Pi writer");
});

test("guard: the authorized Pi also live in another pane, or the stale recorded Pi still live, is refused", async () => {
  const dup = await fixture("atdd-flow");
  dup.runtime.live.others = [{ pane: "w7:p7", path: dup.livePath }];
  await expectRefused(dup, /another pane|more than one|duplicate|exactly once/i);
  const stale = await fixture("decision-os");
  stale.runtime.live.others = [{ pane: "w7:p7", path: stale.stalePath }];
  await expectRefused(stale, "still a live Pi agent");
});

test("guard: in-place requires the authorized source pane to be the target pane", async () => {
  await expectRefused(await fixture("atdd-flow", { authorizedSourcePane: "w5:pZ" }), /exact adoption tuple|same pane|source pane/i);
});

test("guard: missing authorization, ambiguous or evidence-bearing tasks and non-adoption use refuse", async () => {
  await expectRefused(await fixture("atdd-flow", { authorize: false }), "immutable operator authorization");
  for (const tasks of [[], [readyTask, readyTask], [{ ...readyTask, status: "in_progress", handoff: { phase: "red", evidence: "M-1" } }]]) {
    await expectRefused(await fixture("atdd-flow", { tasks }), noRequest("main@atdd-flow"));
  }
  const value = await fixture("atdd-flow");
  await expect(launchPiRuntime(value.root, value.address, ["--pane", value.target.pane, "--herdr-session", herdrSession, "--in-place"],
    { command: value.runtime.command, select: selectEconomy })).rejects.toThrow(/--in-place|adopt/);
  await expect(launchPiRuntime(value.root, value.address, args(value, ["--in-place", "--resume"]), { command: value.runtime.command, select: selectEconomy })).rejects.toThrow();
});
