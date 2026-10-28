import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicYaml } from "../src/core";
import { readRuntimeState } from "../src/runtime-state";
import installFlowExtension, { awaitLaunchActivation, createPiRuntime } from "../extensions/pi/index";

const seat = "driver.pi@demo";
const thread = "T-runtime";

async function temporaryDesk() {
  return mkdtemp(join(tmpdir(), "atdd-pi-runtime-"));
}

async function queueMail(root: string, id: string, created_at: string, recipients: string[] = [seat]) {
  await atomicYaml(join(root, "threads", thread, "thread.yaml"), {
    schema: "atdd-workflow/thread/v1", id: thread, subject: "Runtime delivery", participants: ["coordinator@demo", ...recipients], state: "open",
  });
  await atomicYaml(join(root, "threads", thread, `${id}.yaml`), {
    schema: "atdd-workflow/message/v1", id, from: "coordinator@demo", to: recipients, created_at, body: id,
  });
  await atomicYaml(join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(seat), "pending", "S-runtime.yaml"), {
    schema: "atdd-flow/pi-inbox-segment/v1", entries: [{ thread, message: id, created_at, published: true }],
  });
  await atomicYaml(join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(seat), "queue.yaml"), {
    schema: "atdd-flow/pi-inbox-queue/v1", head: "S-runtime", tail: "S-runtime",
  });
}

test("a replacement runtime fences the old runtime and keeps one bounded inbox transport", async () => {
  const root = await temporaryDesk();
  const oldDelivered: string[] = [];
  const newDelivered: string[] = [];
  try {
    const oldRuntime = createPiRuntime({ root, seat, pid: 101, model: "pi-old", cwd: "/old", deliver: async (mail, _thread, _path, sendIfOwned) => sendIfOwned?.(() => { oldDelivered.push(mail.id); }) ?? false });
    await oldRuntime.start();
    const replacement = createPiRuntime({ root, seat, pid: 202, model: "pi-new", cwd: "/new", deliver: async (mail, _thread, _path, sendIfOwned) => sendIfOwned?.(() => { newDelivered.push(mail.id); }) ?? false });
    await replacement.start();
    await queueMail(root, "M-replaced", "2026-10-10T12:00:00.000Z");

    await oldRuntime.reconcile();
    await replacement.reconcile();
    await replacement.reconcile();

    expect(oldDelivered).toEqual([]);
    expect(newDelivered).toEqual(["M-replaced"]);
    expect(await readRuntimeState(root, seat)).toMatchObject({ pid: 202, model: "pi-new" });
    await oldRuntime.stop();
    expect(await readRuntimeState(root, seat)).toMatchObject({ pid: 202 });
    await replacement.stop();
    expect(await readRuntimeState(root, seat)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a paused old delivery loses the cross-process fence before it can wake", async () => {
  const root = await temporaryDesk();
  const oldDelivered: string[] = [];
  const newDelivered: string[] = [];
  let oldReachedDelivery!: () => void;
  let releaseOld!: () => void;
  const oldReached = new Promise<void>((resolve) => { oldReachedDelivery = resolve; });
  const released = new Promise<void>((resolve) => { releaseOld = resolve; });
  try {
    const oldRuntime = createPiRuntime({
      root, seat, pid: 101, model: "pi-old", cwd: "/old",
      deliver: async (mail, _thread, _path, sendIfOwned) => {
        oldReachedDelivery();
        await released;
        return sendIfOwned?.(() => { oldDelivered.push(mail.id); }) ?? false;
      },
    });
    await oldRuntime.start();
    await queueMail(root, "M-fenced", "2026-10-10T12:00:00.000Z");
    const oldReconcile = oldRuntime.reconcile();
    await oldReached;

    const replacement = createPiRuntime({
      root, seat, pid: 202, model: "pi-new", cwd: "/new",
      deliver: async (mail, _thread, _path, sendIfOwned) => sendIfOwned?.(() => { newDelivered.push(mail.id); }) ?? false,
    });
    const replacementStart = replacement.start();
    for (let attempt = 0; attempt < 100 && (await readRuntimeState(root, seat))?.pid !== 202; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await readRuntimeState(root, seat))?.pid).toBe(202);
    releaseOld();
    await oldReconcile;
    await replacementStart;
    await replacement.reconcile();

    expect(oldDelivered).toEqual([]);
    expect(newDelivered).toEqual(["M-fenced"]);
    await oldRuntime.stop();
    await replacement.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline rejection is retried after restart without duplicate wake", async () => {
  const root = await temporaryDesk();
  const delivered: string[] = [];
  try {
    await queueMail(root, "M-offline", "2026-10-10T12:00:00.000Z");
    const rejected = createPiRuntime({ root, seat, pid: 101, model: "pi", cwd: "/one", deliver: async () => { throw new Error("Pi rejected"); } });
    await rejected.start();
    await rejected.stop();

    const restarted = createPiRuntime({ root, seat, pid: 202, model: "pi", cwd: "/two", deliver: async (mail, _thread, _path, sendIfOwned) => sendIfOwned?.(() => { delivered.push(mail.id); }) ?? false });
    await restarted.start();
    await restarted.reconcile();
    expect(delivered).toEqual(["M-offline"]);
    await restarted.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RED: the extension runtime starts, registers, heartbeats, and stops in Node without Bun", async () => {
  const root = await temporaryDesk();
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "extensions", "pi", "index.ts")], outdir: join(root, "bundle"), target: "node", format: "esm" });
  expect(build.success).toBe(true);
  const extension = build.outputs[0]!.path;
  const fixture = join(root, "node-extension-runtime.mjs");
  await writeFile(fixture, `
    import { readFile, stat } from "node:fs/promises";
    import { createRequire } from "node:module";
    const { parse } = createRequire(process.env.FLOW_PACKAGE)("yaml");
    const { createPiRuntime } = await import(process.env.FLOW_EXTENSION);
    const root = process.env.FLOW_ROOT;
    const seat = "driver.pi@demo";
    const file = root + "/.atdd-flow/pi-runtime/" + encodeURIComponent(seat) + ".yaml";
    const runtime = createPiRuntime({ root, seat, pid: 303, model: "pi-node", cwd: "/node", heartbeatMs: 5, deliver: async () => false });
    await runtime.start();
    const registered = parse(await readFile(file, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const heartbeated = parse(await readFile(file, "utf8"));
    await runtime.stop();
    const stopped = await stat(file).then(() => false, () => true);
    console.log(JSON.stringify({ registered, heartbeated, stopped }));
  `);
  try {
    const child = Bun.spawn(["node", "--experimental-strip-types", fixture], {
      env: { ...process.env, FLOW_ROOT: root, FLOW_EXTENSION: pathToFileURL(extension).href, FLOW_PACKAGE: pathToFileURL(join(import.meta.dir, "..", "package.json")).href }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout) as { registered: Record<string, unknown>; heartbeated: Record<string, unknown>; stopped: boolean };
    expect(result.registered).toMatchObject({ seat, pid: 303, model: "pi-node", cwd: "/node" });
    expect(result.heartbeated.heartbeat_at).not.toBe(result.registered.heartbeat_at);
    expect(result.stopped).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RED: flow-wake registers a transcript-native command and orders request, authenticated model swap, thinking restore, and reload", async () => {
  const root = await temporaryDesk();
  const session = "01a12345-6789-7abc-8def-0123456789ab", pane = "w1:p2", sessionPath = join(root, `run_${session}.jsonl`);
  const names = ["ATDD_WORKFLOW_ROOT", "ATDD_WORKFLOW_SEAT", "ATDD_FLOW_PI_SESSION", "ATDD_FLOW_HERDR_SESSION", "ATDD_FLOW_HERDR_PANE"] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  const calls: string[] = [], entries: Array<{ customType: string; data: Record<string, unknown> }> = [];
  let command: { handler(args: string, context: unknown): Promise<void> } | undefined, modelAccepted = true;
  const source = { provider: "old", id: "source" }, target = { provider: "new", id: "exact" };
  try {
    Object.assign(process.env, { ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: seat, ATDD_FLOW_PI_SESSION: session, ATDD_FLOW_HERDR_SESSION: "forge", ATDD_FLOW_HERDR_PANE: pane });
    await atomicYaml(join(root, "models.yaml"), {
      schema: "atdd-workflow/models/v1",
      models: [{ id: "target", executable: "pi", args: ["--provider", "new", "--model", "exact"] }],
      model_migrations: { restore: { "old/source": "target" } },
    });
    await atomicYaml(join(root, "work", "demo", "seats", "driver.pi", "seat.yaml"), {
      schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/pi",
      runtime: { application: "herdr", wake: "native", addresses: { herdr: { session: "forge", pane } }, pi_session: session, pi_session_path: sessionPath },
    });
    installFlowExtension({
      on() {}, sendMessage() {},
      registerCommand(name: string, options: unknown) { if (name === "flow-wake") command = options as typeof command; },
      appendEntry(customType: string, data: Record<string, unknown>) { calls.push(customType); entries.push({ customType, data }); },
      async setModel(model: unknown) { calls.push(`model:${(model as { provider: string }).provider}/${(model as { id: string }).id}`); return modelAccepted; },
      getThinkingLevel() { return "high"; },
      setThinkingLevel(level: string) { calls.push(`thinking:${level}`); },
    } as never);
    expect(command).toBeDefined();
    const context = (branch: unknown[] = []) => ({
      cwd: "/work/demo", model: source, hasUI: false, ui: { notify() {} },
      modelRegistry: { find: (provider: string, id: string) => provider === "new" && id === "exact" ? target : undefined, getAvailable: () => [source, target], hasConfiguredAuth: () => true },
      sessionManager: { getSessionId: () => session, getSessionFile: () => sessionPath, getBranch: () => branch },
      async reload() { calls.push("reload"); },
    });
    await command!.handler("target request-unique-1", context());
    expect(entries[0]).toMatchObject({ customType: "flow-wake-request/v1", data: { request_id: "request-unique-1", candidate: "target", seat, pi_session: session, pane } });
    expect(calls).toEqual(["flow-wake-request/v1", "model:new/exact", "thinking:high", "reload"]);
    expect(entries.every((value) => value.customType !== "atdd-flow-start")).toBe(true); // appendEntry is non-context; startup is emitted only after reload.

    const beforeDuplicate = calls.length;
    await command!.handler("target request-unique-1", context([{ type: "custom", customType: "flow-wake-request/v1", data: { request_id: "request-unique-1" } }]));
    expect(calls.slice(beforeDuplicate)).not.toContain("model:new/exact");
    expect(calls.slice(beforeDuplicate)).not.toContain("reload");
    expect(entries.at(-1)).toMatchObject({ customType: "flow-wake-result/v1", data: { request_id: "request-unique-1", outcome: "failed" } });

    modelAccepted = false;
    const beforeAuthFailure = calls.length;
    await command!.handler("target request-auth-1", context());
    expect(entries.at(-1)).toMatchObject({ customType: "flow-wake-result/v1", data: { request_id: "request-auth-1", outcome: "failed" } });
    expect(calls.slice(beforeAuthFailure)).not.toContain("reload");
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

test("RED: reload reconstructs one unmatched request from the active branch and combines recovery plus task directive into one trigger", async () => {
  const root = await temporaryDesk();
  const piSession = "01a12345-6789-7abc-8def-0123456789ab", pane = "w1:p2", sessionPath = join(root, `run_${piSession}.jsonl`), receipt = join(root, "receipt.yaml");
  const names = ["ATDD_WORKFLOW_ROOT", "ATDD_WORKFLOW_SEAT", "ATDD_FLOW_PI_SESSION", "ATDD_FLOW_HERDR_SESSION", "ATDD_FLOW_HERDR_PANE"] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  let start: ((event: unknown, context: unknown) => Promise<void>) | undefined, shutdown: (() => void) | undefined;
  const entries: Array<{ customType: string; data: Record<string, unknown> }> = [], sent: Array<{ value: { customType: string; content: string }; options?: { triggerTurn?: boolean } }> = [];
  try {
    Object.assign(process.env, { ATDD_WORKFLOW_ROOT: root, ATDD_WORKFLOW_SEAT: seat, ATDD_FLOW_PI_SESSION: piSession, ATDD_FLOW_HERDR_SESSION: "forge", ATDD_FLOW_HERDR_PANE: pane });
    await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: piSession, pi_session_path: sessionPath, herdr_session: "forge", pane });
    await atomicYaml(join(root, "work", "demo", "seats", "driver.pi", "seat.yaml"), { schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/pi", runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane } }, pi_session: piSession, pi_session_path: sessionPath, launch_receipt: receipt } });
    await atomicYaml(join(root, "work", "demo", "tasks", "wake.yaml"), { schema: "atdd-workflow/task/v1", title: "wake", status: "in_progress", coordinator: "main@demo", assignee: seat, phase: "red", handoff: { state: "executing", evidence: "accepted", updated_at: new Date().toISOString() }, done_when: [{ text: "wake" }] });
    const request = { type: "custom", id: "request-entry", parentId: null, timestamp: new Date().toISOString(), customType: "flow-wake-request/v1", data: { request_id: "request-reload-1", seat, pi_session: piSession, pi_session_path: sessionPath, herdr_session: "forge", pane, source: { provider: "old", model: "source", thinking: "high" } } };
    installFlowExtension({
      on(event: string, listener: unknown) { if (event === "session_start") start = listener as typeof start; if (event === "session_shutdown") shutdown = listener as typeof shutdown; },
      registerCommand() {}, appendEntry(customType: string, data: Record<string, unknown>) { entries.push({ customType, data }); },
      sendMessage(value: { customType: string; content: string }, options?: { triggerTurn?: boolean }) { sent.push({ value, options }); },
    } as never);
    await start?.({}, { hasUI: false, model: { provider: "old", id: "source" }, thinkingLevel: "high", sessionManager: { getSessionId: () => piSession, getSessionFile: () => sessionPath, getBranch: () => [request] } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(entries.map((value) => value.customType)).toContain("flow-wake-capability/v1");
    expect(entries).toContainEqual(expect.objectContaining({ customType: "flow-wake-result/v1", data: expect.objectContaining({ request_id: "request-reload-1" }) }));
    const triggered = sent.filter((message) => message.options?.triggerTurn);
    expect(triggered).toHaveLength(1);
    expect(triggered[0]?.value.customType).toBe("atdd-flow-start");
    expect(triggered[0]?.value.content).toContain("RECOVERY BUNDLE");
    expect(triggered[0]?.value.content).toContain("authoritative next action");
    expect(await readRuntimeState(root, seat)).not.toHaveProperty("capabilities");
    shutdown?.();
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

test("startup activation waits for the verified receipt and exact binding, activates once, and owner shutdown clears state", async () => {
  const root = await temporaryDesk();
  const activation = { count: 0 };
  const piSession = "01a12345-6789-7abc-8def-0123456789ab";
  const sessionPath = `/Users/test/.pi/agent/sessions/demo/run_${piSession}.jsonl`;
  const receipt = join(root, ".atdd-flow", "runtime-launch", "verified.yaml");
  const runtime = createPiRuntime({ root, seat, pid: 404, model: "pi", cwd: "/node", heartbeatMs: 5, deferActivation: true, deliver: async () => false });
  try {
    await runtime.start();
    expect(runtime.transport).toBeUndefined();
    const waiting = awaitLaunchActivation({
      root, seat, piSession, herdrSession: "forge", pane: "w1:p2", intervalMs: 1, timeoutMs: 100,
      activate: async () => { await runtime.activate(); activation.count += 1; },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(activation.count).toBe(0);

    await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: piSession, pi_session_path: sessionPath, herdr_session: "forge", pane: "w1:p2" });
    await atomicYaml(join(root, "work", "demo", "seats", "driver.pi", "seat.yaml"), {
      schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/pi",
      runtime: { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, pi_session: piSession, pi_session_path: sessionPath, launch_receipt: receipt },
    });
    await waiting;
    await waiting;
    expect(activation.count).toBe(1);
    expect(runtime.transport).toBeDefined();
    await runtime.stop();
    expect(await readRuntimeState(root, seat)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup activation times out without a receipt or binding", async () => {
  const root = await temporaryDesk();
  const piSession = "01a12345-6789-7abc-8def-0123456789ab";
  try {
    await expect(awaitLaunchActivation({
      root, seat, piSession, herdrSession: "forge", pane: "w1:p2", intervalMs: 1, timeoutMs: 5,
      activate: async () => { throw new Error("must not activate"); },
    })).rejects.toThrow("verified Flow launch receipt and binding");
    expect(await Bun.file(join(root, ".atdd-flow", "runtime-launch", "verified.yaml")).exists()).toBe(false);
    expect(await Bun.file(join(root, "work", "demo", "seats", "driver.pi", "seat.yaml")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rapid broadcast references remain queued for an offline participant", async () => {
  const root = await temporaryDesk();
  const other = "driver.other@demo";
  const ids = ["M-rapid-1", "M-rapid-2", "M-rapid-3"];
  const first: string[] = [];
  const second: string[] = [];
  try {
    await atomicYaml(join(root, "threads", thread, "thread.yaml"), {
      schema: "atdd-workflow/thread/v1", id: thread, subject: "Broadcast", participants: ["coordinator@demo", seat, other], state: "open",
    });
    for (const [index, id] of ids.entries()) {
      await atomicYaml(join(root, "threads", thread, `${id}.yaml`), {
        schema: "atdd-workflow/message/v1", id, from: "coordinator@demo", to: "all", created_at: `2026-10-10T12:00:0${index}.000Z`, body: id,
      });
    }
    for (const target of [seat, other]) {
      const inbox = join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(target));
      await atomicYaml(join(inbox, "pending", "S-rapid.yaml"), {
        schema: "atdd-flow/pi-inbox-segment/v1",
        entries: ids.map((id, index) => ({ thread, message: id, created_at: `2026-10-10T12:00:0${index}.000Z`, published: true })),
      });
      await atomicYaml(join(inbox, "queue.yaml"), { schema: "atdd-flow/pi-inbox-queue/v1", head: "S-rapid", tail: "S-rapid" });
    }

    const online = createPiRuntime({ root, seat, pid: 101, model: "pi", cwd: "/one", deliver: async (mail, _thread, _path, sendIfOwned) => sendIfOwned?.(() => { first.push(mail.id); }) ?? false });
    await online.start();
    expect(first).toEqual(ids);
    const resumed = createPiRuntime({ root, seat: other, pid: 202, model: "pi", cwd: "/two", deliver: async (mail, _thread, _path, sendIfOwned) => sendIfOwned?.(() => { second.push(mail.id); }) ?? false });
    await resumed.start();
    expect(second).toEqual(ids);
    await online.stop();
    await resumed.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
