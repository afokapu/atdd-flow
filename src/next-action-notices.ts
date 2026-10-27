// URN: component:flow:e007:next-action-notices:backend:application
// Tested-By:
// - test:flow:next-action-notice-correctness
// Runtime: bun
// Purpose: Keep Pi next-action and mail notices current and non-repeating.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { type TaskDirective, directiveNotice, nextDirective } from "./tasks";

/** Per-session notice memory. Nothing here is durable; task and thread records stay authoritative. */
export type NoticeState = {
  /** A next-action follow-up has been queued and not yet delivered. */
  pending: boolean;
  lastDelivered?: string;
  /** One automatic post-settlement continuation per unchanged directive. */
  settledNudged?: string;
  /** Blocker notices already delivered this session, keyed by task and blocker text. */
  blockers: Set<string>;
  /** Mail ids already notified this session. */
  mail: Set<string>;
};

export type NoticeHost = {
  sendMessage: (message: { customType: string; content: string; display: boolean; details: Record<string, unknown> }, options: { triggerTurn: boolean; deliverAs: "followUp" }) => void;
};

/** A delivered message as Pi hands it to `message_end`; only the fields used here. */
export type NoticeMessage = { role?: string; customType?: string; content?: unknown; details?: Record<string, unknown> };

export const createNoticeState = (): NoticeState => ({ pending: false, blockers: new Set(), mail: new Set() });

const directiveKey = (directive: TaskDirective) =>
  [directive.project, directive.task, directive.lifecycle, directive.role, directive.action, directive.command ?? ""].join("|");

const directiveDetails = (directive: TaskDirective) =>
  ({ project: directive.project, task: directive.task, lifecycle: directive.lifecycle, role: directive.role, authority: "task" });

/** Queues the current task-derived action unless one is pending or the last delivered one is unchanged. */
export async function sendTaskDirective(host: NoticeHost, root: string, seat: string, state: NoticeState) {
  if (state.pending) return;
  try {
    const directive = await nextDirective(root, seat);
    if (!directive || state.pending) return;
    const key = directiveKey(directive);
    if (key === state.lastDelivered || state.blockers.has(key)) return;
    state.pending = true;
    host.sendMessage({ customType: "atdd-flow-next-action", content: directiveNotice(seat, directive), display: true, details: directiveDetails(directive) }, { triggerTurn: true, deliverAs: "followUp" });
  } catch {
    state.pending = false; // The durable task remains authoritative and is re-derived at the next startup or wake.
  }
}

/** A settled model turn is not task completion. Give one additional nudge for a
 * still-actionable directive, but never loop on unchanged task state. */
export async function sendSettledDirective(host: NoticeHost, root: string, seat: string, state: NoticeState) {
  if (state.pending) return;
  try {
    const directive = await nextDirective(root, seat);
    if (!directive?.command) return; // Waiting for an authority or dependency is not work for this seat.
    const key = directiveKey(directive);
    if (key !== state.lastDelivered) return sendTaskDirective(host, root, seat, state);
    if (state.settledNudged === key) return;
    state.settledNudged = key;
    state.pending = true;
    host.sendMessage({
      customType: "atdd-flow-next-action",
      content: directiveNotice(seat, directive),
      display: true,
      details: { ...directiveDetails(directive), continuation: true },
    }, { triggerTurn: true, deliverAs: "followUp" });
  } catch { state.pending = false; }
}

/** Re-derives a held next-action follow-up when Pi delivers it; a queued message cannot be dropped, so it is replaced by the shortest truthful text. */
async function currentDirective(root: string, seat: string, state: NoticeState, message: NoticeMessage): Promise<NoticeMessage> {
  state.pending = false;
  const directive = await nextDirective(root, seat).catch(() => undefined);
  if (!directive) {
    state.lastDelivered = undefined;
    return { ...message, content: `SYSTEM: next-action notice for ${seat} withdrawn: task state has no actionable step. Task state outranks mail.`, details: { authority: "task", lifecycle: "NONE" } };
  }
  const key = directiveKey(directive);
  if (key === state.lastDelivered) {
    if (message.details?.continuation === true && directive.command) {
      return { ...message, content: `${directiveNotice(seat, directive)} The task remains open. Continue or escalate a real blocker; do not stop merely because this turn ended.`,
        details: { ...directiveDetails(directive), continuation: true } };
    }
    return { ...message, content: `SYSTEM: next action for ${seat} unchanged on ${directive.project}/${directive.task} [${directive.lifecycle}]; see the previous notice.`, details: directiveDetails(directive) };
  }
  state.lastDelivered = key;
  if (directive.lifecycle === "BLOCKED") state.blockers.add(key);
  return { ...message, content: directiveNotice(seat, directive), details: directiveDetails(directive) };
}

const isMailFile = (file: string, mailId: string) => file.startsWith("M-") && file.endsWith(".yaml") && file !== `${mailId}.yaml`;

const cites = (record: Record<string, unknown> | undefined, seat: string, mailId: string) =>
  record?.from === seat && (record.in_reply_to === mailId || String(record.body ?? "").includes(mailId));

const readRecord = (path: string) => readFile(path, "utf8").then((raw) => parse(raw) as Record<string, unknown>).catch(() => undefined);

/** True when this seat already replied to, or cited, the mail in the same thread. */
export async function answeredBy(root: string, seat: string, threadId: string, mailId: string) {
  const folder = join(root, "threads", threadId);
  for (const file of (await readdir(folder).catch(() => [] as string[])).filter((entry) => isMailFile(entry, mailId))) {
    if (cites(await readRecord(join(folder, file)), seat, mailId)) return true;
  }
  return false;
}

/** At most one notice per mail id per session, and none for mail this seat already answered. */
export async function shouldNotifyMail(root: string, seat: string, state: NoticeState, threadId: string, mailId: string) {
  if (state.mail.has(mailId)) return false;
  state.mail.add(mailId);
  return !await answeredBy(root, seat, threadId, mailId).catch(() => false);
}

/** `message_end` hook: keeps held notices truthful at the moment they reach the model. */
export async function refreshDelivered(root: string, seat: string, state: NoticeState, message: NoticeMessage): Promise<NoticeMessage | undefined> {
  if (message.role !== "custom") return undefined;
  if (message.customType === "atdd-flow-next-action") return currentDirective(root, seat, state, message);
  if (message.customType !== "atdd-flow-mail") return undefined;
  const { thread, message: mailId } = message.details ?? {};
  if (typeof thread !== "string" || typeof mailId !== "string") return undefined;
  if (!await answeredBy(root, seat, thread, mailId).catch(() => false)) return undefined;
  return { ...message, content: `SYSTEM: Flow mail ${mailId} on thread ${thread} was already answered by ${seat}; no action.` };
}
