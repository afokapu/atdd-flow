// URN: component:flow:e004:recovery-bundle:backend:application
// Tested-By:
// - test:atdd-flow:seat-recovery-bundle
// - test:atdd-flow:seat-recovery-injection
// Runtime: bun
// Purpose: Compute one capped, read-only recovery bundle for a seat.

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Checkpoint, type Seat, canonicalAddress, exists, paths, readYaml, runOutput, runtimeAddress, seat as readSeat } from "./core";
import { readHandoverReplacement } from "./handover";
import { type Task, nextDirective, seatTasks, terminal } from "./tasks";
import { messages, pendingResponders, threadsForSeat } from "./threads";

/**
 * The bundle only reorganizes durable records (git, Desk, previous Pi session
 * file). It never writes, never calls a model, and renders every unreadable
 * source as an explicit `unavailable` line instead of failing.
 */
export type RecoveryMode = "start" | "threshold" | "successor";
type Options = { sessionPath?: string; now?: Date };
type Entry = { id: string; from: string; to: string; at: string; subject: string };

// Hard caps keep the bundle a pointer-style summary, never a transcript.
const maxLines = 50;
const maxBytes = 5120;
const maxTasks = 12;
const maxPending = 4;
const maxRecent = 5;
const maxChanged = 8;
const tailBytes = 256 * 1024;
const commandTimeoutMs = 8000;
const gatePattern = /\b(bun (run )?(test|check)|atdd-bun|tsc|lint)\b/;

/** Collapses whitespace and shortens one value so a single field cannot dominate the cap. */
function clip(text: string, length: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function age(from: string, now: Date) {
  const minutes = Math.floor((now.getTime() - Date.parse(from)) / 60_000);
  if (Number.isNaN(minutes)) return "unknown";
  if (minutes < 60) return `${Math.max(0, minutes)}m`;
  return minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

/** Runs one field builder; a failure becomes `<label>: unavailable (<reason>)`. */
async function part(label: string, build: () => Promise<string[] | string>): Promise<string[]> {
  try {
    const built = await build();
    return Array.isArray(built) ? built : [built];
  } catch (error) {
    return [`${label}: unavailable (${clip((error as Error).message, 80)})`];
  }
}

/** `--no-optional-locks` keeps `git status` from refreshing (writing) the index. */
const git = (cwd: string, ...args: string[]) => runOutput(["git", "--no-optional-locks", ...args], cwd);

/** Shows the first few changed paths and counts the rest. */
function listing(entries: string[]) {
  const shown: string[] = [];
  let used = 0;
  for (const entry of entries) {
    if (shown.length >= maxChanged || used + entry.length > 140) break;
    shown.push(entry);
    used += entry.length + 2;
  }
  const rest = entries.length - shown.length;
  return `${shown.join(", ")}${rest ? ` +${rest} more` : ""}`;
}

/** Each git field is its own part so one failing command only blanks that field. */
function gitParts(record: Seat, now: Date) {
  const cwd = record.worktree;
  return [
    part("branch", async () => `branch: ${await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")}`)
      .then((lines) => lines[0]!.includes("unavailable") ? [`branch: ${record.branch} (recorded; git unavailable)`] : lines),
    part("head", async () => `head: ${await git(cwd, "rev-parse", "--short", "HEAD")}`),
    part("upstream", async () => {
      const [behind, ahead] = (await git(cwd, "rev-list", "--left-right", "--count", "@{u}...HEAD")).split(/\s+/);
      return `upstream: ahead ${ahead}, behind ${behind}`;
    }),
    part("changed", async () => {
      const entries = (await git(cwd, "status", "--porcelain=v1", "-uall")).split("\n").filter(Boolean)
        .map((line) => line.replace(/^\s*(\S+)\s+/, "$1 "));
      return `changed: ${entries.length ? listing(entries) : "none"}`;
    }),
    part("last commit", async () => `last commit: ${age(await git(cwd, "log", "-1", "--format=%cI"), now)} ago`),
  ];
}

async function checkpointLine(root: string, address: string, now: Date) {
  const file = paths(root).checkpointFile(address);
  if (!await exists(file)) throw new Error("no checkpoint recorded");
  const entry = await readYaml<Checkpoint>(file);
  return `checkpoint: ${entry.status} — ${clip(entry.summary, 100)} | next: ${clip(entry.next_action, 60)} (${age(entry.updated_at, now)} ago)`;
}

/** Tasks that need this seat now (0), other work in flight (1), then todo (2). */
function taskGroup(task: Task, address: string) {
  if (task.status === "todo") return 2;
  const handoff = task.handoff?.state;
  const coordinating = task.coordinator === address && (task.status === "review" || Boolean(task.blocker) || handoff === "awaiting_coordinator");
  const assigned = task.assignee === address && task.status === "in_progress" && (handoff === "awaiting_assignee" || handoff === "executing");
  return coordinating || assigned ? 0 : 1;
}

function taskLine(id: string, task: Task) {
  const proven = `${task.done_when.filter((entry) => entry.proof).length}/${task.done_when.length}`;
  const parts = [`task ${id}`, task.status, task.phase, task.handoff && `${task.handoff.state} ${task.handoff.evidence}`, `proof ${proven}`];
  if (task.blocker) parts.push(`blocked: ${task.blocker}`);
  if (task.depends_on?.length) parts.push(`deps: ${task.depends_on.join(",")}`);
  return clip(parts.filter(Boolean).join(" "), 150);
}

const moreLine = (hidden: number, address: string) => `  +${hidden} more, run atdd-flow status seat ${address}`;

async function taskLines(root: string, address: string) {
  const record = await readSeat(root, address);
  const rows = (await seatTasks(root, record.project, address)).filter((entry) => !terminal(entry.task))
    .map((entry) => ({ ...entry, group: taskGroup(entry.task, address) }))
    .sort((left, right) => left.group - right.group || left.id.localeCompare(right.id));
  const count = (group: number) => rows.filter((row) => row.group === group).length;
  const lines = [`tasks: ${rows.length} open (${count(0)} need you, ${count(1)} in progress, ${count(2)} todo)`];
  lines.push(...rows.slice(0, maxTasks).map((row) => taskLine(row.id, row.task)));
  if (rows.length > maxTasks) lines.push(moreLine(rows.length - maxTasks, address));
  return lines;
}

async function nextLine(root: string, address: string) {
  const directive = await nextDirective(root, address);
  if (!directive) return "next: none (no actionable task state)";
  return clip(`next: ${directive.project}/${directive.task} [${directive.lifecycle}] ${directive.action}${directive.command ? ` ${directive.command}` : ""}`, 200);
}

const byAge = (left: Entry, right: Entry) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id);

/** Unanswered expects_result messages in both directions plus the seat's own recent posts. */
async function conversation(root: string, address: string) {
  const inbound: Entry[] = [];
  const outbound: Entry[] = [];
  const own: Entry[] = [];
  for (const { threadId, record } of await threadsForSeat(root, address)) {
    const all = await messages(root, threadId);
    for (const message of all) {
      const entry = { id: message.id, from: message.from, to: message.to === "all" ? "all" : message.to.join(","), at: message.created_at, subject: record.subject };
      if (message.from === address) own.push(entry);
      if (!message.expects_result || record.state === "closed") continue;
      const waiting = pendingResponders(record.participants, all, message);
      if (waiting.includes(address)) inbound.push(entry);
      if (message.from === address && waiting.length) outbound.push({ ...entry, to: waiting.join(",") });
    }
  }
  // Recent unanswered evidence wins the cap; totals still preserve the full count.
  return { inbound: inbound.sort(byAge).reverse(), outbound: outbound.sort(byAge).reverse(), own: own.sort(byAge).reverse() };
}

async function conversationLines(root: string, address: string, now: Date) {
  const { inbound, outbound, own } = await conversation(root, address);
  const render = (kind: string, entries: Entry[]) => {
    const shown = entries.slice(0, maxPending).map((entry) => clip(`${kind} ${entry.id} ${entry.from} -> ${entry.to} ${age(entry.at, now)}`, 170));
    return entries.length > maxPending ? [...shown, moreLine(entries.length - maxPending, address)] : shown;
  };
  return {
    unanswered: [`unanswered: ${inbound.length} inbound, ${outbound.length} outbound`, ...render("inbound", inbound), ...render("outbound", outbound)],
    recent: own.slice(0, maxRecent).map((entry) => clip(`recent ${entry.id} ${entry.subject}`, 100)),
  };
}

/** PR/CI state for the worktree branch; `gh` is read-only here and bounded by a timeout. */
async function prLine(cwd: string) {
  const child = Bun.spawn(["gh", "pr", "view", "--json", "number,state,url,statusCheckRollup"], {
    cwd, env: process.env, stdout: "pipe", stderr: "pipe", timeout: commandTimeoutMs,
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(err.trim().split("\n")[0] || `gh exited ${code}`);
  const pr = JSON.parse(out) as { number: number; state: string; url: string; statusCheckRollup?: { conclusion?: string; state?: string }[] };
  const tally = { pass: 0, fail: 0, pending: 0 };
  for (const check of pr.statusCheckRollup ?? []) {
    const result = (check.conclusion || check.state || "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(result)) tally.pass += 1;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(result)) tally.fail += 1;
    else tally.pending += 1;
  }
  return `pr: PR #${pr.number} ${pr.state} ${pr.url}; checks ${tally.pass} pass / ${tally.fail} fail / ${tally.pending} pending`;
}

type Tool = { commands: Map<string, string>; order: string[]; results: Map<string, { failed: boolean; text: string }> };
type Item = { type?: string; id?: string; name?: string; text?: string; arguments?: { command?: unknown } };
type Record = { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };

function textOf(content: unknown) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? (content as Item[]).map((item) => item.text ?? "").join("\n") : "";
}

function recordResult(tool: Tool, message: Record) {
  if (message.role !== "toolResult" || message.toolName !== "bash" || !message.toolCallId) return;
  tool.results.set(message.toolCallId, { failed: Boolean(message.isError), text: textOf(message.content) });
}

function recordCalls(tool: Tool, message: Record) {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const item of message.content as Item[]) {
    const command = item.arguments?.command;
    if (item.type !== "toolCall" || item.name !== "bash" || !item.id || typeof command !== "string") continue;
    tool.commands.set(item.id, command);
    tool.order.push(item.id);
  }
}

/** Reads bash tool calls and their paired results from Pi session JSONL records. */
function toolRecords(text: string): Tool {
  const tool: Tool = { commands: new Map(), order: [], results: new Map() };
  for (const line of text.split("\n")) {
    try { const message = JSON.parse(line).message ?? {}; recordResult(tool, message); recordCalls(tool, message); } catch { /* A partial or foreign line carries no tool record. */ }
  }
  return tool;
}

/** Last test/gate command and its recorded outcome, from the final 256KB of the session file only. */
async function gateLine(path: string) {
  const size = (await stat(path)).size;
  const start = Math.max(0, size - tailBytes);
  const tail = await Bun.file(path).slice(start, size).text();
  const tool = toolRecords(start > 0 ? tail.slice(tail.indexOf("\n") + 1) : tail);
  const id = tool.order.findLast((candidate) => gatePattern.test(tool.commands.get(candidate)!));
  if (!id) throw new Error("no test/gate command in session tail");
  const result = tool.results.get(id);
  const code = result?.text.match(/exited with code (\d+)/)?.[1];
  const outcome = !result ? "result unrecorded" : result.failed ? `failed${code ? `, code ${code}` : ""}` : "ok";
  return `gate: ${clip(tool.commands.get(id)!, 80)} — ${outcome}`;
}

function sessionOf(options: Options) {
  if (!options.sessionPath) throw new Error("no previous session");
  return options.sessionPath;
}

function runtimeLine(record: Seat) {
  const runtime = record.runtime;
  const locator = runtime?.addresses[runtime.application];
  if (!runtime || locator === undefined) throw new Error("no runtime recorded");
  const { address, session } = runtimeAddress(runtime.application, locator);
  return `runtime: ${runtime.application} ${session ?? ""} ${address} | pi session ${runtime.pi_session ?? "unrecorded"}`.replace(/\s+/g, " ");
}

/** Enforces the 50-line / 5KB contract by dropping trailing (least actionable) lines. */
function cap(lines: string[]) {
  const kept = lines.slice(0, maxLines);
  while (kept.length > 1 && new TextEncoder().encode(kept.join("\n")).length > maxBytes) kept.pop();
  return kept.join("\n");
}

/** Computes the recovery bundle for `address`; unreadable sources render as `unavailable`. */
export async function recoveryBundle(root: string, address: string, options: Options = {}) {
  const now = options.now ?? new Date();
  let resolved = address;
  let record: Seat;
  try {
    resolved = await canonicalAddress(root, address);
    record = await readSeat(root, resolved);
  } catch (error) {
    return cap([`RECOVERY BUNDLE ${resolved} | ${now.toISOString()}`, `seat: unavailable (${clip((error as Error).message, 80)})`]);
  }
  const talk = conversationLines(root, resolved, now).catch((error) => {
    const reason = `unavailable (${clip((error as Error).message, 80)})`;
    return { unanswered: [`unanswered: ${reason}`], recent: [`recent: ${reason}`] };
  });
  const sections = await Promise.all([
    [`role: ${record.role} | project: ${record.project}`, `worktree: ${record.worktree}`],
    ...gitParts(record, now),
    part("checkpoint", () => checkpointLine(root, resolved, now)),
    part("tasks", () => taskLines(root, resolved)),
    part("next", () => nextLine(root, resolved)),
    talk.then((lines) => lines.unanswered),
    part("pr", () => prLine(record.worktree)),
    part("gate", async () => gateLine(sessionOf(options))),
    part("session", async () => `session: ${sessionOf(options)}`),
    part("runtime", async () => runtimeLine(record)),
    talk.then((lines) => lines.recent),
  ]);
  return cap([`RECOVERY BUNDLE ${resolved} | ${now.toISOString()}`, ...sections.flat()]);
}

/**
 * The previous Pi session to point at: the predecessor's file for a Path-A
 * successor, the seat's own file at the handover threshold, or the newest
 * sibling file (excluding the running session) at an ordinary start.
 */
export async function previousSessionPath(root: string, address: string, mode: RecoveryMode, current?: string) {
  const resolved = await canonicalAddress(root, address);
  if (mode === "successor") return (await readHandoverReplacement(root, resolved)).source.pi_session_path;
  const runtime = (await readSeat(root, resolved)).runtime;
  const own = runtime?.pi_session_path;
  if (!own || mode === "threshold") return own;
  const running = current ?? runtime?.pi_session;
  const names = (await readdir(dirname(own))).filter((name) => name.endsWith(".jsonl") && !(running && name.includes(running))).sort();
  return names.length ? join(dirname(own), names[names.length - 1]!) : undefined;
}

/** The bundle for a prompt or CLI call; an unresolvable previous session only renders as unavailable. */
export async function recoveryFor(root: string, address: string, mode: RecoveryMode, current?: string) {
  const sessionPath = await previousSessionPath(root, address, mode, current).catch(() => undefined);
  return recoveryBundle(root, address, { sessionPath });
}
