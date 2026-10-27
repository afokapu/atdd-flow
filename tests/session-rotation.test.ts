// URN: test:flow:session-rotation:E014-UNIT-001
// Acceptance: acc:flow:E014-UNIT-001
// Phase: UNIT
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths } from "../src/core";
import { clearRuntimeState, registerRuntimeState } from "../src/runtime-state";
import { selectQuotaHandoffModel } from "../src/quota-handoff";
import { requestSessionRotation, reconcileRotations } from "../src/session-rotation";
import type { launchPiRuntime } from "../src/seats";
import { runtimeStartupInstruction } from "../src/collaboration-policy";

const roots: string[] = [];
const address = "driver.delivery@demo", session = "01a12345-6789-7abc-8def-0123456789ab";
const token = "owned-by-pi";
const before = new Date(Date.now() - 2_000);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(role: "driver" | "main" = "driver") {
  const root = await mkdtemp(join(tmpdir(), "flow-session-rotation-"));
  roots.push(root);
  const executable = join(root, "pi");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  await atomicYaml(paths(root).desk, {
    schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr",
    executables: { pi: executable }, fallback_model: { driver: "standby" },
  });
  await atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [
    { id: "primary", executable: "pi", args: ["--model", "primary"] },
    { id: "standby", executable: "pi", args: ["--model", "openai-codex/gpt-6-luna"] },
    { id: "alternative", executable: "pi", args: ["--model", "independent-provider/worker"] },
  ] });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", roles: {} });
  const receipt = join(root, ".atdd-flow", "runtime-launch", "source.yaml");
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, pi_session: session,
    candidate: "primary", herdr_session: "forge", pane: "w1:p2" });
  await atomicYaml(paths(root).seatFile(address), { schema: "atdd-workflow/seat/v2", address,
    role, project: "demo", branch: "delivery", worktree: "/work/demo",
    runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } },
      pi_session: session, pi_session_path: `/tmp/source_${session}.jsonl`, launch_receipt: receipt, wake: "native" } });
  await registerRuntimeState(root, { seat: address, owner_token: token, pid: process.pid, model: "pi",
    cwd: "/work/demo", pi_session: session });
  return root;
}

async function handover(root: string, sessionId = session) {
  const text = [
    `HANDOVER ${address} | 2026-10-27T09:00:00Z | handover-id H-rotation | supersedes none`,
    `Runtime: herdr forge:w1:p2 | pi session ${sessionId} | model provider/model | context 80%`,
    "", "1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS", "- safe",
    "", "2. OPEN WORK AND IN-FLIGHT OPERATIONS", "- exact task: demo/delivery",
    "", "3. DEPENDENCIES", "- none",
    "", "4. RESUME PROCEDURE AND NEXT ACTIONS", "- atdd-flow open driver.delivery@demo",
  ].join("\n");
  await atomicYaml(paths(root).handoverFile(address), { schema: "atdd-workflow/handover/v1",
    seat: address, handover_id: "H-rotation", supersedes: "none", text, recorded_at: new Date().toISOString() });
}

test("a context handover must be validated, fresh, and bound to the exact source Pi session", async () => {
  const root = await fixture();
  expect(await requestSessionRotation(root, address, token, "context", before)).toBe(false);
  await handover(root, "wrong-session");
  expect(await requestSessionRotation(root, address, token, "context", before)).toBe(false);
  await handover(root);
  expect(await requestSessionRotation(root, address, token, "context", before)).toBe(true);
  expect(await requestSessionRotation(root, address, "stale-token", "context", before)).toBe(false);
  const pending = await reconcileRotations(root, { dryRun: true });
  expect(pending).toEqual([{ seat: address, outcome: "running" }]);
});

test("release allows one deterministic new-session launch without invoking Jev", async () => {
  const root = await fixture();
  await handover(root);
  expect(await requestSessionRotation(root, address, token, "context", before)).toBe(true);
  await clearRuntimeState(root, address, token);
  expect(await reconcileRotations(root, { dryRun: true })).toEqual([{ seat: address, outcome: "ready" }]);
  const selections: string[] = [];
  const mockLaunch = (async (_root: string, seat: string, args: string[], dependencies: Parameters<typeof launchPiRuntime>[3]) => {
    expect(seat).toBe(address);
    expect(args).toEqual(["--herdr-session", "forge", "--pane", "w1:p2"]);
    const chosen = await dependencies.select!({ seat: { address, role: "driver" }, tasks: [],
      candidates: [{ id: "primary", executable: "pi" }, { id: "standby", executable: "pi" }] });
    expect(chosen.available).toBe(true);
    if (chosen.available) selections.push(chosen.selected_model);
    return {} as Awaited<ReturnType<typeof launchPiRuntime>>;
  }) as typeof launchPiRuntime;
  expect(await reconcileRotations(root, { launch: mockLaunch })).toEqual([{ seat: address, outcome: "launched" }]);
  expect(selections).toEqual(["primary"]);
  expect(await reconcileRotations(root, { launch: mockLaunch })).toEqual([]);
});

test("quota rescue writes a validated handover before resuming on a third candidate", async () => {
  const root = await fixture();
  expect(await requestSessionRotation(root, address, token, "rate_limit", before)).toBe(false);
  await handover(root);
  expect(await requestSessionRotation(root, address, token, "rate_limit", before)).toBe(true);
  await clearRuntimeState(root, address, token);
  const picked: string[] = [];
  const stub = (async (_root: string, _seat: string, _args: string[], deps: Parameters<typeof launchPiRuntime>[3]) => {
    const model = await deps.select!({ seat: { address, role: "driver" }, tasks: [],
      candidates: [{ id: "primary", executable: "pi" }, { id: "standby", executable: "pi" }, { id: "alternative", executable: "pi" }] });
    if (model.available) picked.push(model.selected_model);
    return {} as Awaited<ReturnType<typeof launchPiRuntime>>;
  }) as typeof launchPiRuntime;
  expect((await reconcileRotations(root, { launch: stub }))[0]?.outcome).toBe("launched");
  expect(picked).toEqual(["alternative"]);
});

test("main remains governed by Path-A rather than autonomous session rotation", async () => {
  const root = await fixture("main");
  await handover(root);
  expect(await requestSessionRotation(root, address, token, "context", before)).toBe(false);
  expect(await requestSessionRotation(root, address, token, "rate_limit")).toBe(false);
  expect(await reconcileRotations(root)).toEqual([]);
});

test("changed binding or failed launcher is fail-closed and preserves the recovery intent", async () => {
  const root = await fixture();
  await handover(root);
  await requestSessionRotation(root, address, token, "context", before);
  await clearRuntimeState(root, address, token);
  const broken = (async () => { throw new Error("old pane still occupied"); }) as typeof launchPiRuntime;
  expect((await reconcileRotations(root, { launch: broken }))[0]).toMatchObject({ outcome: "refused", detail: "old pane still occupied" });
  const old = Bun.YAML.parse(await Bun.file(paths(root).seatFile(address)).text());
  await atomicYaml(paths(root).seatFile(address), { ...old, runtime: { ...old.runtime, pi_session: "successor" } });
  expect((await reconcileRotations(root, { launch: broken }))[0]?.outcome).toBe("stale");
});

test("Pi hands exhausted quota to Luna for handoff-only, without releasing early", async () => {
  const root = await fixture();
  // A separate Bun process owns its environment and Pi lifecycle, as in production.
  // The parent test and any parallel tests retain their own environment unchanged.
  const extension = join(import.meta.dir, "..", "extensions", "pi", "index.ts");
  const script = [
    `import installFlowExtension from ${JSON.stringify(extension)};`,
    "const listeners = new Map();",
    "const sent = []; const selected = [];",
    "installFlowExtension({ on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); }, sendMessage(message) { sent.push(message); }, async setModel(model) { selected.push(model); return true; } });",
    "const emit = async (event, value, ctx) => Promise.all((listeners.get(event) ?? []).map(fn => fn(value, ctx)));",
    `const session = ${JSON.stringify(session)};`,
    "let shutdown = 0;",
    "await emit('session_start', {}, { sessionManager: { getSessionId: () => session, getSessionFile: () => '/tmp/observed.jsonl' }, hasUI: false });",
    "await emit('auto_retry_end', { success: false, attempt: 3, finalError: 'HTTP 429 rate limit reached' });",
    "await emit('agent_settled', { aborted: false }, { shutdown: () => { shutdown += 1; }, model: { provider: 'failed-provider', id: 'failed-model' }, modelRegistry: { find(provider, id) { return { provider, id }; } } });",
    "process.stdout.write(JSON.stringify({ shutdown, selected, sent: sent.map(message => message.customType) }));",
    "await emit('session_shutdown', {});",
  ].join("\n");
  const runner = join(root, "simulate-pi.ts");
  await writeFile(runner, script);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["ATDD_WORKFLOW_ROOT", "ATDD_WORKFLOW_SEAT", "ATDD_FLOW_PI_SESSION",
      "ATDD_FLOW_HERDR_SESSION", "ATDD_FLOW_HERDR_PANE", "HERDR_SESSION", "HERDR_PANE_ID"].includes(key)));
  const child = Bun.spawn([process.execPath, runner], {
    cwd: join(import.meta.dir, ".."), env: { ...env, ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: address },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stderr).toBe(0);
  const observed = JSON.parse(stdout);
  expect(observed.shutdown).toBe(0);
  expect(observed.selected).toEqual([{ provider: "openai-codex", id: "gpt-6-luna" }]);
  expect(observed.sent).toContain("atdd-flow-quota-handoff");
  expect(await reconcileRotations(root, { dryRun: true })).toEqual([]);
});

test("replacement startup explicitly points at the durable handover", () => {
  expect(runtimeStartupInstruction(address)).toContain(`atdd-flow handover show ${address}`);
});

test("a truncated rotation intent is isolated from the rest of fleet reconciliation", async () => {
  const root = await fixture();
  const folder = join(root, ".atdd-flow", "session-rotations");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "partial.yaml"), "[not-valid-yaml");
  const report = await reconcileRotations(root);
  expect(report).toHaveLength(1);
  expect(report[0]?.outcome).toBe("refused");
});

test("quota fallback is not considered an execution model or proof of independent quota", async () => {
  const root = await fixture();
  const selected: string[] = [];
  const context = { model: { provider: "failed-provider", id: "active" },
    modelRegistry: { find(provider: string, id: string) { return { provider, id }; } } };
  const host = { async setModel(model: { provider: string; id: string }) { selected.push(model.id); return true; } };
  expect(await selectQuotaHandoffModel(root, address, context as never, host as never)).toBe(true);
  expect(selected).toEqual(["gpt-6-luna"]);
  expect(await selectQuotaHandoffModel(root, address, { ...context,
    model: { provider: "openai-codex", id: "gpt-6-luna" } } as never, host as never)).toBe(false);
  expect(await selectQuotaHandoffModel(root, address, { ...context,
    modelRegistry: { find() { return undefined; } } } as never, host as never)).toBe(false);
});
