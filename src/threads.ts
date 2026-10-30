import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { notify } from "./adapters";
import { seatTasks, terminal } from "./tasks";
import { type SupersedeAuthorization, parseSupersedeAuthorization } from "./task-supersede-authorization";
import {
  atomicYaml, canonicalAddress, desk, has, id, now, paths, project, readYaml,
  required, runtimeAddress, seat, words,
} from "./core";

export type Thread = { schema: string; id: string; subject: string; participants: string[]; state: "open" | "closed"; summary?: string; task?: string };
export type Kind = "message" | "receipt" | "result";
export type TransferAuthorization = {
  schema: "atdd-workflow/task-transfer-authorization/v1";
  project: string;
  task: string;
  from: string;
  to: string;
  reason: string;
  exact_head: { branch: string; commit: string };
};
export type Message = {
  schema: string;
  id: string;
  from: string;
  to: "all" | string[];
  kind: Kind;
  in_reply_to?: string;
  expects_result?: boolean;
  created_at: string;
  body: string;
  /** Immutable owner authorization for one exact coordinator-transfer tuple. */
  authorization?: TransferAuthorization | SupersedeAuthorization;
};

async function thread(root: string, threadId: string) {
  return readYaml<Thread>(paths(root).threadFile(threadId));
}

export async function messages(root: string, threadId: string) {
  const folder = paths(root).thread(threadId);
  const files = (await readdir(folder)).filter((file) => file.startsWith("M-") && file.endsWith(".yaml")).sort();
  return Promise.all(files.map((file) => readYaml<Message>(`${folder}/${file}`)));
}

async function replyTarget(root: string, threadId: string, messageId: string, from: string, needsResult: boolean) {
  const record = await thread(root, threadId);
  const target = (await messages(root, threadId)).find((message) => message.id === messageId);
  if (!target) throw new Error(`Message ${messageId} does not exist in thread ${threadId}.`);
  const recipients = target.to === "all" ? record.participants.filter((address) => address !== target.from) : target.to;
  if (!recipients.includes(from)) throw new Error(`${from} was not a recipient of message ${messageId}.`);
  if (needsResult && !target.expects_result) throw new Error(`Message ${messageId} does not expect a result.`);
  return target;
}

async function seatsByRole(root: string, projectName: string, role: string) {
  const folder = paths(root).seats(projectName);
  const locals = await readdir(folder);
  const all = await Promise.all(locals.map((local) => seat(root, `${local}@${projectName}`)));
  return all.filter((entry) => entry.role === role).map((entry) => entry.address);
}

async function resolveRecipients(root: string, value: string, participants: string[]) {
  if (value === "all") return participants;
  const requested = value.split(",").filter(Boolean);
  const expanded = await Promise.all(requested.map(async (address) => {
    const resolved = await canonicalAddress(root, address);
    const marker = resolved.lastIndexOf("@");
    const projectName = resolved.slice(marker + 1);
    const config = await project(root, projectName);
    const group = config.groups?.[resolved];
    if (!group) return [resolved];
    if (group.members) return group.members;
    return seatsByRole(root, projectName, required(group.role, `role for group ${resolved}`));
  }));
  return [...new Set(expanded.flat())];
}

async function assertRoute(root: string, from: string, recipients: string[]) {
  if (from === "operator@desk") return;
  const sender = await seat(root, from);
  const targets = await Promise.all(recipients.map((address) => seat(root, address)));
  if (targets.some((target) => target.address === "operator@desk") && !["main", "coordinator"].includes(sender.role)) {
    throw new Error(`${from} may not directly address operator@desk; route through the responsible coordinator and main seat.`);
  }
  if (sender.role === "driver" && targets.some((target) => target.role !== "coordinator")) {
    // A driver may also reach the actual coordinator of its own non-terminal task in the same project (e.g. main).
    const owners = new Set((await seatTasks(root, sender.project, from))
      .filter(({ task }) => task.assignee === from && !terminal(task))
      .map(({ task }) => task.coordinator));
    const permitted = (target: { address: string; role: string; project: string }) =>
      target.role === "coordinator" || (target.project === sender.project && owners.has(target.address));
    if (targets.every(permitted)) return;
    throw new Error(`${from} may message only a coordinator; coordinators and main seats handle further escalation.`);
  }
}

type PendingReference = { thread: string; message: string; created_at: string; published?: boolean };
type PendingSegment = { schema: "atdd-flow/pi-inbox-segment/v1"; entries: PendingReference[]; next?: string };
type PendingQueue = { schema: "atdd-flow/pi-inbox-queue/v1"; head?: string; tail?: string };

function isPendingQueue(value: unknown): value is Required<PendingQueue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const queue = value as PendingQueue;
  return queue.schema === "atdd-flow/pi-inbox-queue/v1"
    && typeof queue.head === "string" && queue.head.length > 0
    && typeof queue.tail === "string" && queue.tail.length > 0;
}

function missingFile(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function inboxDirectory(root: string, address: string) {
  return join(root, ".atdd-flow", "pi-inbox", encodeURIComponent(address));
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const inboxLockStaleMs = 30_000;
const inboxLockAcquireTimeoutMs = 5_000;
const inboxLockRetryMs = 5;

/** mkdir is atomic across CLI processes; stale locks are recoverable after a crashed writer. */
async function withInboxLock<T>(directory: string, action: () => Promise<T>) {
  await mkdir(directory, { recursive: true });
  const lock = join(directory, "queue.lock");
  const deadline = Date.now() + inboxLockAcquireTimeoutMs;
  while (Date.now() < deadline) {
    try {
      await mkdir(lock, { recursive: false });
      try { return await action(); }
      finally { await rm(lock, { recursive: true, force: true }); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > inboxLockStaleMs) await rm(lock, { recursive: true, force: true });
      } catch { /* A competing release or recovery is retried below. */ }
      const remaining = deadline - Date.now();
      if (remaining > 0) await pause(Math.min(inboxLockRetryMs, remaining));
    }
  }
  throw new Error(`Timed out waiting for inbox queue lock ${directory}`);
}

/** The queue is a bounded linked index: recovery reads only its head segment, never Desk history. */
type YamlWriter = (path: string, value: unknown) => Promise<void>;

export async function enqueueNativeMail(root: string, address: string, reference: PendingReference, writeYaml: YamlWriter = atomicYaml) {
  const directory = inboxDirectory(root, address);
  return withInboxLock(directory, async () => {
    const statePath = join(directory, "queue.yaml");
    let queue: PendingQueue;
    try {
      queue = await readYaml<PendingQueue>(statePath);
      if (!isPendingQueue(queue)) throw new Error(`Malformed pending inbox queue ${statePath}`);
    } catch (error) {
      // A reconciler deletes the index once it drains the final segment. Only
      // that absent-index state may be initialized by normal enqueue; parse,
      // permission, and competing-state failures remain fail-closed.
      if (!missingFile(error)) throw error;
      queue = { schema: "atdd-flow/pi-inbox-queue/v1" };
    }
    const entriesPath = (segment: string) => join(directory, "pending", `${segment}.yaml`);
    const compare = (left: PendingReference, right: PendingReference) => left.created_at.localeCompare(right.created_at) || left.message.localeCompare(right.message);
    const capacity = 32;
    if (!queue.head) {
      const segment = `S-${reference.message}`;
      await writeYaml(entriesPath(segment), { schema: "atdd-flow/pi-inbox-segment/v1", entries: [reference] } satisfies PendingSegment);
      queue.head = segment;
      queue.tail = segment;
      await writeYaml(statePath, queue);
      return segment;
    }
    // Insert under the same process-safe lock. A full segment spills its latest reference forward, preserving global created_at/message order across rollover.
    let pending = reference;
    let current = queue.head;
    let referenceSegment: string | undefined;
    while (current) {
      const record = await readYaml<PendingSegment>(entriesPath(current));
      record.entries.push(pending);
      record.entries.sort(compare);
      if (record.entries.some((entry) => entry.message === reference.message)) referenceSegment = current;
      if (record.entries.length <= capacity) {
        await writeYaml(entriesPath(current), record);
        return referenceSegment ?? current;
      }
      pending = record.entries.pop()!;
      if (pending.message === reference.message) referenceSegment = undefined;
      if (record.next) {
        await writeYaml(entriesPath(current), record);
        current = record.next;
        continue;
      }
      const next = `S-${pending.message}`;
      // A child must be durable before its parent publishes the link. A crash or
      // failed write can leave an unlinked orphan, but never a reachable hole.
      await writeYaml(entriesPath(next), { schema: "atdd-flow/pi-inbox-segment/v1", entries: [pending] } satisfies PendingSegment);
      record.next = next;
      await writeYaml(entriesPath(current), record);
      queue.tail = next;
      await writeYaml(statePath, queue);
      return referenceSegment ?? next;
    }
    throw new Error("Pending inbox queue has no reachable tail");
  });
}

export async function publishNativeMail(root: string, address: string, _segment: string, message: string) {
  const directory = inboxDirectory(root, address);
  await withInboxLock(directory, async () => {
    const statePath = join(directory, "queue.yaml");
    let queue: PendingQueue;
    try { queue = await readYaml<PendingQueue>(statePath); }
    catch (error) {
      // A native reconciler may consume the newly authoritative message and
      // drain the queue between prepare and this advisory publish marker.
      // Its deletion is a successful exactly-once delivery, not an error.
      if (missingFile(error)) return;
      throw error;
    }
    if (!isPendingQueue(queue)) throw new Error(`Malformed pending inbox queue ${statePath}`);
    let segment = queue.head;
    while (segment) {
      const path = join(directory, "pending", `${segment}.yaml`);
      const record = await readYaml<PendingSegment>(path);
      const entry = record.entries.find((candidate) => candidate.message === message);
      if (entry) {
        entry.published = true;
        await atomicYaml(path, record);
        return;
      }
      segment = record.next;
    }
    // A reconciler can consume an authoritative M-file reference between message persistence and this advisory marker; that is already a successful, exactly-once delivery.
  });
}

/** The single predicate for a durable native inbox queue: an explicit native wake or a Pi-designated seat. */
export const hasNativeQueue = (target: { agent?: string; runtime?: { wake?: string } }) =>
  target.runtime?.wake === "native" || target.agent === "pi";

async function prepareNativeMail(root: string, address: string, message: Message, threadId: string) {
  const target = await seat(root, address);
  if (!hasNativeQueue(target)) return;
  const segment = await enqueueNativeMail(root, address, { thread: threadId, message: message.id, created_at: message.created_at });
  return { address, segment };
}

async function inject(root: string, address: string, message: Message, threadId: string, queued = false) {
  const target = await seat(root, address);
  const runtime = target.runtime;
  if (hasNativeQueue(target)) {
    if (!queued) await enqueueNativeMail(root, address, { thread: threadId, message: message.id, created_at: message.created_at, published: true });
    if (!runtime || runtime.wake === "native") return;
  }
  if (!runtime) return;
  const storedAddress = runtime.addresses[runtime.application];
  if (!storedAddress) return;
  const config = await desk(root);
  const locator = runtimeAddress(runtime.application, storedAddress, config.herdr_session);
  const record = await thread(root, threadId);
  const recipients = message.to === "all" ? "all" : message.to.join(", ");
  const subject = record.subject.replace(/\s+/g, " ").trim();
  const notice = `SYSTEM: Flow mail ${message.id} | thread ${threadId} (${subject}) | ${message.from} → ${recipients}. Read: atdd-flow message read ${message.id}`;
  try { await notify(runtime.application, locator.address, notice, locator.session); }
  catch (error) { console.warn(`Notification for ${address} was not delivered: ${(error as Error).message}`); }
}

function transferAuthorization(args: string[], from: string) {
  const encoded = words(args, "--task-transfer-authorization");
  if (!encoded) return undefined;
  if (from !== "operator@desk") throw new Error("Only operator@desk may create a task transfer authorization.");
  let authorization: unknown;
  try { authorization = JSON.parse(encoded); }
  catch { throw new Error("--task-transfer-authorization must be valid JSON."); }
  const value = authorization as Partial<TransferAuthorization>;
  if (!value || value.schema !== "atdd-workflow/task-transfer-authorization/v1"
    || ![value.project, value.task, value.from, value.to, value.reason, value.exact_head?.branch, value.exact_head?.commit].every((entry) => typeof entry === "string" && entry.length)) {
    throw new Error("--task-transfer-authorization must contain one exact task-transfer-authorization/v1 tuple.");
  }
  return value as TransferAuthorization;
}

async function post(root: string, threadId: string, args: string[], overrides: Partial<Message> = {}) {
  const record = await thread(root, threadId);
  const from = await canonicalAddress(root, required(overrides.from ?? words(args, "--from"), "--from"));
  if (!record.participants.includes(from)) throw new Error(`${from} is not a thread participant.`);
  const toValue = overrides.to ?? words(args, "--to") ?? "all";
  const recipients = Array.isArray(toValue) ? toValue : await resolveRecipients(root, toValue, record.participants);
  if (recipients.some((address) => !record.participants.includes(address))) throw new Error("Recipients must be thread participants.");
  await assertRoute(root, from, recipients.filter((address) => address !== from));
  const kind = overrides.kind ?? "message";
  const authorization = overrides.authorization ?? transferAuthorization(args, from) ?? parseSupersedeAuthorization(words(args, "--task-supersede-authorization"), from);
  // Labels are an explicit, non-sensitive operator hint; message bodies never enter durable IDs.
  const label = words(args, "--label") ?? kind;
  const message: Message = {
    schema: "atdd-workflow/message/v1", id: id("M", label), from, to: toValue === "all" ? "all" : recipients,
    kind,
    ...(authorization ? { authorization } : {}),
    ...(overrides.in_reply_to ? { in_reply_to: overrides.in_reply_to } : {}),
    ...(overrides.expects_result || has(args, "--expects-result") ? { expects_result: true } : {}),
    created_at: now(), body: required(overrides.body ?? words(args, "--body"), "--body"),
  };
  const prepared = await Promise.all(recipients.filter((address) => address !== from).map((recipient) => prepareNativeMail(root, recipient, message, threadId)));
  // The durable queue is published before the authoritative message: a crash can leave only a harmless uncommitted reference, never durable mail without recovery.
  await atomicYaml(paths(root).message(threadId, message.id), message);
  await Promise.all(prepared.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).map((entry) => publishNativeMail(root, entry.address, entry.segment, message.id)));
  await Promise.all(recipients.filter((address) => address !== from).map((recipient) => inject(root, recipient, message, threadId, prepared.some((entry) => entry?.address === recipient))));
  console.log(message.id);
  return message.id;
}

export async function startThread(root: string, args: string[]) {
  const participants = await resolveRecipients(root, required(words(args, "--with"), "--with"), []);
  if (participants.length < 2) throw new Error("A thread needs at least two participants.");
  const subject = required(words(args, "--subject"), "--subject");
  const record: Thread = {
    schema: "atdd-workflow/thread/v1", id: id("T", subject), participants,
    subject, state: "open",
    ...(words(args, "--task") ? { task: words(args, "--task") } : {}),
  };
  await atomicYaml(paths(root).threadFile(record.id), record);
  console.log(record.id);
  return record.id;
}

export async function addParticipant(root: string, threadId: string, address: string) {
  const record = await thread(root, threadId);
  const resolved = await canonicalAddress(root, address);
  if (!record.participants.includes(resolved)) record.participants.push(resolved);
  await atomicYaml(paths(root).threadFile(threadId), record);
}

export async function openThread(root: string, threadId: string) {
  const record = await thread(root, threadId);
  const all = await messages(root, threadId);
  console.log(Bun.YAML.stringify({ ...record, messages: all }));
}

/** Reads one durable message without loading or printing its whole thread. */
export async function readMessage(root: string, messageId: string) {
  if (!/^M-[A-Za-z0-9_-]+$/.test(messageId)) throw new Error(`Invalid message id: ${messageId}.`);
  const folders = await readdir(paths(root).threads, { withFileTypes: true });
  const matches = await Promise.all(folders
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("T-"))
    .map(async (entry) => {
      const file = paths(root).message(entry.name, messageId);
      try { return { thread: await thread(root, entry.name), message: await readYaml<Message>(file) }; }
      catch { return undefined; }
    }));
  const found = matches.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (!found.length) throw new Error(`Message ${messageId} does not exist in this Desk.`);
  if (found.length > 1) throw new Error(`Message ${messageId} is ambiguous across threads: ${found.map((entry) => entry.thread.id).join(", ")}.`);
  const entry = found[0];
  console.log(Bun.YAML.stringify({
    schema: "atdd-workflow/message-read/v1",
    thread: { id: entry.thread.id, subject: entry.thread.subject },
    message: entry.message,
  }));
}

export async function receipt(root: string, threadId: string, messageId: string, args: string[]) {
  const from = await canonicalAddress(root, required(words(args, "--from"), "--from"));
  const target = await replyTarget(root, threadId, messageId, from, false);
  return post(root, threadId, args, { from, to: [target.from], kind: "receipt", in_reply_to: messageId, body: words(args, "--body") ?? `Received ${messageId}.` });
}

export async function result(root: string, threadId: string, messageId: string, args: string[]) {
  const from = await canonicalAddress(root, required(words(args, "--from"), "--from"));
  const target = await replyTarget(root, threadId, messageId, from, true);
  return post(root, threadId, args, { from, to: [target.from], kind: "result", in_reply_to: messageId, body: required(words(args, "--body"), "--body") });
}

/** Recipients that have not yet answered an expects_result message with a result. */
export function pendingResponders(participants: string[], all: Message[], message: Message) {
  const responders = message.to === "all" ? participants.filter((address) => address !== message.from) : message.to;
  return responders.filter((address) => !all.some((reply) => reply.kind === "result" && reply.in_reply_to === message.id && reply.from === address));
}

export async function status(root: string) {
  const threadIds = (await readdir(paths(root).threads)).sort();
  for (const threadId of threadIds) {
    const record = await thread(root, threadId);
    const all = await messages(root, threadId);
    const pending = all.flatMap((message) => message.expects_result
      ? pendingResponders(record.participants, all, message).map((address) => `${message.id}@${address}`) : []);
    console.log(`${threadId}  ${record.state}  ${record.subject}${pending.length ? `  waiting:${pending.join(",")}` : ""}`);
  }
}

export async function threadsForSeat(root: string, address: string) {
  const resolved = await canonicalAddress(root, address);
  const threadIds = await readdir(paths(root).threads);
  const records = await Promise.all(threadIds.map(async (threadId) => ({ threadId, record: await thread(root, threadId) })));
  return records.filter(({ record }) => record.participants.includes(resolved));
}

export { post };
