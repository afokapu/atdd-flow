// URN: test:atdd-flow:server-side-context-monitor
// Acceptance: acc:flow:E025-UNIT-001
// Phase: UNIT
// Purpose: The context-threshold handover trigger is driven by Flow from the exact Pi transcript, so a session that runs stale
// extension code is still prompted once at the Desk threshold, and every unsafe or unknown state is reported without a prompt.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths } from "../src/core";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const session = "01a12345-6789-7abc-8def-0123456789ab";
const roots: string[] = [];
type Spec = {
  tokens?: number | null;
  window?: number | null;
  provider?: string;
  status?: string;
  prompted?: boolean;
  threshold?: number;
  agent?: boolean;
};

async function fixture(spec: Spec = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-context-monitor-"));
  roots.push(root);
  const bin = join(root, "bin"), log = join(root, "herdr.log"), state = join(root, "herdr-state.json");
  await Bun.write(join(root, "desk.yaml"), `schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n${spec.threshold ? `context_handover:\n  threshold_percent: ${spec.threshold}\n` : ""}`);
  await atomicYaml(paths(root).models, {
    schema: "atdd-workflow/models/v1",
    models: [{ id: "source", executable: "pi", args: ["--provider", "old", "--model", "source"], ...(spec.window === null ? {} : { context_window: spec.window ?? 200_000 }) }],
  });
  const address = "driver.alpha@demo", pane = "w1:p1", cwd = join(root, "worktrees", "alpha"), transcript = join(root, `alpha_${session}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: session, timestamp: "2026-11-03T03:00:00.000Z", cwd }),
    JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-11-03T03:00:00.000Z", provider: "old", modelId: "source" }),
    ...(spec.tokens === null ? [] : [JSON.stringify({ type: "message", id: "a1", parentId: "m1", timestamp: "2026-11-03T03:01:00.000Z",
      message: { role: "assistant", provider: spec.provider ?? "old", model: "source", usage: { input: 2, output: 20, cacheRead: 1, cacheWrite: 1, totalTokens: spec.tokens ?? 170_000 } } })]),
    ...(spec.prompted ? [JSON.stringify({ type: "custom_message", id: "t1", parentId: spec.tokens === null ? "m1" : "a1", timestamp: "2026-11-03T03:02:00.000Z",
      customType: "atdd-flow-context-handover-replacement", content: "SYSTEM: Context 85% reached", details: { seat: address, threshold: 80, percent: 85, authority: "handover" } })] : []),
  ];
  await writeFile(transcript, `${lines.join("\n")}\n`);
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "driver", project: "demo", worktree: cwd, branch: "delivery/alpha",
    runtime: { application: "herdr", wake: "native", addresses: { herdr: { session: "forge", pane } }, pi_session: session, pi_session_path: transcript },
  });
  await atomicYaml(paths(root).taskFile("demo", "work"), { schema: "atdd-workflow/task/v1", title: "work", status: "in_progress", coordinator: "main@demo", assignee: address, done_when: [{ text: "x" }] });
  await atomicYaml(join(root, ".atdd-flow", "pi-runtime", `${encodeURIComponent(address)}.yaml`), {
    schema: "atdd-flow/pi-runtime-state/v1", seat: address, owner_token: "owner-alpha", pid: 5001, model: "source", cwd,
    started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
  });
  await writeFile(state, JSON.stringify({ pane, address, cwd, transcript, status: spec.status ?? "idle", agent: spec.agent === false ? null : "pi" }));
  await writeFile(log, "");
  await Bun.write(join(root, "fake-herdr.ts"), `#!/usr/bin/env bun
import { appendFile, readFile } from "node:fs/promises";
const args = process.argv.slice(2), observed = JSON.parse(await readFile(process.env.FAKE_HERDR_STATE!, "utf8"));
await appendFile(process.env.FAKE_HERDR_LOG!, JSON.stringify(args) + "\\n");
const print = (value: unknown) => process.stdout.write(JSON.stringify({ id: "fake", result: value }));
const agent = observed.agent ? { agent: "pi", agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: observed.transcript }, agent_status: observed.status, cwd: observed.cwd, pane_id: observed.pane } : null;
if (args.includes("prompt")) print({ accepted: true });
else if (args.includes("pane") && args.includes("get")) print({ pane: agent && { ...agent, label: observed.address } });
else if (args.includes("process-info")) print({ process_info: { foreground_processes: observed.agent ? [{ argv0: "pi", cwd: observed.cwd, name: "node", pid: 5001 }] : [], pane_id: observed.pane } });
else print({});
`);
  await chmod(join(root, "fake-herdr.ts"), 0o755);
  await Bun.write(join(bin, "herdr"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "fake-herdr.ts"))} "$@"\n`);
  await chmod(join(bin, "herdr"), 0o755);
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, "--root", root, ...args], {
      cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_HERDR_STATE: state, FAKE_HERDR_LOG: log, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, output: `${stdout}${stderr}` };
  };
  const prompts = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]).filter((args) => args.includes("prompt"));
  const markers = () => readdir(join(root, ".atdd-flow", "context-monitor")).catch(() => [] as string[]);
  return { root, address, run, prompts, markers };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const monitor = (value: { address: string }, ...extra: string[]) => ["pi", "context-monitor", value.address, "--by", "main@demo", ...extra];

test("RED: a session over the default 80% threshold is prompted once from its transcript, without extension cooperation", async () => {
  const value = await fixture({ tokens: 170_000 });
  const first = await value.run(...monitor(value));
  expect(first.output).toContain(`${value.address}  prompted  85% of 200000 tokens`);
  expect(first.code).toBe(0);
  const sent = await value.prompts();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("w1:p1");
  expect(sent[0]!.join(" ")).toContain("SYSTEM: Context 85% reached the Flow handover threshold (80%).");
  expect(await value.markers()).toHaveLength(1);

  const second = await value.run(...monitor(value));
  expect(second.output).toContain(`${value.address}  already  `);
  expect(await value.prompts()).toHaveLength(1);
}, 60_000);

test("the Desk policy threshold applies", async () => {
  const value = await fixture({ tokens: 170_000, threshold: 90 });
  expect((await value.run(...monitor(value))).output).toContain(`${value.address}  below  85% of 200000 tokens; threshold 90%`);
  expect(await value.prompts()).toHaveLength(0);
  expect(await value.markers()).toHaveLength(0);
});

test("--dry-run reports the crossing without a prompt or a marker", async () => {
  const value = await fixture();
  expect((await value.run(...monitor(value, "--dry-run"))).output).toContain(`${value.address}  would-prompt  `);
  expect(await value.prompts()).toHaveLength(0);
  expect(await value.markers()).toHaveLength(0);
});

test("a model without a declared context window is reported and never guessed", async () => {
  const value = await fixture({ window: null });
  expect((await value.run(...monitor(value))).output).toContain(`${value.address}  skipped  no context_window declared for old/source`);
  expect(await value.prompts()).toHaveLength(0);
});

test("a transcript without assistant usage is skipped", async () => {
  const value = await fixture({ tokens: null });
  expect((await value.run(...monitor(value))).output).toContain(`${value.address}  skipped  no assistant usage`);
  expect(await value.prompts()).toHaveLength(0);
});

test("a session the extension already prompted at the threshold is not prompted again", async () => {
  const value = await fixture({ prompted: true });
  expect((await value.run(...monitor(value))).output).toContain(`${value.address}  already  threshold prompt already in the transcript`);
  expect(await value.prompts()).toHaveLength(0);
});

test("a working agent is deferred, not prompted mid-turn", async () => {
  const value = await fixture({ status: "working" });
  expect((await value.run(...monitor(value))).output).toContain(`${value.address}  deferred  `);
  expect(await value.prompts()).toHaveLength(0);
});

test("a pane that no longer runs Pi is skipped", async () => {
  const value = await fixture({ agent: false });
  expect((await value.run(...monitor(value))).output).toContain(`${value.address}  skipped  `);
  expect(await value.prompts()).toHaveLength(0);
});

test("a transcript model that does not match a declared window is reported", async () => {
  const value = await fixture({ provider: "other" });
  expect((await value.run(...monitor(value))).output).toContain("no context_window declared for other/source");
  expect(await value.prompts()).toHaveLength(0);
});

test("an unauthorized actor is refused before anything is read or sent", async () => {
  const value = await fixture();
  const result = await value.run("pi", "context-monitor", value.address, "--by", "driver.other@demo");
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("not authorized");
  expect(await value.prompts()).toHaveLength(0);
});

test("the closed grammar rejects a model profile and a missing --by", async () => {
  const value = await fixture();
  expect((await value.run("pi", "context-monitor", value.address)).code).not.toBe(0);
  expect((await value.run(...monitor(value, "--model-profile", "restore"))).code).not.toBe(0);
});

test("a declared context window must be a positive integer", async () => {
  const value = await fixture();
  await atomicYaml(paths(value.root).models, { schema: "atdd-workflow/models/v1", models: [{ id: "source", executable: "pi", args: ["--provider", "old", "--model", "source"], context_window: -5 }] });
  const result = await value.run(...monitor(value));
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("context_window");
});
