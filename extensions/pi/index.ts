import * as fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Thread = { participants?: unknown };
type Mail = { id?: unknown; from?: unknown; to?: unknown };

const finalMail = /^M-[^.]+\.yaml$/;

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

/**
 * A Pi-native wake adapter. The Desk remains authoritative: this extension
 * only observes final immutable mail files and tells Pi where to read them.
 */
export default function (pi: ExtensionAPI) {
  const root = process.env.ATDD_WORKFLOW_ROOT;
  const seat = process.env.ATDD_WORKFLOW_SEAT;
  if (!root || !seat) return;

  const threads = join(root, "threads");
  const delivered = new Set<string>();
  const pending = new Set<string>();
  const threadWatchers = new Map<string, fs.FSWatcher>();
  let threadsWatcher: fs.FSWatcher | undefined;

  const deliver = (threadId: string, fileName: string) => {
    const key = `${threadId}/${fileName}`;
    if (delivered.has(key) || pending.has(key)) return;
    pending.add(key);
    setTimeout(async () => {
      try {
        const folder = join(threads, threadId);
        const [rawThread, rawMail] = await Promise.all([
          readFile(join(folder, "thread.yaml"), "utf8"),
          readFile(join(folder, fileName), "utf8"),
        ]);
        const thread = parse(rawThread) as Thread;
        const mail = parse(rawMail) as Mail;
        if (!addressedTo(mail, thread, seat)) return;
        const id = typeof mail.id === "string" ? mail.id : fileName.slice(0, -5);
        const file = join(folder, fileName);
        delivered.add(key);
        pi.sendMessage({
          customType: "atdd-flow-mail",
          content: `SYSTEM: new Flow mail ${id}. Read ${file}`,
          display: true,
          details: { thread: threadId, message: id, path: file },
        }, { triggerTurn: true, deliverAs: "followUp" });
      } catch {
        // A later filesystem event can retry an atomic-write race.
      } finally {
        pending.delete(key);
      }
    }, 25);
  };

  const watchThread = (threadId: string) => {
    if (threadWatchers.has(threadId)) return;
    try {
      const watcher = fs.watch(join(threads, threadId), (_event, file) => {
        const name = file?.toString();
        if (name && finalMail.test(name)) deliver(threadId, name);
      });
      threadWatchers.set(threadId, watcher);
    } catch {
      // A concurrent thread deletion is harmless.
    }
  };

  const discoverThreads = async () => {
    try {
      for (const entry of await readdir(threads, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("T-")) watchThread(entry.name);
      }
    } catch {
      // The Desk may be created after Pi starts.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await discoverThreads();
    try { threadsWatcher = fs.watch(threads, () => { void discoverThreads(); }); }
    catch { /* The startup prompt still makes the missing Desk visible. */ }
    pi.sendMessage({
      customType: "atdd-flow-start",
      content: `SYSTEM: you are ${seat}. Read your durable seat and assigned work with: atdd-flow open ${seat}. Continue assigned in_progress work until it is review-ready or explicitly blocked.`,
      display: true,
      details: { seat, root },
    }, { triggerTurn: true, deliverAs: "followUp" });
    if (ctx.hasUI) ctx.ui.notify(`ATDD Flow native mail active for ${seat}`, "info");
  });

  pi.on("session_shutdown", () => {
    threadsWatcher?.close();
    for (const watcher of threadWatchers.values()) watcher.close();
    threadWatchers.clear();
  });
}
