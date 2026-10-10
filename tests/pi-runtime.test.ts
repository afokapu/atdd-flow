import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicYaml } from "../src/core";
import { readRuntimeState } from "../src/runtime-state";
import { createPiRuntime } from "../extensions/pi/index";

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
