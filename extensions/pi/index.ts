import * as fs from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Thread = { id?: unknown; participants?: unknown; subject?: unknown };
export type Mail = { id?: unknown; from?: unknown; to?: unknown; subject?: unknown; created_at?: unknown };
type InboxMail = Mail & { id: string; created_at: string };
type PendingReference = { schema?: unknown; thread?: unknown; message?: unknown; created_at?: unknown };
type PendingSegment = { schema?: unknown; entries?: unknown; next?: unknown };
type PendingQueue = { schema?: unknown; head?: unknown; tail?: unknown };
type InboxOptions = { root: string; seat: string; deliver: (mail: InboxMail, thread: Thread, path: string) => void | Promise<void>; batchSize?: number; intervalMs?: number };

const defaultBatchSize = 32;
const defaultIntervalMs = 30_000;

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
export function createInboxReconciler({ root, seat, deliver, batchSize = defaultBatchSize, intervalMs = defaultIntervalMs }: InboxOptions) {
  let watcher: fs.FSWatcher | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const delivered = new Set<string>();
  let serial = Promise.resolve();

  const reconcileNow = async () => {
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
        if (validMail(mail) && addressedTo(mail, thread, seat) && !delivered.has(key)) await deliver(mail, thread, join(folder, `${reference.message}.yaml`));
        delivered.add(key);
        entries.shift();
        await atomicYaml(path, { ...segment, entries });
      } catch {
        // Keep the head reference until Pi accepts it; later mail cannot overtake it.
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
  };

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

/** Desk mail is authoritative; the queue is a bounded delivery index and fs.watch only shortens latency. */
export default function (pi: ExtensionAPI) {
  const root = process.env.ATDD_WORKFLOW_ROOT;
  const seat = process.env.ATDD_WORKFLOW_SEAT;
  if (!root || !seat) return;
  let inbox: ReturnType<typeof createInboxReconciler> | undefined;
  pi.on("session_start", async (_event, ctx) => {
    inbox = createInboxReconciler({ root, seat, deliver: async (mail, thread, path) => {
      pi.sendMessage({
        customType: "atdd-flow-mail",
        content: mailNotice(typeof thread.id === "string" ? thread.id : "unknown", { ...mail, subject: typeof thread.subject === "string" ? thread.subject : undefined }),
        display: true, details: { thread: thread.id, message: mail.id, path },
      }, { triggerTurn: true, deliverAs: "followUp" });
    } });
    await inbox.start();
    pi.sendMessage({ customType: "atdd-flow-start", content: `SYSTEM: you are ${seat}. Read your durable seat and assigned work with: atdd-flow open ${seat}. Continue assigned in_progress work until it is review-ready or explicitly blocked.`, display: true, details: { seat, root } }, { triggerTurn: true, deliverAs: "followUp" });
    if (ctx.hasUI) ctx.ui.notify(`ATDD Flow native mail active for ${seat}`, "info");
  });
  pi.on("session_shutdown", () => { inbox?.stop(); });
}
