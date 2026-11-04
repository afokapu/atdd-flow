// URN: component:flow:e006:stale-adopt-fixtures:backend:integration
// Tested-By:
// - test:flow:stale-binding-adoption-in-place
// - test:flow:exact-adoption-requestless-resumed
// Runtime: bun
// Purpose: Throwaway stale-bound main Desks and a fake Herdr; no live fleet state.

import { afterEach, expect } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, paths } from "../src/core";
import { launchPiRuntime } from "../src/seats";

export const herdrSession = "forge", staleSession = "ed0280b7-ab1e-4f93-918a-ab9f6794413c";
const roots: string[] = [];
export const noRequest = (address: string) => `${address} requires one validated Path-A replacement request; refusing runtime launch.`;
// Operator-authorized live targets (M-20261104T051525Z); the source pane IS the target pane.
export const targets = {
  "atdd-flow": { session: "01a19f3a-7322-748a-bbdb-f1e0ca44975b", pane: "w5:pN", stalePane: "w5:p1" },
  "decision-os": { session: "01a19f3a-7335-7056-8911-37031853bc6b", pane: "w2:pC", stalePane: "w2:p1" },
  "frg-workstation": { session: "01a19f3a-7322-71a7-af67-bb8fa63be8dd", pane: "w6:pH", stalePane: "w6:p1" },
} as const;
export type Name = keyof typeof targets;
export const selectEconomy = async () => ({ available: true as const, model: "test", selected_model: "economy", confidence: 0.99 });
export const readyTask = { title: "Main takeover", status: "todo", done_when: [{ text: "Successor resumes." }] };

/** What the fake Herdr currently reports for the target pane. */
export type Live = { path?: string; cwd: string; pi: number; others: Array<{ pane: string; path: string }>; startable?: boolean };

const sessionOf = (value: string) => ({ kind: "path", source: "herdr:pi", value });

/** The fake pane record; an empty pane reports no agent and no session. */
function paneRecord(pane: string, live: Live) {
  if (!live.path) return { pane_id: pane, agent: null, agent_status: "unknown", agent_session: null, cwd: live.cwd };
  return { pane_id: pane, agent: "pi", agent_status: "idle", agent_session: sessionOf(live.path), cwd: live.cwd };
}

/** Every Pi agent Herdr would list: the target occupant plus any extra (duplicate or stale) writers. */
function agentList(name: string, pane: string, live: Live) {
  const target = live.path ? [{ name, agent: "pi", pane_id: pane, agent_session: sessionOf(live.path) }] : [];
  return target.concat(live.others.map((other) => ({ name: "other", agent: "pi", pane_id: other.pane, agent_session: sessionOf(other.path) })));
}

/**
 * A fake Herdr that records every call and answers only read-only queries. Any run/start (a second launch)
 * is an unexpected command and throws, so a test that reaches one fails loudly.
 */
export function harness(name: Name, live: Live, repository: string) {
  const { pane } = targets[name], calls: string[][] = [];
  const agentName = `flow-main-${name}`.slice(0, 32);
  const answers: Record<string, (command: string[]) => unknown> = {
    "workspace list": () => ({ workspaces: [{ workspace_id: "w1", label: name, worktree: { checkout_path: repository } }] }),
    "tab list": () => ({ tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: `main@${name}` }] }),
    "pane list": () => ({ panes: [{ pane_id: pane, tab_id: "w1:t1", label: `main@${name}`, agent: live.path ? "pi" : null, agent_status: live.path ? "idle" : "unknown" }] }),
    "pane get": () => ({ pane: paneRecord(pane, live) }),
    "pane process-info": () => ({ process_info: { pane_id: pane, shell_pid: 42,
      foreground_processes: Array.from({ length: live.path ? live.pi : 0 }, (_, index) => ({ name: "node", argv0: "pi", pid: 100 + index, cwd: live.cwd })) } }),
    "agent get": () => ({ agent: { name: agentName, agent: "pi", pane_id: pane, agent_status: "idle", agent_session: sessionOf(live.path!), cwd: live.cwd } }),
    "agent list": () => ({ agents: agentList(agentName, pane, live) }),
    // Only an explicitly startable pane (a vacated shell) may launch; the adopted JSONL then becomes the live occupant.
    "pane run": () => ({ pane_id: pane }),
    "agent start": (command) => {
      if (!live.startable) throw new Error(`Unexpected Herdr command (a second launch must not occur): ${command.join(" ")}`);
      live.path = command[command.lastIndexOf("--session") + 1];
      return { name: agentName };
    },
  };
  return {
    live, calls,
    mutations: () => calls.filter((call) => ["run", "start"].includes(call[4]!)).length,
    command: async (command: string[]) => {
      calls.push(command);
      const answer = answers[command.slice(3, 5).join(" ")];
      if (!answer) throw new Error(`Unexpected Herdr command (a second launch must not occur): ${command.join(" ")}`);
      return JSON.stringify({ result: answer(command) });
    },
  };
}

export type Options = { tasks?: Array<Record<string, unknown>>; authorize?: boolean; authorizedSourcePane?: string; live?: Partial<Live> };
export async function fixture(name: Name, options: Options = {}) {
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
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const args = (value: Fixture, extra: string[] = []) => ["--pane", value.target.pane, "--herdr-session", herdrSession, "--adopt-session", value.livePath,
  "--source-herdr-session", herdrSession, "--source-pane", value.target.pane, "--authorization", value.authorizationId, ...extra];
export const reconcile = (value: Fixture, extra: string[] = ["--in-place"]) => launchPiRuntime(value.root, value.address, args(value, extra),
  { command: value.runtime.command, select: selectEconomy, hostPane: "w9:p9", at: () => "2026-11-04T08:00:00.000Z" });
export const seatFile = (value: Fixture) => readFile(paths(value.root).seatFile(value.address), "utf8");
export const receipts = async (root: string) => (await readdir(join(root, ".atdd-flow", "runtime-launch")).catch(() => [] as string[])).filter((file) => !file.includes("stale") && file.endsWith(".yaml"));

export async function expectRefused(value: Fixture, message: string | RegExp, extra: string[] = ["--in-place"]) {
  const before = await seatFile(value);
  await expect(reconcile(value, extra)).rejects.toThrow(message);
  expect(await seatFile(value)).toBe(before);
  expect(await receipts(value.root)).toEqual([]);
  expect(value.runtime.mutations()).toBe(0);
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
