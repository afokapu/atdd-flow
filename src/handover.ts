import { createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type Runtime, type Seat, atomicYaml, canonicalAddress, desk, exists, has, now, paths, project, readYaml, required, runOutput, seat, words, yaml } from "./core";
import { type Task, terminal } from "./tasks";
import { resolveExactSessionAdoptionAuthorization } from "./adoption-authorizations";
import { readRuntimeState } from "./runtime-state";

export type Handover = {
  schema: "atdd-workflow/handover/v1";
  seat: string;
  handover_id: string;
  supersedes: string;
  recorded_at: string;
  text: string;
};

export const maxHandoverLines = 150;
export const handoverSections = [
  "SEAT, AUTHORITY, TOOLKIT AND HAZARDS",
  "OPEN WORK AND IN-FLIGHT OPERATIONS",
  "DEPENDENCIES",
  "RESUME PROCEDURE AND NEXT ACTIONS",
] as const;

const header = /^HANDOVER (\S+) \| (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z) \| handover-id ([^\s|]+) \| supersedes ([^\s|]+)$/;
const headerForm = "`HANDOVER <seat-address> | <UTC ts> | handover-id <id> | supersedes <id|none>`";
/** Words that name a moving target instead of an exact record. */
const vagueWords = /\b(latest|newest|most recent)\b/gi;
/** A demonstrative reference to a record kind, vague unless an exact identifier (one containing a digit, `@`, or `/`) follows. */
const vagueDemonstrative = /\b(?:that|this|those|these|same|previous|earlier|above|last|aforementioned)\s+(PRs?|pull requests?|tasks?|threads?|messages?|commits?|branch(?:es)?|handovers?|sessions?|issues?|releases?)\b(?!\s+\S*[\d@/])/gi;

/** Every reason a handover text is not acceptable for `seat`, given the currently recorded handover id. */
export function handoverProblems(text: string, seatAddress: string, recorded?: string) {
  const problems: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length > maxHandoverLines) problems.push(`handover has ${lines.length} lines; the maximum is ${maxHandoverLines}.`);
  const match = header.exec(lines[0] ?? "");
  if (!match) problems.push(`line 1: missing or malformed header; expected ${headerForm}.`);
  else {
    const [, writer, , id, supersedes] = match as unknown as [string, string, string, string, string];
    if (writer !== seatAddress) problems.push(`line 1: header seat ${writer} does not match ${seatAddress}.`);
    if (id === "none") problems.push("line 1: handover-id must be an exact identifier, not none.");
    if (recorded === undefined && supersedes !== "none") problems.push(`line 1: supersedes ${supersedes}, but ${seatAddress} has no recorded handover; use supersedes none.`);
    if (recorded !== undefined && supersedes !== recorded) problems.push(`line 1: supersedes ${supersedes} must name the recorded handover ${recorded}.`);
    if (recorded !== undefined && id === recorded) problems.push(`line 1: handover-id ${id} is already recorded; use a new id.`);
  }
  if (!/^Runtime:\s*\S/.test(lines[1] ?? "")) problems.push("line 2: missing Runtime line; expected `Runtime: <runtime> | <session> | model <provider/model> | context <NN>%`.");
  const found: number[] = [];
  handoverSections.forEach((title, index) => {
    const heading = `${index + 1}. ${title}`;
    const at = lines.flatMap((line, position) => line.trim().startsWith(heading) ? [position] : []);
    if (!at.length) problems.push(`missing section ${index + 1} (\`${heading}\`).`);
    else if (at.length > 1) problems.push(`line ${at[1]! + 1}: duplicate section ${index + 1}.`);
    found[index + 1] = at[0] ?? -1;
  });
  for (let section = 2; section <= handoverSections.length; section++) {
    const earlier = found[section - 1]!, later = found[section]!;
    if (earlier >= 0 && later >= 0 && later < earlier) problems.push(`line ${later + 1}: section ${section} appears before section ${section - 1}; sections are out of order (expected 1, 2, 3, 4).`);
  }
  lines.forEach((line, index) => {
    for (const vague of [...line.matchAll(vagueWords), ...line.matchAll(vagueDemonstrative)]) {
      problems.push(`line ${index + 1}: vague reference "${vague[0]}"; name the exact ID (task, message, PR number, commit sha, or address).`);
    }
  });
  return problems;
}

async function recorded(root: string, address: string) {
  const file = paths(root).handoverFile(address);
  return await exists(file) ? await readYaml<Handover>(file) : undefined;
}

/** Validate a handover file and, unless `--check`, record it as the seat's durable handover. Checkpoints are never touched. */
export async function recordHandover(root: string, address: string, args: string[]) {
  const resolved = await canonicalAddress(root, address);
  await seat(root, resolved);
  const text = await readFile(required(words(args, "--file"), "--file"), "utf8");
  const prior = await recorded(root, resolved);
  const problems = handoverProblems(text, resolved, prior?.handover_id);
  if (problems.length) throw new Error(`Handover rejected for ${resolved}; nothing was recorded:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  const [, , , id, supersedes] = header.exec(text.split(/\r?\n/, 1)[0]!)! as unknown as [string, string, string, string, string];
  if (has(args, "--check")) return console.log(`Handover valid: ${id} for ${resolved} (checked only; not recorded).`);
  const record: Handover = { schema: "atdd-workflow/handover/v1", seat: resolved, handover_id: id, supersedes, recorded_at: now(), text };
  await atomicYaml(paths(root).handoverFile(resolved), record);
  console.log(`Recorded handover ${id} for ${resolved}.`);
}

export async function showHandover(root: string, address: string) {
  const resolved = await canonicalAddress(root, address);
  await seat(root, resolved);
  const record = await recorded(root, resolved);
  if (!record) throw new Error(`No handover is recorded for ${resolved}.`);
  process.stdout.write(record.text.endsWith("\n") ? record.text : `${record.text}\n`);
}

export type HandoverReplacementRequest = {
  schema: "atdd-flow/context-handover-replacement-request/v1";
  seat: string;
  task: string;
  handover: { id: string; sha256: string };
  authorization: { id: string; hash: string };
  source: { pi_session: string; pi_session_path: string; herdr_session: string; pane: string };
  target: { herdr_session: string; pane: string; cwd: string };
  legacy_source?: {
    authorization_hash: string;
    pi_session: string;
    pi_session_path: string;
    herdr_session: string;
    pane: string;
    cwd: string;
    agent: string;
    verified_at: string;
  };
  created_at: string;
};

export type HandoverReplacementDependencies = {
  command?: (command: string[]) => Promise<string>;
  at?: () => string;
  publish?: (file: string, content: string) => Promise<void>;
};

export const handoverReplacementPath = (root: string, address: string) => join(root, ".atdd-flow", "handover-replacements", `${encodeURIComponent(address)}.yaml`);
const nonEmpty = (value: string | undefined, flag: string) => required(value, flag).trim();

/** The threshold is Desk policy, not an instruction from transient mail. */
export async function contextHandoverThreshold(root: string) {
  const value = (await desk(root)).context_handover?.threshold_percent ?? 80;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 100) throw new Error("context_handover.threshold_percent must be an integer from 1 through 100.");
  return value;
}

export async function isExactMainSeat(root: string, record: Seat, address: string) {
  if (record.address !== address || record.role !== "main" || address !== `main@${record.project}` || record.branch !== "main") return false;
  const config = await project(root, record.project);
  return Boolean(config.repository && resolve(record.worktree) === resolve(config.repository));
}

function unboundLegacyRuntime(runtime: Runtime | undefined, pane: string) {
  const locator = runtime?.addresses.herdr;
  return runtime?.application === "herdr" && typeof locator === "string" && locator === pane
    && !runtime.pi_session && !runtime.pi_session_path && !runtime.launch_receipt;
}

function snapshotMatchesRequest(snapshot: NonNullable<HandoverReplacementRequest["legacy_source"]>, request: HandoverReplacementRequest) {
  return snapshot.authorization_hash === request.authorization.hash && snapshot.pi_session === request.source.pi_session
    && snapshot.pi_session_path === request.source.pi_session_path && snapshot.herdr_session === request.source.herdr_session
    && snapshot.pane === request.source.pane && snapshot.cwd === request.target.cwd && Boolean(snapshot.agent) && Boolean(snapshot.verified_at);
}

function canonicalSourceMatchesRuntime(runtime: Runtime | undefined, source: HandoverReplacementRequest["source"]) {
  const locator = runtime?.addresses.herdr;
  return typeof locator !== "string" && locator?.session === source.herdr_session && locator.pane === source.pane
    && runtime?.pi_session === source.pi_session && runtime.pi_session_path === source.pi_session_path;
}

export function replacementMatchesRuntime(runtime: Runtime | undefined, request: HandoverReplacementRequest) {
  if (!request.legacy_source) return canonicalSourceMatchesRuntime(runtime, request.source);
  return unboundLegacyRuntime(runtime, request.source.pane) && snapshotMatchesRequest(request.legacy_source, request);
}

export async function mainLaunchEligible(root: string, record: Seat, address: string, task: Task) {
  return task.status === "todo" && !task.blocker && task.coordinator === address && task.assignee === address
    && await isExactMainSeat(root, record, address);
}

export async function replacementForMainLaunch(root: string, record: Seat, address: string) {
  if (!await isExactMainSeat(root, record, address)) return undefined;
  const request = await readHandoverReplacement(root, address).catch(() => {
    throw new Error(`${address} requires one validated Path-A replacement request; refusing runtime launch.`);
  });
  const task = await readYaml<Task>(paths(root).taskFile(record.project, request.task));
  if (!replacementMatchesRuntime(record.runtime, request) || !await mainLaunchEligible(root, record, address, task)) {
    throw new Error("Path-A replacement source tuple no longer matches the recorded runtime or ready main takeover task.");
  }
  return { request, task };
}

export function assertReplacementTarget(request: HandoverReplacementRequest, herdrSession: string, pane: string, worktree: string) {
  if (request.target.herdr_session !== herdrSession || request.target.pane !== pane || request.target.cwd !== resolve(worktree)) {
    throw new Error("Path-A replacement request does not match the exact released target tuple.");
  }
}

async function exactMainTakeoverTask(root: string, address: string, id: string) {
  const record = await seat(root, address);
  if (!await isExactMainSeat(root, record, address)) {
    throw new Error(`Path-A replacement requires exact main@${record.project} primary-main topology.`);
  }
  let files: string[];
  try { files = await readdir(paths(root).tasks(record.project)); }
  catch { throw new Error(`Path-A replacement requires one ready self-assigned main takeover task for ${address}.`); }
  const ready = (await Promise.all(files.filter((file) => file.endsWith(".yaml") && !file.endsWith(".reviews.yaml")).map(async (file) => {
    const taskId = file.slice(0, -5);
    const task = await readYaml<Task>(paths(root).taskFile(record.project, taskId));
    if (task.schema !== "atdd-workflow/task/v1" || task.status !== "todo" || task.blocker || task.coordinator !== address || task.assignee !== address) return undefined;
    const dependencies = await Promise.all((task.depends_on ?? []).map(async (dependency) => {
      try { return terminal(await readYaml<Pick<Task, "status">>(paths(root).taskFile(record.project, dependency))); }
      catch { return false; }
    }));
    return dependencies.every(Boolean) ? taskId : undefined;
  }))).filter((entry): entry is string => Boolean(entry));
  if (ready.length !== 1 || ready[0] !== id) throw new Error(`Path-A replacement requires exactly one ready self-assigned main takeover task; found: ${ready.join(", ") || "none"}.`);
  return { record };
}

type LegacyPaneObservation = { pane: string; agent: string; sessionPath: string; cwd: string };
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown) => typeof value === "string" ? value : undefined;
function result(value: unknown) { const root = object(value); return object(root?.result) ?? root; }
function herdr(session: string, ...args: string[]) { return ["herdr", "--session", session, ...args]; }

function legacyPaneObservation(raw: string): LegacyPaneObservation {
  const value = JSON.parse(raw), pane = object(result(value)?.pane) ?? result(value), session = object(pane?.agent_session);
  const observation = { pane: text(pane?.pane_id), agent: text(pane?.agent), sessionPath: session?.kind === "path" ? text(session.value) : undefined, cwd: text(pane?.cwd) };
  if (!observation.pane || !observation.agent || !observation.sessionPath || !observation.cwd) throw new Error("Legacy source bootstrap requires complete live Herdr pane/session/path/cwd evidence.");
  return observation as LegacyPaneObservation;
}

function assertLegacyPane(observed: LegacyPaneObservation, source: HandoverReplacementRequest["source"], cwd: string) {
  const match = basename(observed.sessionPath).match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  if (observed.pane !== source.pane || resolve(observed.sessionPath) !== source.pi_session_path || match?.[1] !== source.pi_session || resolve(observed.cwd) !== cwd) {
    throw new Error("Legacy source bootstrap live pane/session/path/cwd does not match the authorized source tuple.");
  }
}

function legacyAgentName(raw: string, source: HandoverReplacementRequest["source"], cwd: string) {
  const value = JSON.parse(raw), agent = object(result(value)?.agent) ?? result(value), session = object(agent?.agent_session);
  const name = text(agent?.name), sessionPath = session?.kind === "path" ? text(session.value) : undefined, agentCwd = text(agent?.cwd);
  if (!name || text(agent?.pane_id) !== source.pane || text(agent?.agent) !== "pi" || !sessionPath || resolve(sessionPath) !== source.pi_session_path
    || !agentCwd || resolve(agentCwd) !== cwd) throw new Error("Legacy source bootstrap Pi agent does not match the authorized source pane/session/path/cwd.");
  return name;
}

function assertSinglePiWriter(raw: string) {
  const value = JSON.parse(raw), report = object(result(value)?.process_info) ?? result(value);
  const processes = Array.isArray(report?.foreground_processes) ? report.foreground_processes.map(object).filter(Boolean) as Record<string, unknown>[] : [];
  const pi = processes.filter((process) => text(process.name) === "pi" || text(process.argv0)?.endsWith("/pi") || text(process.argv0) === "pi" || /(^|\/)pi(?:\s|$)/.test(text(process.cmdline) ?? ""));
  if (pi.length !== 1) throw new Error("Legacy source bootstrap requires exactly one live Pi writer on the authorized source pane.");
}

async function verifyLegacySource(source: HandoverReplacementRequest["source"], target: HandoverReplacementRequest["target"], authorizationHash: string, dependencies: HandoverReplacementDependencies) {
  const command = dependencies.command ?? runOutput;
  const pane = legacyPaneObservation(await command(herdr(source.herdr_session, "pane", "get", source.pane)));
  assertLegacyPane(pane, source, target.cwd);
  const [agentRaw, processRaw] = await Promise.all([
    command(herdr(source.herdr_session, "agent", "get", source.pane)),
    command(herdr(source.herdr_session, "pane", "process-info", "--pane", source.pane)),
  ]);
  const agent = legacyAgentName(agentRaw, source, target.cwd);
  assertSinglePiWriter(processRaw);
  return { authorization_hash: authorizationHash, ...source, cwd: target.cwd, agent, verified_at: dependencies.at?.() ?? now() };
}

function assertLegacySeat(record: Seat, source: HandoverReplacementRequest["source"]) {
  const runtime = record.runtime, locator = runtime?.addresses.herdr;
  if (!runtime || runtime.application !== "herdr" || typeof locator !== "string" || locator !== source.pane
    || runtime.pi_session || runtime.pi_session_path || runtime.launch_receipt) {
    throw new Error("Legacy source bootstrap requires the unchanged scalar Herdr placement without canonical runtime binding.");
  }
}

async function publishCreateOnly(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await link(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

const replacementFlags = ["--legacy-source-bootstrap", "--handover", "--authorization", "--takeover-task", "--source-pi-session", "--source-pi-session-path", "--source-herdr-session", "--source-pane", "--herdr-session", "--target-pane", "--target-cwd"];
function validateReplacementArgs(args: string[]) {
  if (args.some((arg) => arg.startsWith("--") && !replacementFlags.includes(arg))) throw new Error("Use `handover replace <main-seat> [--legacy-source-bootstrap] --handover <id> --authorization <operator-record> --takeover-task <id> --source-pi-session <id> --source-pi-session-path <jsonl> --source-herdr-session <session> --source-pane <pane> --herdr-session <session> --target-pane <pane> --target-cwd <canonical-main-worktree>`.");
}

async function currentReplacementHandover(root: string, resolved: string, args: string[]) {
  const handover = await recorded(root, resolved), handoverId = nonEmpty(words(args, "--handover"), "--handover");
  if (!handover || handover.handover_id !== handoverId) throw new Error(`Path-A replacement requires the current validated handover ${handoverId} for ${resolved}.`);
  return handover;
}

function replacementSource(args: string[]) {
  return {
    pi_session: nonEmpty(words(args, "--source-pi-session"), "--source-pi-session"), pi_session_path: resolve(nonEmpty(words(args, "--source-pi-session-path"), "--source-pi-session-path")),
    herdr_session: nonEmpty(words(args, "--source-herdr-session"), "--source-herdr-session"), pane: nonEmpty(words(args, "--source-pane"), "--source-pane"),
  };
}

function replacementTarget(args: string[], record: Seat, source: HandoverReplacementRequest["source"]) {
  const cwd = resolve(nonEmpty(words(args, "--target-cwd"), "--target-cwd"));
  if (cwd !== resolve(record.worktree)) throw new Error("Path-A replacement target CWD must be the exact canonical main worktree.");
  const target = { herdr_session: nonEmpty(words(args, "--herdr-session"), "--herdr-session"), pane: nonEmpty(words(args, "--target-pane"), "--target-pane"), cwd };
  if (target.herdr_session !== source.herdr_session || target.pane !== source.pane) throw new Error("Path-A replacement target must be the exact released source pane.");
  return target;
}

function assertReplacementSource(record: Seat, source: HandoverReplacementRequest["source"], legacy: boolean) {
  if (legacy) return assertLegacySeat(record, source);
  if (!canonicalSourceMatchesRuntime(record.runtime, source)) throw new Error("Path-A replacement source tuple must exactly match the recorded live runtime.");
}

async function prepareReplacement(root: string, resolved: string, args: string[]) {
  validateReplacementArgs(args);
  const legacy = args.includes("--legacy-source-bootstrap"), handover = await currentReplacementHandover(root, resolved, args);
  const task = nonEmpty(words(args, "--takeover-task"), "--takeover-task");
  const { record } = await exactMainTakeoverTask(root, resolved, task);
  const source = replacementSource(args), target = replacementTarget(args, record, source);
  assertReplacementSource(record, source, legacy);
  return { legacy, handover, task, source, target };
}

function replacementRequest(resolved: string, intent: Awaited<ReturnType<typeof prepareReplacement>>, authorization: { id: string; hash: string }, legacySource: HandoverReplacementRequest["legacy_source"], dependencies: HandoverReplacementDependencies): HandoverReplacementRequest {
  return {
    schema: "atdd-flow/context-handover-replacement-request/v1", seat: resolved, task: intent.task,
    handover: { id: intent.handover.handover_id, sha256: createHash("sha256").update(intent.handover.text).digest("hex") },
    authorization, source: intent.source, target: intent.target,
    ...(legacySource ? { legacy_source: legacySource } : {}), created_at: dependencies.at?.() ?? now(),
  };
}

/**
 * Creates the single immutable intent that an old Pi may observe before it voluntarily exits.
 * It deliberately does not stop, bind, attach, project, or launch any process.
 */
export async function requestHandoverReplacement(root: string, address: string, args: string[], dependencies: HandoverReplacementDependencies = {}) {
  const resolved = await canonicalAddress(root, address), intent = await prepareReplacement(root, resolved, args);
  const file = handoverReplacementPath(root, resolved);
  if (intent.legacy && await exists(file)) throw new Error(`Path-A replacement request already exists for ${resolved}.`);
  const authorization = await resolveExactSessionAdoptionAuthorization(root, nonEmpty(words(args, "--authorization"), "--authorization"), {
    seat: resolved, pi_session: intent.source.pi_session, pi_session_path: intent.source.pi_session_path,
    source: { herdr_session: intent.source.herdr_session, pane: intent.source.pane }, target: intent.target,
  });
  const legacySource = intent.legacy ? await verifyLegacySource(intent.source, intent.target, authorization.hash, dependencies) : undefined;
  const request = replacementRequest(resolved, intent, authorization, legacySource, dependencies);
  await (dependencies.publish ?? publishCreateOnly)(file, yaml.print(request));
  console.log(`Recorded Path-A replacement request for ${resolved}.`);
}

/** Reports only a live receipt reconciliation; source archival remains an external, post-proof operation. */
export async function readHandoverReplacement(root: string, address: string) {
  const request = await readYaml<HandoverReplacementRequest>(handoverReplacementPath(root, address));
  if (request.schema !== "atdd-flow/context-handover-replacement-request/v1" || request.seat !== address) throw new Error(`Invalid Path-A replacement request for ${address}.`);
  return request;
}

export async function resumedHandoverReplacement(root: string, address: string) {
  const resolved = await canonicalAddress(root, address);
  const [request, record] = await Promise.all([readHandoverReplacement(root, resolved), seat(root, resolved)]);
  const runtime = record.runtime;
  const locator = runtime?.addresses.herdr;
  const receipt = runtime?.launch_receipt && await exists(runtime.launch_receipt) ? await readYaml<Record<string, unknown>>(runtime.launch_receipt) : undefined;
  const replacement = receipt?.handover_replacement as Record<string, unknown> | undefined;
  const runtimeState = await readRuntimeState(root, resolved);
  const verified = [
    request.schema === "atdd-flow/context-handover-replacement-request/v1" && request.seat === resolved,
    runtime?.application === "herdr" && runtime.wake === "native",
    runtime?.pi_session !== request.source.pi_session && Boolean(runtime?.pi_session_path),
    typeof locator !== "string" && locator?.session === request.target.herdr_session && locator?.pane === request.target.pane,
    replacement?.successor_session === runtime?.pi_session && replacement?.request && JSON.stringify(replacement.request) === JSON.stringify(request),
    Boolean(runtimeState && runtimeState.seat === resolved),
  ];
  const discrepancies = [
    !verified[0] ? "request" : undefined,
    !verified[1] ? "native delivery" : undefined,
    !verified[2] ? "fresh Pi session/JSONL path" : undefined,
    !verified[3] ? "target tuple" : undefined,
    !verified[4] ? "successor receipt" : undefined,
    !verified[5] ? "fresh heartbeat" : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  console.log(`RESUMED; verified ${verified.filter(Boolean).length}/${verified.length}; discrepancies: ${discrepancies.join(", ") || "none"}.`);
  if (discrepancies.length) throw new Error("Path-A successor is not reconciled against the live Desk.");
}
