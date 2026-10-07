import * as fs from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Thread = { id?: unknown; participants?: unknown; subject?: unknown };
export type Mail = { id?: unknown; from?: unknown; to?: unknown; subject?: unknown; created_at?: unknown };
type InboxMail = Mail & { id: string; created_at: string };
type Watermark = { schema: "atdd-flow/pi-inbox-watermark/v1"; seat: string; watermark?: { created_at: string; id: string } };

type InboxOptions = {
  root: string;
  seat: string;
  deliver: (mail: InboxMail, thread: Thread, path: string) => void | Promise<void>;
  batchSize?: number;
  intervalMs?: number;
};

const finalMail = /^M-[^.]+\.yaml$/;
const defaultBatchSize = 32;
const defaultIntervalMs = 30_000;

function participants(thread: Thread) {
  return Array.isArray(thread.participants) && thread.participants.every((entry) => typeof entry === "string")
    ? thread.participants as string[]
    : [];
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

function watermarkPath(root: string, seat: string) {
  return join(root, ".atdd-flow", "pi-inbox", `${encodeURIComponent(seat)}.yaml`);
}

function validMail(value: Mail): value is InboxMail {
  return typeof value.id === "string" && typeof value.created_at === "string";
}

function compareMail(left: Pick<InboxMail, "created_at" | "id">, right: Pick<InboxMail, "created_at" | "id">) {
  return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
}

async function readWatermark(root: string, seat: string) {
  try {
    const value = parse(await readFile(watermarkPath(root, seat), "utf8")) as Watermark;
    if (value?.schema !== "atdd-flow/pi-inbox-watermark/v1" || value.seat !== seat) return undefined;
    if (value.watermark && (typeof value.watermark.id !== "string" || typeof value.watermark.created_at !== "string")) return undefined;
    return value.watermark;
  } catch {
    return undefined;
  }
}

async function persistWatermark(root: string, seat: string, watermark: Watermark["watermark"]) {
  const file = watermarkPath(root, seat);
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${encodeURIComponent(seat)}.${randomUUID()}.tmp`);
  await writeFile(temporary, stringify({ schema: "atdd-flow/pi-inbox-watermark/v1", seat, ...(watermark ? { watermark } : {}) }), "utf8");
  await rename(temporary, file);
}

async function pendingMail(root: string, seat: string, watermark: Watermark["watermark"]) {
  const threads = join(root, "threads");
  let folders: fs.Dirent[];
  try { folders = await readdir(threads, { withFileTypes: true }); }
  catch { return []; }
  const entries = await Promise.all(folders.filter((entry) => entry.isDirectory() && entry.name.startsWith("T-")).map(async (folder) => {
    try {
      const directory = join(threads, folder.name);
      const thread = parse(await readFile(join(directory, "thread.yaml"), "utf8")) as Thread;
      const files = await readdir(directory);
      const mail = await Promise.all(files.filter((file) => finalMail.test(file)).map(async (file) => {
        const value = parse(await readFile(join(directory, file), "utf8")) as Mail;
        return validMail(value) && addressedTo(value, thread, seat) ? { mail: value, thread, path: join(directory, file) } : undefined;
      }));
      return mail.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    } catch {
      // A concurrently-created thread or atomic write is retried by the next reconciliation.
      return [];
    }
  }));
  return entries.flat().filter((entry) => !watermark || compareMail(entry.mail, watermark) > 0)
    .sort((left, right) => compareMail(left.mail, right.mail));
}

/**
 * Reconciles immutable Desk mail after a persisted per-seat watermark.
 * Delivery is serialized so fs.watch, startup, and periodic scans cannot reorder it.
 */
export function createInboxReconciler({ root, seat, deliver, batchSize = defaultBatchSize, intervalMs = defaultIntervalMs }: InboxOptions) {
  let watermark: Watermark["watermark"] | undefined;
  let loaded = false;
  let rootWatcher: fs.FSWatcher | undefined;
  const threadWatchers = new Map<string, fs.FSWatcher>();
  let interval: ReturnType<typeof setInterval> | undefined;
  const delivered = new Set<string>();
  let serial = Promise.resolve();

  const reconcileNow = async () => {
    if (!loaded) {
      watermark = await readWatermark(root, seat);
      loaded = true;
    }
    const entries = await pendingMail(root, seat, watermark);
    for (const entry of entries.slice(0, batchSize)) {
      const key = `${entry.thread.id ?? entry.path}/${entry.mail.id}`;
      if (delivered.has(key)) continue;
      try {
        await deliver(entry.mail, entry.thread, entry.path);
      } catch {
        // Do not advance past a message Pi did not accept; retry it before later mail.
        return;
      }
      delivered.add(key);
      watermark = { created_at: entry.mail.created_at, id: entry.mail.id };
      await persistWatermark(root, seat, watermark);
    }
  };

  const reconcile = () => {
    const scheduled = serial.then(reconcileNow, reconcileNow);
    serial = scheduled.catch(() => undefined);
    return scheduled;
  };

  const threads = join(root, "threads");
  const watchThread = (threadId: string) => {
    if (threadWatchers.has(threadId)) return;
    try {
      const watcher = fs.watch(join(threads, threadId), (_event, file) => {
        if (!file || finalMail.test(file.toString())) void reconcile();
      });
      threadWatchers.set(threadId, watcher);
    } catch {
      // A periodic scan will recover a concurrently-created thread.
    }
  };
  const discoverThreads = async () => {
    try {
      for (const entry of await readdir(threads, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("T-")) watchThread(entry.name);
      }
    } catch {
      // The Desk may appear after Pi starts; periodic reconciliation remains active.
    }
  };

  const start = async () => {
    await reconcile();
    await discoverThreads();
    try { rootWatcher = fs.watch(threads, () => { void discoverThreads(); }); }
    catch { /* Periodic scans still recover mail when the root watcher cannot start yet. */ }
    interval = setInterval(() => { void reconcile(); }, intervalMs);
  };

  const stop = () => {
    rootWatcher?.close();
    rootWatcher = undefined;
    for (const watcher of threadWatchers.values()) watcher.close();
    threadWatchers.clear();
    if (interval) clearInterval(interval);
    interval = undefined;
  };

  return { reconcile, start, stop, watermarkFile: watermarkPath(root, seat) };
}

/**
 * A Pi-native wake adapter. Desk mail is authoritative; fs.watch only shortens delivery latency.
 */
export default function (pi: ExtensionAPI) {
  const root = process.env.ATDD_WORKFLOW_ROOT;
  const seat = process.env.ATDD_WORKFLOW_SEAT;
  if (!root || !seat) return;

  let inbox: ReturnType<typeof createInboxReconciler> | undefined;
  pi.on("session_start", async (_event, ctx) => {
    inbox = createInboxReconciler({
      root,
      seat,
      deliver: async (mail, thread, path) => {
        pi.sendMessage({
          customType: "atdd-flow-mail",
          content: mailNotice(typeof thread.id === "string" ? thread.id : "unknown", { ...mail, subject: typeof thread.subject === "string" ? thread.subject : undefined }),
          display: true,
          details: { thread: thread.id, message: mail.id, path },
        }, { triggerTurn: true, deliverAs: "followUp" });
      },
    });
    await inbox.start();
    pi.sendMessage({
      customType: "atdd-flow-start",
      content: `SYSTEM: you are ${seat}. Read your durable seat and assigned work with: atdd-flow open ${seat}. Continue assigned in_progress work until it is review-ready or explicitly blocked.`,
      display: true,
      details: { seat, root },
    }, { triggerTurn: true, deliverAs: "followUp" });
    if (ctx.hasUI) ctx.ui.notify(`ATDD Flow native mail active for ${seat}`, "info");
  });

  pi.on("session_shutdown", () => { inbox?.stop(); });
}
