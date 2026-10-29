import * as fs from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearStaleRuntimeState, clearRuntimeState, heartbeatRuntimeState, ownsRuntimeState, recordMailActivation, registerRuntimeState, runtimeOwnerToken, withOwnedRuntimeState } from "../../src/runtime-state";
import { modelPortfolio, paths, piModel, readYaml, type Seat } from "../../src/core";
import { type TranscriptEntry, customEntries, wakeCapabilityType, wakeRequestIdPattern, wakeRequestType, wakeResultType, wakeStartType } from "../../src/pi-wake-protocol";
import { activationNotice, diagnoseMailActivation, expectsNativeMail } from "../../src/mail-activation-notice";
import { type NoticeState, createNoticeState, deliveredDirectiveText, refreshDelivered, sendSettledDirective, sendTaskDirective, shouldNotifyMail } from "../../src/next-action-notices";
import { handoverThresholdInstruction, runtimeStartupInstruction, successorInstruction } from "../../src/collaboration-policy";
import { type RecoveryMode, recoveryFor } from "../../src/recovery-bundle";
import { contextHandoverThreshold, readHandoverReplacement } from "../../src/handover";

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
  /** Live Pi session id recorded on the advisory runtime state for status seat. */
  piSession?: string;
  createTransport?: (options: InboxOptions) => FlowInboxTransport;
  /** Flow-launched Pi instances register and heartbeat before their verified launch activates inbox delivery. */
  deferActivation?: boolean;
};

export type LaunchActivationOptions = {
  root: string;
  seat: string;
  piSession: string;
  herdrSession: string;
  pane: string;
  activate: () => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
};

const defaultBatchSize = 32;
const defaultIntervalMs = 30_000;
const defaultHeartbeatMs = 15_000;
const defaultStaleAfterMs = 60_000;
const defaultActivationIntervalMs = 25;
const defaultActivationTimeoutMs = 60_000;

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
    try {
      // Watch a path that exists before the first queued mail, so a newly created queue wakes promptly.
      await mkdir(pendingDirectory(root, seat), { recursive: true });
      watcher = fs.watch(pendingDirectory(root, seat), () => { void reconcile(); });
    }
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
  heartbeatMs = defaultHeartbeatMs, staleAfterMs = defaultStaleAfterMs, deliver, piSession, createTransport = createInboxTransport, deferActivation = false,
}: PiRuntimeOptions) {
  const ownerToken = runtimeOwnerToken();
  let transport: FlowInboxTransport | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let activated = false;

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
  const activate = async () => {
    if (!await owned()) return false;
    if (activated) return true;
    const candidate = createTransport({
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
    // The transport counts as started only after start() succeeds; a failed start is stopped and leaves no transport behind.
    try { await candidate.start(); } catch (error) { candidate.stop(); throw error; }
    transport = candidate;
    activated = true;
    return true;
  };
  const start = async () => {
    // This removes only an expired local observation. Registration itself is
    // replacement-safe and does not alter the authoritative Desk seat.
    await clearStaleRuntimeState(root, seat, staleAfterMs);
    await registerRuntimeState(root, { seat, owner_token: ownerToken, pid, model, cwd, ...(piSession ? { pi_session: piSession } : {}) });
    heartbeat = setInterval(() => {
      void heartbeatRuntimeState(root, seat, ownerToken).then((state) => {
        if (!state) void stop();
      });
    }, heartbeatMs);
    if (!deferActivation) await activate();
  };
  return { ownerToken, start, activate, stop, reconcile, get transport() { return transport; }, get active() { return activated; } };
}

type LaunchReceipt = { seat?: string; pi_session?: string; pi_session_path?: string; herdr_session?: string; pane?: string };

/** The bounded window ended without a verified receipt and matching binding. */
export class ActivationTimeout extends Error {
  constructor() { super("Timed out waiting for verified Flow launch receipt and binding."); }
}

/** Wait only for the launcher's already-verified receipt and exact Desk binding; this never creates either record. */
export async function awaitLaunchActivation({ root, seat, piSession, herdrSession, pane, activate, intervalMs = defaultActivationIntervalMs, timeoutMs = defaultActivationTimeoutMs }: LaunchActivationOptions) {
  const deadline = Date.now() + timeoutMs;
  let matched = false;
  while (!matched && Date.now() <= deadline) {
    try {
      const record = await readYaml<Seat>(paths(root).seatFile(seat));
      const runtime = record.runtime;
      const locator = runtime?.addresses.herdr;
      if (runtime?.application === "herdr" && typeof locator !== "string" && locator?.session === herdrSession && locator.pane === pane
        && runtime.pi_session === piSession && runtime.pi_session_path && runtime.launch_receipt) {
        const receipt = await readYaml<LaunchReceipt>(runtime.launch_receipt);
        matched = receipt.seat === seat && receipt.pi_session === piSession && receipt.pi_session_path === runtime.pi_session_path
          && receipt.herdr_session === herdrSession && receipt.pane === pane;
      }
    } catch { /* Binding and receipt are written after Herdr verification; wait within this finite window. */ }
    if (!matched) await pause(intervalMs);
  }
  // The callback runs at most once, outside the polling try: a failing startup step is reported, never retried every poll.
  if (matched) return activate();
  throw new ActivationTimeout();
}

/** A transient start failure (for example a busy inbox lock under concurrent reloads) is retried a bounded number of times before it is reported. */
export async function activateWithRetry(activate: () => Promise<boolean>, attempts = 3, delayMs = 1_000) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await activate(); }
    catch (error) {
      if (attempt >= attempts) throw error;
      await pause(delayMs);
    }
  }
}

/**
 * Host-attached Pi has no launcher variables; it may activate only when Herdr's injected pane identity exactly
 * matches the Desk seat's native scoped binding. This reads the seat and never writes or creates a binding.
 */
export async function hostAttachedActivation({ root, seat, herdrSession, pane, piSession, piSessionPath }: { root: string; seat: string; herdrSession?: string; pane?: string; piSession?: string; piSessionPath?: string }) {
  if (!herdrSession || !pane) return false;
  try {
    const runtime = (await readYaml<Seat>(paths(root).seatFile(seat))).runtime;
    return nativeScopedTo(runtime, herdrSession, pane) && sessionUnsetOrEqual(runtime, piSession, piSessionPath);
  } catch { return false; }
}

function nativeScopedTo(runtime: Seat["runtime"], herdrSession: string, pane: string) {
  const locator = runtime?.addresses.herdr;
  return runtime?.application === "herdr" && runtime.wake === "native" && !runtime.launch_receipt
    && typeof locator === "object" && locator.session === herdrSession && locator.pane === pane;
}

const unsetOrEqual = (recorded: string | undefined, live: string | undefined) => !recorded || recorded === live;
const sessionUnsetOrEqual = (runtime: Seat["runtime"], piSession?: string, piSessionPath?: string) =>
  unsetOrEqual(runtime?.pi_session, piSession) && unsetOrEqual(runtime?.pi_session_path, piSessionPath);


type WakeIdentity = { seat: string; pi_session?: string; pi_session_path?: string; herdr_session?: string; pane?: string };
type WakeContext = {
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  modelRegistry?: { find(provider: string, id: string): unknown; hasConfiguredAuth(model: never): boolean };
  sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined; getBranch?: () => unknown[] };
  reload?: () => Promise<void>;
};

/** The live Pi/Herdr identity: launcher variables first, then Herdr's host-injected pane identity. */
function wakeIdentity(seat: string, ctx: WakeContext): WakeIdentity {
  const manager = ctx.sessionManager;
  return {
    seat,
    pi_session: process.env.ATDD_FLOW_PI_SESSION ?? manager?.getSessionId?.(),
    pi_session_path: manager?.getSessionFile?.(),
    herdr_session: process.env.ATDD_FLOW_HERDR_SESSION ?? process.env.HERDR_SESSION,
    pane: process.env.ATDD_FLOW_HERDR_PANE ?? process.env.HERDR_PANE_ID,
  };
}

/** A wake may act only for the exact seat, Pi session and Herdr pane that the Desk binds together. */
async function boundToLiveIdentity(root: string, identity: WakeIdentity) {
  if (!identity.pi_session || !identity.herdr_session || !identity.pane) return false;
  try {
    const runtime = (await readYaml<Seat>(paths(root).seatFile(identity.seat))).runtime;
    const locator = runtime?.addresses.herdr;
    return runtime?.application === "herdr" && typeof locator === "object" && locator.session === identity.herdr_session && locator.pane === identity.pane
      && unsetOrEqual(runtime.pi_session, identity.pi_session);
  } catch { return false; }
}

const branchOf = (ctx: WakeContext) => (ctx.sessionManager?.getBranch?.() ?? []) as TranscriptEntry[];

/** The single unmatched request on the active branch that was issued for this exact live identity. */
function unmatchedWakeRequest(branch: TranscriptEntry[], identity: WakeIdentity) {
  const matched = new Set(customEntries(branch, wakeResultType).map((entry) => entry.data?.request_id));
  const request = customEntries(branch, wakeRequestType).map((entry) => entry.data).filter((data) => data && !matched.has(data.request_id)).at(-1);
  if (!request || typeof request.request_id !== "string") return undefined;
  return request.seat === identity.seat && request.pi_session === identity.pi_session && request.pane === identity.pane ? request : undefined;
}

/** The recovery bundle is advisory; any failure falls back to the plain prompt. */
const recovery = (root: string, seat: string, mode: RecoveryMode, session?: string) => recoveryFor(root, seat, mode, session).catch(() => undefined);

/** Desk mail is authoritative; the queue is a bounded delivery index and fs.watch only shortens latency. */
export default function (pi: ExtensionAPI, environment: NodeJS.ProcessEnv = process.env) {
  const root = environment.ATDD_WORKFLOW_ROOT;
  const seat = environment.ATDD_WORKFLOW_SEAT;
  if (!root || !seat) return;
  let runtime: ReturnType<typeof createPiRuntime> | undefined;
  let handoverPrompted = false;
  // Host-attach only: mail older than this activation is consumed without a prompt, so a long backlog cannot trigger one turn per message.
  let hostActivatedAt: number | undefined;
  const notices: NoticeState = createNoticeState();
  const host = pi as unknown as Parameters<typeof sendTaskDirective>[0];
  // Held follow-ups are re-derived when Pi delivers them, so a notice queued before a state change cannot reach the model stale.
  pi.on("message_end", async (event) => {
    const message = await refreshDelivered(root, seat, notices, event.message as Parameters<typeof refreshDelivered>[3]);
    return message ? { message: message as typeof event.message } : undefined;
  });
  // Nothing queued survives a settled run, so a pending flag left by a cleared queue cannot suppress future notices.
  pi.on("agent_settled", async () => {
    notices.pending = false;
    // Run completion is not task completion; one bounded continuation per unchanged directive.
    await sendSettledDirective(host, root, seat, notices);
  });
  pi.on("turn_end", async (_event, ctx) => {
    if (handoverPrompted) return;
    const percent = ctx.getContextUsage()?.percent;
    if (percent === null || percent === undefined) return;
    try {
      const threshold = await contextHandoverThreshold(root);
      if (percent < threshold) return;
      handoverPrompted = true;
      const bundle = await recovery(root, seat, "threshold", environment.ATDD_FLOW_PI_SESSION);
      pi.sendMessage({
        customType: "atdd-flow-context-handover-replacement",
        content: handoverThresholdInstruction(percent, threshold, bundle),
        display: true, details: { seat, threshold, percent, authority: "handover" },
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch { /* Desk policy is re-read on the next safe boundary. */ }
  });
  pi.on("turn_end", async (_event, ctx) => {
    const sourceSession = environment.ATDD_FLOW_PI_SESSION;
    if (!sourceSession) return;
    try {
      const request = await readHandoverReplacement(root, seat);
      if (request.source.pi_session !== sourceSession) return;
      pi.sendMessage({
        customType: "atdd-flow-context-handover-replacement",
        content: `SYSTEM: Validated Path-A request for ${seat} observed. The successor must not start until this Pi has shut down and Herdr reports the exact source pane released.`,
        display: true, details: { seat, handover: request.handover.id, authority: "handover-replacement" },
      }, { triggerTurn: true, deliverAs: "followUp" });
      ctx.shutdown();
    } catch { /* No validated replacement request exists for this source session. */ }
  });
  const safeThinking = (ctx?: WakeContext) => ctx?.thinkingLevel ?? (typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined);
  const wakeResult = (requestId: string, outcome: string, extra: Record<string, unknown> = {}) => pi.appendEntry(wakeResultType, { request_id: requestId, outcome, ...extra });
  // Request, optional authenticated model swap, thinking restore, then reload; the post-reload session_start writes the result and the one resumed-work turn.
  // The command is registered only on hosts that expose it; `/reload` keeps the old instance terminal, so nothing runs after it here.
  (pi as { registerCommand?: ExtensionAPI["registerCommand"] }).registerCommand?.("flow-wake", {
    description: "Flow: optionally swap to a mapped model, reload, reconcile, and wake this seat once",
    handler: async (args: string, rawContext: unknown) => {
      const ctx = rawContext as WakeContext & { hasUI?: boolean; ui?: { notify(message: string, level: string): void } };
      const words = args.trim().split(/\s+/).filter(Boolean);
      const requestId = words.at(-1);
      if (words.length < 1 || words.length > 2 || !requestId || !wakeRequestIdPattern.test(requestId)) {
        if (ctx.hasUI) ctx.ui?.notify("Usage: /flow-wake [portfolio-candidate] <request-id>", "error");
        return;
      }
      const candidate = words.length === 2 ? words[0]! : undefined;
      const identity = wakeIdentity(seat, ctx);
      if (customEntries(branchOf(ctx), wakeRequestType).some((entry) => entry.data?.request_id === requestId)) {
        wakeResult(requestId, "failed", { reason: "duplicate request id" });
        return;
      }
      const source = { provider: ctx.model?.provider, model: ctx.model?.id, thinking: safeThinking(ctx) };
      pi.appendEntry(wakeRequestType, { request_id: requestId, ...identity, ...(candidate ? { candidate } : {}), source });
      try {
        if (!await boundToLiveIdentity(root, identity)) return wakeResult(requestId, "failed", { reason: "Desk binding does not match the live seat, session and pane" });
        if (candidate) {
          const entry = (await modelPortfolio(root))?.models.find((model) => model.id === candidate);
          const exact = entry && entry.enabled !== false ? piModel(entry) : undefined;
          if (!exact) return wakeResult(requestId, "failed", { reason: `candidate ${candidate} is not an enabled exact Pi model` });
          const model = ctx.modelRegistry?.find(exact.provider, exact.model);
          if (!model || !ctx.modelRegistry!.hasConfiguredAuth(model as never)) return wakeResult(requestId, "failed", { reason: `${exact.provider}/${exact.model} is not available and authenticated in Pi` });
          const thinking = pi.getThinkingLevel();
          if (!await pi.setModel(model as never)) return wakeResult(requestId, "failed", { reason: `Pi did not accept ${exact.provider}/${exact.model}` });
          pi.setThinkingLevel(thinking);
        }
        await ctx.reload?.();
      } catch (error) {
        wakeResult(requestId, "failed", { reason: error instanceof Error ? error.message : String(error) });
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    const wakeContext = ctx as unknown as WakeContext;
    const identity = wakeIdentity(seat, wakeContext);
    const wake = unmatchedWakeRequest(branchOf(wakeContext), identity);
    // Capability is evidence of a verified activation under this extension version; it never lives in runtime state.
    const announceCapability = () => { try { pi.appendEntry(wakeCapabilityType, { seat, pi_session: identity.pi_session, pane: identity.pane }); } catch { /* The host re-checks capability; absence only forces a reload. */ } };
    // One reload-reconstructed result and one combined recovery + task-directive turn replace the plain startup message.
    let wakeSettled = false;
    const completeWake = async () => {
      if (!wake) return false;
      wakeSettled = true;
      const requestId = String(wake.request_id), candidate = typeof wake.candidate === "string" ? wake.candidate : undefined;
      const target = { provider: wakeContext.model?.provider, model: wakeContext.model?.id, thinking: safeThinking(wakeContext) };
      if (candidate) {
        const entry = (await modelPortfolio(root).catch(() => undefined))?.models.find((model) => model.id === candidate);
        const exact = entry && entry.enabled !== false ? piModel(entry) : undefined;
        if (!exact || exact.provider !== target.provider || exact.model !== target.model) { wakeResult(requestId, "failed", { reason: "model after reload is not the requested candidate", target }); return true; }
      }
      const bundle = await recovery(root, seat, "start", identity.pi_session);
      const directive = await deliveredDirectiveText(root, seat, notices);
      wakeResult(requestId, candidate ? "swapped+woke" : "woke", { target });
      pi.sendMessage({
        customType: wakeStartType,
        content: `${runtimeStartupInstruction(seat, bundle)}${directive ? `\n${directive}` : ""}`,
        display: true, details: { seat, root, request_id: requestId, wake: true },
      }, { triggerTurn: true, deliverAs: "followUp" });
      return true;
    };
    const failWake = (reason: string) => { if (wake && !wakeSettled) { wakeSettled = true; wakeResult(String(wake.request_id), "failed", { reason }); } };
    const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined } }).sessionManager;
    const liveSession = environment.ATDD_FLOW_PI_SESSION ?? sessionManager?.getSessionId?.();
    // One display-only notice per session: a refused, timed-out or failed activation must never be silent, and never wakes the agent.
    let noticed = false;
    const noticeActivation = async (transport: "active" | "inactive", error?: string) => {
      if (noticed) return;
      noticed = true;
      const live = { pi_session: liveSession, herdr_session: environment.ATDD_FLOW_HERDR_SESSION ?? environment.HERDR_SESSION, pane: environment.ATDD_FLOW_HERDR_PANE ?? environment.HERDR_PANE_ID };
      const activation = await diagnoseMailActivation(root, seat, live, transport, error).catch(() => undefined);
      if (!activation) return;
      if (runtime) await recordMailActivation(root, seat, runtime.ownerToken, activation).catch(() => undefined);
      if (transport === "active" && !error) return;
      const content = await activationNotice(root, seat, activation).catch(() => undefined);
      const customType = transport === "active" ? "atdd-flow-mail-startup-failed" : "atdd-flow-mail-inactive";
      if (content) pi.sendMessage({ customType, content, display: true, details: { seat, live, authority: "binding" } }, { triggerTurn: false });
    };
    runtime = createPiRuntime({ root, seat, piSession: liveSession, deferActivation: true, deliver: async (mail, thread, path, sendIfOwned) => {
      if (!sendIfOwned) return false;
      if (hostActivatedAt !== undefined && Date.parse(typeof mail.created_at === "string" ? mail.created_at : "") < hostActivatedAt) return sendIfOwned(async () => undefined);
      const notify = typeof mail.id === "string" && typeof thread.id === "string" && await shouldNotifyMail(root, seat, notices, thread.id, mail.id);
      return sendIfOwned(async () => {
        if (!notify) return;
        await sendTaskDirective(host, root, seat, notices);
        pi.sendMessage({
          customType: "atdd-flow-mail",
          content: mailNotice(typeof thread.id === "string" ? thread.id : "unknown", { ...mail, subject: typeof thread.subject === "string" ? thread.subject : undefined }),
          display: true, details: { thread: thread.id, message: mail.id, path },
        }, { triggerTurn: true, deliverAs: "followUp" });
      });
    } });
    await runtime.start();
    const piSession = environment.ATDD_FLOW_PI_SESSION;
    const herdrSession = environment.ATDD_FLOW_HERDR_SESSION;
    const pane = environment.ATDD_FLOW_HERDR_PANE;
    if (!piSession && !herdrSession && !pane) {
      if (await hostAttachedActivation({ root, seat, herdrSession: environment.HERDR_SESSION, pane: environment.HERDR_PANE_ID, piSession: sessionManager?.getSessionId?.(), piSessionPath: sessionManager?.getSessionFile?.() })) {
        hostActivatedAt = Date.now();
        if (await runtime.activate()) {
          announceCapability();
          if (await completeWake()) return;
          const bundle = await recovery(root, seat, "start", sessionManager?.getSessionId?.());
          const notice = "Notices created before this session were not replayed; run atdd-flow status seat " + seat + " for unanswered mail.";
          pi.sendMessage({ customType: "atdd-flow-start", content: `${runtimeStartupInstruction(seat, bundle)} ${notice}`, display: true, details: { seat, root } }, { triggerTurn: true, deliverAs: "followUp" });
        }
        else failWake("native mail activation was refused");
      } else if (await expectsNativeMail(root, seat)) await noticeActivation("inactive");
      return;
    }
    if (!piSession || !herdrSession || !pane) return;
    const current = runtime;
    void awaitLaunchActivation({
      root, seat, piSession, herdrSession, pane,
      activate: async () => {
        if (!await activateWithRetry(() => current.activate())) return failWake("native mail activation was refused");
        announceCapability();
        if (await completeWake()) {
          if (ctx.hasUI) ctx.ui.notify(`ATDD Flow native mail active for ${seat}`, "info");
          return;
        }
        const request = await readHandoverReplacement(root, seat).catch(() => undefined);
        const successor = request && request.source.pi_session !== piSession ? request : undefined;
        const bundle = await recovery(root, seat, successor ? "successor" : "start", piSession);
        pi.sendMessage({ customType: "atdd-flow-start", content: runtimeStartupInstruction(seat, successor ? undefined : bundle), display: true, details: { seat, root } }, { triggerTurn: true, deliverAs: "followUp" });
        if (successor) {
          pi.sendMessage({
            customType: "atdd-flow-context-handover-replacement",
            content: successorInstruction(seat, successor.handover.id, bundle),
            display: true, details: { seat, handover: successor.handover.id, authority: "handover-replacement" },
          }, { triggerTurn: true, deliverAs: "followUp" });
        }
        await sendTaskDirective(host, root, seat, notices);
        if (ctx.hasUI) ctx.ui.notify(`ATDD Flow native mail active for ${seat}`, "info");
      },
    }).catch((error) => (failWake(error instanceof Error ? error.message : String(error)), error instanceof ActivationTimeout)
      ? noticeActivation("inactive")
      : noticeActivation(current.active ? "active" : "inactive", error instanceof Error ? error.message : String(error)));
  });
  pi.on("session_shutdown", () => { void runtime?.stop(); });
}
