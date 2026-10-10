import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
