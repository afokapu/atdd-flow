import * as fs from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearStaleRuntimeState, clearRuntimeState, heartbeatRuntimeState, ownsRuntimeState, registerRuntimeState, runtimeOwnerToken, withOwnedRuntimeState } from "../../src/runtime-state";

type Thread = { id?: unknown; participants?: unknown; subject?: unknown };
export type Mail = { id?: unknown; from?: unknown; to?: unknown; subject?: unknown; created_at?: unknown };
type InboxMail = Mail & { id: string; created_at: string };
type PendingReference = { schema?: unknown; thread?: unknown; message?: unknown; created_at?: unknown };
type PendingSegment = { schema?: unknown; entries?: unknown; next?: unknown };
type PendingQueue = { schema?: unknown; head?: unknown; tail?: unknown };
type WakeAction = () => void | Promise<void>;
type SendIfOwned = (action: WakeAction) => Promise<boolean>;
type InboxOptions = {
  root: string;
  seat: string;
  /** Return false when this runtime has been replaced; the durable reference remains queued. */
  deliver: (mail: InboxMail, thread: Thread, path: string, sendIfOwned?: SendIfOwned) => boolean | void | Promise<boolean | void>;
  batchSize?: number;
  intervalMs?: number;
};

/** The sole internal delivery transport: one durable queue with watcher-as-fast-path recovery. */
export type FlowInboxTransport = {
  reconcile: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => void;
  watermarkFile: string;
};

export type PiRuntimeOptions = {
  root: string;
  seat: string;
  pid?: number;
  model?: string;
  cwd?: string;
  heartbeatMs?: number;
  staleAfterMs?: number;
  deliver: InboxOptions["deliver"];
  createTransport?: (options: InboxOptions) => FlowInboxTransport;
};

const defaultBatchSize = 32;
const defaultIntervalMs = 30_000;
const defaultHeartbeatMs = 15_000;
const defaultStaleAfterMs = 60_000;

function participants(thread: Thread) {
  return Array.isArray(thread.participants) && thread.participants.every((entry) => typeof entry === "string") ? thread.participants as string[] : [];
}

export function addressedTo(mail: Mail, thread: Thread, seat: string) {
  if (mail.from === seat) return false;
  if (Array.isArray(mail.to)) return mail.to.includes(seat);
  return mail.to === "all" && participants(thread).includes(seat);
}

/** A compact wake notice; the durable message body is read only on demand. */
export function mailNotice(threadId: string, mail: Mail) {
  const id = typeof mail.id === "string" ? mail.id : "unknown";
  const subject = typeof mail.subject === "string" ? mail.subject : undefined;
  const from = typeof mail.from === "string" ? mail.from : "unknown";
  const recipients = mail.to === "all" ? "all" : Array.isArray(mail.to) ? mail.to.join(", ") : "unknown";
  return `SYSTEM: Flow mail ${id} | thread ${threadId}${subject ? ` (${subject})` : ""} | ${from} → ${recipients}. Read: atdd-flow message read ${id}`;
}

function inboxDirectory(root: string, seat: string) {
  return join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(seat));
}

function pendingDirectory(root: string, seat: string) { return join(inboxDirectory(root, seat), "pending"); }
function queuePath(root: string, seat: string) { return join(inboxDirectory(root, seat), "queue.yaml"); }
function segmentPath(root: string, seat: string, segment: string) { return join(pendingDirectory(root, seat), `${segment}.yaml`); }

async function atomicYaml(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, stringify(value), "utf8");
  await rename(temporary, path);
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withInboxLock<T>(directory: string, action: () => Promise<T>) {
  await mkdir(directory, { recursive: true });
  const lock = join(directory, "queue.lock");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lock);
      try { return await action(); }
      finally { await rm(lock, { recursive: true, force: true }); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await rm(lock, { recursive: true, force: true });
        else await pause(5);
      } catch { await pause(5); }
    }
  }
  throw new Error(`Timed out waiting for inbox queue lock ${directory}`);
}

function validMail(value: Mail): value is InboxMail {
  return typeof value.id === "string" && typeof value.created_at === "string";
}

function validReference(value: PendingReference): value is Required<Pick<PendingReference, "thread" | "message" | "created_at">> {
  return typeof value.thread === "string" && typeof value.message === "string" && typeof value.created_at === "string";
}

function validQueue(value: PendingQueue): value is Required<Pick<PendingQueue, "head">> {
  return typeof value.head === "string";
}

function references(value: PendingSegment): PendingReference[] {
  return Array.isArray(value.entries) ? value.entries.filter((entry): entry is PendingReference => Boolean(entry) && typeof entry === "object") : [];
}

/**
 * Reconciles a bounded, durable queue of immutable Desk-message references.
 * The queue is appended when Flow persists mail, so recovery never rescans historical threads.
 */
export function createInboxTransport({ root, seat, deliver, batchSize = defaultBatchSize, intervalMs = defaultIntervalMs }: InboxOptions): FlowInboxTransport {
  let watcher: fs.FSWatcher | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const delivered = new Set<string>();
  let serial = Promise.resolve();

  const reconcileNow = async () => withInboxLock(inboxDirectory(root, seat), async () => {
    let queue: PendingQueue;
    try { queue = parse(await readFile(queuePath(root, seat), "utf8")) as PendingQueue; }
    catch { return; }
    if (!validQueue(queue)) return;
    const path = segmentPath(root, seat, queue.head);
    let segment: PendingSegment;
    try { segment = parse(await readFile(path, "utf8")) as PendingSegment; }
    catch { return; }
    const entries = references(segment);
    // A segment contains at most 32 references. A tick reads one durable head segment and at most batchSize mail records.
    for (let count = 0; count < batchSize && entries.length; count += 1) {
      const reference = entries[0];
      if (!validReference(reference)) { entries.shift(); await atomicYaml(path, { ...segment, entries }); continue; }
      const key = `${reference.thread}/${reference.message}`;
      try {
        const folder = join(root, "threads", reference.thread);
        const [rawThread, rawMail] = await Promise.all([
          readFile(join(folder, "thread.yaml"), "utf8"),
          readFile(join(folder, `${reference.message}.yaml`), "utf8"),
        ]);
        const thread = parse(rawThread) as Thread;
        const mail = parse(rawMail) as Mail;
        if (validMail(mail) && addressedTo(mail, thread, seat) && !delivered.has(key)) {
          const accepted = await deliver(mail, thread, join(folder, `${reference.message}.yaml`));
          // A replaced runtime must not consume the shared durable reference.
          if (accepted === false) return;
        }
        delivered.add(key);
        entries.shift();
        await atomicYaml(path, { ...segment, entries });
      } catch (error) {
        // A crash before message persistence leaves an unpublished prepare record. Retain it briefly for an in-flight post, then discard only the non-authoritative orphan.
        const age = Date.now() - Date.parse(reference.created_at);
        if (reference.published !== true && (error as NodeJS.ErrnoException).code === "ENOENT") {
          entries.shift();
          if (Number.isFinite(age) && age > 30_000) {
            await atomicYaml(path, { ...segment, entries });
            continue;
          }
          // A fresh pre-message intent is not mail. Move it behind ready entries so a crashed writer never head-of-line blocks durable Desk mail.
          entries.push(reference);
          await atomicYaml(path, { ...segment, entries });
        }
        // Keep authoritative references until Pi accepts them; a fresh intent is retried on the next bounded tick.
        return;
      }
    }
    if (entries.length) return;
    const next = typeof segment.next === "string" ? segment.next : undefined;
    await unlink(path);
    if (next) {
      await atomicYaml(queuePath(root, seat), { ...queue, head: next });
    } else {
      await unlink(queuePath(root, seat));
    }
  });

  const reconcile = () => {
    const scheduled = serial.then(reconcileNow, reconcileNow);
    serial = scheduled.catch(() => undefined);
    return scheduled;
  };
  const start = async () => {
    await reconcile();
    try { watcher = fs.watch(pendingDirectory(root, seat), () => { void reconcile(); }); }
    catch { /* Periodic reconciliation recovers unavailable watchers. */ }
    interval = setInterval(() => { void reconcile(); }, intervalMs);
  };
  const stop = () => {
    watcher?.close();
    watcher = undefined;
    if (interval) clearInterval(interval);
    interval = undefined;
  };
  return { reconcile, start, stop, watermarkFile: pendingDirectory(root, seat) };
}

/** Backward-compatible name for the one internal FlowInboxTransport implementation. */
export const createInboxReconciler = createInboxTransport;

/**
 * Binds a Pi process lifecycle to one non-authoritative, token-fenced runtime
 * observation. Losing the token stops this instance from consuming mail; the
 * single durable inbox transport remains the only delivery path.
 */
export function createPiRuntime({
  root, seat, pid = process.pid, model = process.env.PI_MODEL ?? "pi", cwd = process.cwd(),
  heartbeatMs = defaultHeartbeatMs, staleAfterMs = defaultStaleAfterMs, deliver, createTransport = createInboxTransport,
}: PiRuntimeOptions) {
  const ownerToken = runtimeOwnerToken();
  let transport: FlowInboxTransport | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const owned = () => ownsRuntimeState(root, seat, ownerToken);
  const stop = async () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    transport?.stop();
    transport = undefined;
    await clearRuntimeState(root, seat, ownerToken);
  };
  const reconcile = async () => {
    if (!transport || !await owned()) return;
    await transport.reconcile();
  };
  const start = async () => {
    // This removes only an expired local observation. Registration itself is
    // replacement-safe and does not alter the authoritative Desk seat.
    await clearStaleRuntimeState(root, seat, staleAfterMs);
    await registerRuntimeState(root, { seat, owner_token: ownerToken, pid, model, cwd });
    transport = createTransport({
      root, seat, batchSize: defaultBatchSize, intervalMs: defaultIntervalMs,
      deliver: async (mail, thread, path) => {
        // The application supplies the wake action, but this shared filesystem
        // lock performs the final ownership check immediately around it.
        let ownership: boolean | undefined;
        const accepted = await deliver(mail, thread, path, async (wake) => {
          if (ownership !== undefined) return false;
          const result = await withOwnedRuntimeState(root, seat, ownerToken, wake);
          ownership = result.owned;
          return result.owned;
        });
        // A callback cannot accidentally consume mail by ignoring a rejected
        // authorization result or by attempting more than one wake action.
        return ownership === true && accepted !== false;
      },
    });
    await transport.start();
    heartbeat = setInterval(() => {
      void heartbeatRuntimeState(root, seat, ownerToken).then((state) => {
        if (!state) void stop();
      });
    }, heartbeatMs);
  };
  return { ownerToken, start, stop, reconcile, get transport() { return transport; } };
}

/** Desk mail is authoritative; the queue is a bounded delivery index and fs.watch only shortens latency. */
export default function (pi: ExtensionAPI) {
  const root = process.env.ATDD_WORKFLOW_ROOT;
  const seat = process.env.ATDD_WORKFLOW_SEAT;
  if (!root || !seat) return;
  let runtime: ReturnType<typeof createPiRuntime> | undefined;
  pi.on("session_start", async (_event, ctx) => {
    runtime = createPiRuntime({ root, seat, deliver: async (mail, thread, path, sendIfOwned) => {
      if (!sendIfOwned) return false;
      return sendIfOwned(() => {
        pi.sendMessage({
          customType: "atdd-flow-mail",
          content: mailNotice(typeof thread.id === "string" ? thread.id : "unknown", { ...mail, subject: typeof thread.subject === "string" ? thread.subject : undefined }),
          display: true, details: { thread: thread.id, message: mail.id, path },
        }, { triggerTurn: true, deliverAs: "followUp" });
      });
    } });
    await runtime.start();
    pi.sendMessage({ customType: "atdd-flow-start", content: `SYSTEM: you are ${seat}. Read your durable seat and assigned work with: atdd-flow open ${seat}. Continue assigned in_progress work until it is review-ready or explicitly blocked.`, display: true, details: { seat, root } }, { triggerTurn: true, deliverAs: "followUp" });
    if (ctx.hasUI) ctx.ui.notify(`ATDD Flow native mail active for ${seat}`, "info");
  });
  pi.on("session_shutdown", () => { void runtime?.stop(); });
}
