import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type Runtime, type Seat, atomicYaml, canonicalAddress, desk, exists, has, now, paths, project, readYaml, required, seat, words, yaml } from "./core";
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
  created_at: string;
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

export function replacementMatchesRuntime(runtime: Runtime | undefined, request: HandoverReplacementRequest) {
  const locator = runtime?.addresses.herdr;
  return typeof locator !== "string" && locator?.session === request.source.herdr_session && locator.pane === request.source.pane
    && runtime?.pi_session === request.source.pi_session && runtime.pi_session_path === request.source.pi_session_path;
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
  if (!replacementMatchesRuntime(record.runtime, request)) throw new Error("Path-A replacement source tuple no longer matches the recorded runtime.");
  return request;
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

/**
 * Creates the single immutable intent that an old Pi may observe before it voluntarily exits.
 * It deliberately does not stop, bind, attach, project, or launch any process.
 */
export async function requestHandoverReplacement(root: string, address: string, args: string[]) {
  const resolved = await canonicalAddress(root, address);
  const allowed = ["--handover", "--authorization", "--takeover-task", "--source-pi-session", "--source-pi-session-path", "--source-herdr-session", "--source-pane", "--herdr-session", "--target-pane", "--target-cwd"];
  if (args.some((arg) => arg.startsWith("--") && !allowed.includes(arg))) throw new Error("Use `handover replace <main-seat> --handover <id> --authorization <operator-record> --takeover-task <id> --source-pi-session <id> --source-pi-session-path <jsonl> --source-herdr-session <session> --source-pane <pane> --herdr-session <session> --target-pane <pane> --target-cwd <canonical-main-worktree>`.");
  const handover = await recorded(root, resolved);
  const handoverId = nonEmpty(words(args, "--handover"), "--handover");
  if (!handover || handover.handover_id !== handoverId) throw new Error(`Path-A replacement requires the current validated handover ${handoverId} for ${resolved}.`);
  const { record } = await exactMainTakeoverTask(root, resolved, nonEmpty(words(args, "--takeover-task"), "--takeover-task"));
  const targetCwd = resolve(nonEmpty(words(args, "--target-cwd"), "--target-cwd"));
  if (targetCwd !== resolve(record.worktree)) throw new Error("Path-A replacement target CWD must be the exact canonical main worktree.");
  const source = {
    pi_session: nonEmpty(words(args, "--source-pi-session"), "--source-pi-session"), pi_session_path: resolve(nonEmpty(words(args, "--source-pi-session-path"), "--source-pi-session-path")),
    herdr_session: nonEmpty(words(args, "--source-herdr-session"), "--source-herdr-session"), pane: nonEmpty(words(args, "--source-pane"), "--source-pane"),
  };
  const locator = record.runtime?.addresses.herdr;
  if (!record.runtime || typeof locator === "string" || locator?.session !== source.herdr_session || locator.pane !== source.pane
    || record.runtime.pi_session !== source.pi_session || record.runtime.pi_session_path !== source.pi_session_path) {
    throw new Error("Path-A replacement source tuple must exactly match the recorded live runtime.");
  }
  const target = { herdr_session: nonEmpty(words(args, "--herdr-session"), "--herdr-session"), pane: nonEmpty(words(args, "--target-pane"), "--target-pane"), cwd: targetCwd };
  if (target.herdr_session !== source.herdr_session || target.pane !== source.pane) throw new Error("Path-A replacement target must be the exact released source pane.");
  const authorization = await resolveExactSessionAdoptionAuthorization(root, nonEmpty(words(args, "--authorization"), "--authorization"), {
    seat: resolved, pi_session: source.pi_session, pi_session_path: source.pi_session_path,
    source: { herdr_session: source.herdr_session, pane: source.pane }, target,
  });
  const request: HandoverReplacementRequest = {
    schema: "atdd-flow/context-handover-replacement-request/v1",
    seat: resolved,
    task: nonEmpty(words(args, "--takeover-task"), "--takeover-task"),
    handover: { id: handover.handover_id, sha256: createHash("sha256").update(handover.text).digest("hex") },
    authorization,
    source,
    target,
    created_at: now(),
  };
  const file = handoverReplacementPath(root, resolved);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, yaml.print(request), { encoding: "utf8", flag: "wx" });
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
