// URN: component:flow:e007:runtime-rotation:backend:integration
// Tested-By:
// - test:atdd-flow:delegated-seat-runtime-rotation:E007-RED-001
// Runtime: bun
// Purpose: Rotate one governed Pi seat through the existing handover and launch path.
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type Seat, canonicalAddress, desk, modelPortfolio, paths, project,
  readYaml, required, seat, words, yaml,
} from "./core";
import { type Handover, type HandoverReplacementRequest, handoverReplacementPath, resumedHandoverReplacement } from "./handover";
import { readRuntimeState } from "./runtime-state";
import { availableModelCandidates, launchPiRuntime } from "./seats";
import { type Task, seatTasks, terminal } from "./tasks";
import type { ModelSelectionInput, ModelSelectionResponse } from "./judgment";
const grammar = "pi runtime rotate <seat> --by <caller> --task <id> --handover <id> --source-pi-session <id> --source-pi-session-path <jsonl> --source-herdr-session <session> --source-pane <pane> --target-herdr-session <session> --target-pane <pane> --target-cwd <worktree> [--model <candidate>] [--timeout-ms <milliseconds>]";
const flags = ["--by", "--task", "--handover", "--source-pi-session", "--source-pi-session-path", "--source-herdr-session", "--source-pane", "--target-herdr-session", "--target-pane", "--target-cwd", "--model", "--timeout-ms", "--request-file"];
const active = new Map<string, { signature: string; promise: Promise<Record<string, any>> }>();
type RotationDependencies = {
  command?: (command: string[]) => Promise<string>;
  pause?: (milliseconds: number) => Promise<void>;
  select?: (input: ModelSelectionInput) => Promise<ModelSelectionResponse>;
  sessionId?: () => string;
  at?: () => string;
  spawnContinuation?: (spec: Record<string, any>) => Promise<{ pid: number; exited: Promise<number> }>;
  environment?: Record<string, string | undefined>;
};
type RotationOptions = ReturnType<typeof parseOptions>;
type RotationRequest = HandoverReplacementRequest & {
  rotation: { request_sha256: string; by: string; model?: string };
};
type RotationReceipt = {
  schema?: string; seat?: string; tasks?: string[]; candidate?: string; pi_session?: string; pi_session_path?: string;
  herdr_session?: string; pane?: string; rotation?: { request_sha256?: string; by?: string; task?: string; handover?: string; requested_model?: string };
};

/** Reject unknown, repeated, missing, and flag-shaped values as one closed grammar. */
function validPair(flag: string | undefined, value: string | undefined, seen: Set<string>) {
  if (!flag || !value) return false;
  if (!flags.includes(flag) || seen.has(flag)) return false;
  return !value.startsWith("--");
}
/** Parse the complete public tuple before any Desk or Herdr observation. */
function parseOptions(args: string[]) {
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!validPair(flag, value, seen)) throw new Error(`Use \`${grammar}\`.`);
    seen.add(flag!);
  }
  const timeout = Number(words(args, "--timeout-ms") ?? "120000");
  const validTimeout = Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 600_000;
  if (!validTimeout) throw new Error("--timeout-ms must be an integer from 1 through 600000.");
  return {
    by: required(words(args, "--by"), "--by"), task: required(words(args, "--task"), "--task"),
    handover: required(words(args, "--handover"), "--handover"),
    source: {
      pi_session: required(words(args, "--source-pi-session"), "--source-pi-session"),
      pi_session_path: resolve(required(words(args, "--source-pi-session-path"), "--source-pi-session-path")),
      herdr_session: required(words(args, "--source-herdr-session"), "--source-herdr-session"),
      pane: required(words(args, "--source-pane"), "--source-pane"),
    },
    target: {
      herdr_session: required(words(args, "--target-herdr-session"), "--target-herdr-session"),
      pane: required(words(args, "--target-pane"), "--target-pane"),
      cwd: resolve(required(words(args, "--target-cwd"), "--target-cwd")),
    },
    model: words(args, "--model"), timeout, requestFile: words(args, "--request-file"),
  };
}
/** Narrow untrusted command output without accepting arrays as keyed reports. */
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown) => typeof value === "string" ? value : undefined;
function result(value: unknown) { const root = object(value); return object(root?.result) ?? root; }
function herdr(session: string, ...args: string[]) { return ["herdr", "--session", session, ...args]; }
/** Recognize only the Pi process shapes already accepted by the generic launcher. */
function piProcess(entry: unknown) {
  const process = object(entry);
  return process && (text(process.name) === "pi" || text(process.argv0) === "pi" || text(process.argv0)?.endsWith("/pi") || /(^|\/)pi(?:\s|$)/.test(text(process.cmdline) ?? ""));
}
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Main authority is valid only at the declared primary checkout. */
async function exactMain(root: string, candidate: Seat) {
  const config = await project(root, candidate.project);
  return candidate.role === "main" && candidate.address === `main@${candidate.project}` && candidate.branch === "main"
    && Boolean(config.repository) && resolve(candidate.worktree) === resolve(config.repository!);
}
/** Extract a canonical named stream without granting generic coordinator authority. */
function coordinatorStream(candidate: Seat) {
  if (candidate.role !== "coordinator") return undefined;
  return candidate.address.match(new RegExp(`^coordinator\\.([a-z0-9_-]+)@${candidate.project}$`))?.[1];
}
/** Named authority must occupy its configured integration branch and worktree. */
async function exactNamedCoordinator(root: string, candidate: Seat) {
  const config = await project(root, candidate.project), role = config.roles.coordinator;
  const stream = coordinatorStream(candidate);
  const configured = role?.address === "coordinator.{name}@{project}" && role.branch === "integration/{name}";
  if (!stream || !configured || !role.worktree) return false;
  const expected = resolve(role.worktree.replace("{project}", config.project).replace("{name}", stream).replace("{worktree_root}", config.worktree_root ?? "").replace("{repository}", config.repository ?? ""));
  const separate = resolve(candidate.worktree) !== resolve(config.repository ?? "");
  return candidate.branch === `integration/${stream}` && resolve(candidate.worktree) === expected && separate;
}
/** Operator remains a fail-closed fallback while project authority is online. */
async function assertOperatorFallback(root: string, target: Seat, task: Task) {
  const authorities = [`main@${target.project}`, ...(task.coordinator !== target.address ? [task.coordinator] : [])];
  for (const address of authorities) {
    if (await readRuntimeState(root, address)) throw new Error("Operator fallback is unavailable while an authorized project caller is live.");
  }
}
/** Enforce the closed main/coordinator/operator authority matrix. */
async function assertAuthority(root: string, caller: Seat, target: Seat, task: Task) {
  if (target.retired) throw new Error(`Target ${target.address} is retired.`);
  if (caller.retired) throw new Error(`Caller ${caller.address} is retired.`);
  if (caller.address === "operator@desk") return assertOperatorFallback(root, target, task);
  if (caller.project !== target.project) throw new Error("Delegated rotation requires caller and target in the same project.");
  if (await exactMain(root, caller)) return;
  const directDriver = target.role === "driver" && task.coordinator === caller.address;
  if (directDriver && await exactNamedCoordinator(root, caller)) return;
  throw new Error("Caller is not authorized to rotate this direct project seat; only exact main or the driver's named coordinator may do so.");
}
/** Launch eligibility preserves task lifecycle and dependency terminality. */
async function eligible(root: string, projectName: string, task: Task) {
  if (task.blocker || !["todo", "in_progress"].includes(task.status) || task.handoff?.state === "awaiting_coordinator") return false;
  const dependencies = await Promise.all((task.depends_on ?? []).map(async (id) => {
    try { return terminal(await readYaml<Task>(paths(root).taskFile(projectName, id))); } catch { return false; }
  }));
  return dependencies.every(Boolean);
}
/** Ambiguity is rejected instead of turning --task into an assignment selector. */
async function exactTask(root: string, target: Seat, requested: string) {
  const candidates = [] as Array<{ id: string; task: Task }>;
  for (const entry of await seatTasks(root, target.project, target.address)) {
    const accountable = entry.task.assignee === target.address || (target.role === "coordinator" && entry.task.coordinator === target.address);
    if (accountable && await eligible(root, target.project, entry.task)) candidates.push(entry);
  }
  if (candidates.length !== 1 || candidates[0]!.id !== requested) throw new Error(`Rotation requires exactly one eligible task for ${target.address}; found ${candidates.map((entry) => entry.id).join(", ") || "none"}.`);
  return candidates[0]!.task;
}
/** Optional model input names one enabled, locally available portfolio candidate. */
async function chosenModel(root: string, requested?: string) {
  const config = await desk(root), portfolio = required(await modelPortfolio(root), "models.yaml for delegated rotation");
  const available = availableModelCandidates(config, portfolio);
  if (requested && !available.some((candidate) => candidate.id === requested)) throw new Error(`Model candidate ${requested} is not enabled and available.`);
  return { requested, candidate: requested ? available.find((entry) => entry.id === requested)! : undefined };
}
/** Bind rotation identity to the target's current validated handover text. */
async function handover(root: string, target: Seat, id: string) {
  const record = await readYaml<Handover>(paths(root).handoverFile(target.address));
  if (record.schema !== "atdd-workflow/handover/v1" || record.seat !== target.address || record.handover_id !== id) throw new Error(`Rotation requires the current validated handover ${id}.`);
  return record;
}
/** Compare the immutable seat binding before trusting its receipt path. */
function runtimeMatchesSource(target: Seat, options: RotationOptions) {
  const runtime = target.runtime, locator = runtime?.addresses.herdr;
  if (runtime?.application !== "herdr" || typeof locator === "string") return false;
  const placement = locator?.session === options.source.herdr_session && locator.pane === options.source.pane;
  const identity = runtime.pi_session === options.source.pi_session && resolve(runtime.pi_session_path ?? "") === options.source.pi_session_path;
  return placement && identity && Boolean(runtime.launch_receipt);
}
/** A source receipt must corroborate every immutable seat tuple field. */
function receiptMatchesSource(receipt: RotationReceipt, target: Seat, options: RotationOptions) {
  const identity = receipt.seat === target.address && receipt.pi_session === options.source.pi_session;
  const path = resolve(receipt.pi_session_path ?? "") === options.source.pi_session_path;
  const placement = receipt.herdr_session === options.source.herdr_session && receipt.pane === options.source.pane;
  return receipt.schema === "atdd-flow/pi-runtime-launch-receipt/v1" && identity && path && placement;
}
/** Reject stale binding or substituted immutable launch evidence before publication. */
async function assertSourceReceipt(target: Seat, options: RotationOptions) {
  if (!runtimeMatchesSource(target, options)) throw new Error("Rotation source tuple is stale and does not match the seat runtime.");
  const receipt = await readYaml<RotationReceipt>(target.runtime!.launch_receipt!);
  if (!receiptMatchesSource(receipt, target, options)) throw new Error("Rotation source receipt does not match the exact source tuple.");
}

/** Parse the paired Herdr pane and process reports into one bounded observation. */
function sourceObservation(paneRaw: string, processRaw: string) {
  const paneResult = result(JSON.parse(paneRaw)), processResult = result(JSON.parse(processRaw));
  const pane = object(paneResult?.pane) ?? paneResult;
  const session = object(pane?.agent_session);
  const report = object(processResult?.process_info) ?? processResult;
  const processes = Array.isArray(report?.foreground_processes) ? report.foreground_processes.filter(piProcess) : [];
  return { pane, session, processes };
}

/** Herdr must expose the exact JSONL and exactly one live Pi writer. */
function observationMatchesSource(observed: ReturnType<typeof sourceObservation>, options: RotationOptions) {
  const pane = text(observed.pane?.pane_id) === options.source.pane && Boolean(text(observed.pane?.agent));
  const path = observed.session?.kind === "path" && resolve(text(observed.session.value) ?? "") === options.source.pi_session_path;
  return pane && path && observed.processes.length === 1;
}

/** Corroborate the advisory heartbeat with live Herdr source evidence. */
async function assertLiveSource(root: string, target: Seat, options: RotationOptions, dependencies: RotationDependencies) {
  const state = await readRuntimeState(root, target.address);
  if (!state || resolve(state.cwd) !== resolve(target.worktree)) throw new Error("Rotation source runtime heartbeat is absent or stale.");
  const command = dependencies.command;
  if (!command) return;
  const [paneRaw, processRaw] = await Promise.all([
    command(herdr(options.source.herdr_session, "pane", "get", options.source.pane)),
    command(herdr(options.source.herdr_session, "pane", "process-info", "--pane", options.source.pane)),
  ]);
  if (!observationMatchesSource(sourceObservation(paneRaw, processRaw), options)) throw new Error("Rotation source pane/session has a stale tuple or duplicate Pi writer.");
}

/** Enumerate immutable launch evidence without treating malformed files as candidates. */
async function receipts(root: string) {
  const directory = join(root, ".atdd-flow", "runtime-launch");
  try {
    return (await Promise.all((await readdir(directory)).filter((file) => file.endsWith(".yaml")).map(async (file) => {
      const path = join(directory, file);
      try { return { path, receipt: await readYaml<RotationReceipt>(path) }; } catch { return undefined; }
    }))).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  } catch { return []; }
}

/** Derive the public result entirely from exact input and persisted successor evidence. */
function rotationResult(target: Seat, options: RotationOptions, receipt: RotationReceipt, receiptPath: string) {
  return {
    schema: "atdd-flow/delegated-runtime-rotation-result/v1", state: "complete", seat: target.address, by: options.by, task: options.task,
    source: { pi_session: options.source.pi_session, pi_session_path: options.source.pi_session_path },
    successor: { pi_session: receipt.pi_session, pi_session_path: receipt.pi_session_path }, target: options.target,
    model: { requested: options.model ?? receipt.candidate, selected: receipt.candidate }, launch_receipt: receiptPath,
    resumed: { verified: 6, total: 6 },
  };
}

/** A completed retry is read-only; competing receipt evidence is always ambiguous. */
async function completedOrDuplicate(root: string, target: Seat, options: RotationOptions, requestId: string) {
  const found = (await receipts(root)).filter((entry) => entry.receipt.seat === target.address && entry.receipt.rotation);
  const exact = found.filter((entry) => entry.receipt.rotation?.request_sha256 === requestId);
  if (exact.length > 1 || (found.length && exact.length !== 1)) throw new Error("Duplicate or substituted rotation receipt/writer evidence exists.");
  if (!exact.length) return undefined;
  const entry = exact[0]!, runtime = target.runtime;
  if (runtime?.launch_receipt !== entry.path || runtime.pi_session !== entry.receipt.pi_session || runtime.pi_session_path !== entry.receipt.pi_session_path) throw new Error("Completed rotation receipt does not match the unique bound writer.");
  return rotationResult(target, options, entry.receipt, entry.path);
}

/** Reuse the handover replacement request as the sole source-release intent. */
function requestFor(target: Seat, options: RotationOptions, record: Handover, requestId: string, at: string): RotationRequest {
  return {
    schema: "atdd-flow/context-handover-replacement-request/v1", seat: target.address, task: options.task,
    handover: { id: record.handover_id, sha256: createHash("sha256").update(record.text).digest("hex") },
    authorization: { id: options.by, hash: requestId }, source: options.source, target: options.target,
    rotation: { request_sha256: requestId, by: options.by, ...(options.model ? { model: options.model } : {}) }, created_at: at,
  };
}

/** Publish create-only, allowing only a byte-identity-equivalent request retry. */
async function publishRequest(file: string, request: RotationRequest) {
  await mkdir(dirname(file), { recursive: true });
  try { await writeFile(file, yaml.print(request), { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = await readYaml<RotationRequest>(file);
    if (current.rotation?.request_sha256 !== request.rotation.request_sha256) throw new Error("A different rotation tuple already owns the active request.");
  }
}

/** Vacancy requires both agent metadata and process inspection to be empty. */
function vacant(rawPane: string, rawProcess: string, options: RotationOptions) {
  const pane = object(result(JSON.parse(rawPane))?.pane) ?? result(JSON.parse(rawPane));
  const report = object(result(JSON.parse(rawProcess))?.process_info) ?? result(JSON.parse(rawProcess));
  const processes = Array.isArray(report?.foreground_processes) ? report.foreground_processes : [];
  return text(pane?.pane_id) === options.target.pane && !text(pane?.agent) && !processes.some(piProcess);
}

/** Share one deadline while waiting for advisory release and exact pane vacancy. */
async function waitForVacancy(root: string, target: Seat, options: RotationOptions, dependencies: RotationDependencies) {
  const command = required(dependencies.command, "a Herdr command runner"), pause = dependencies.pause ?? ((ms) => Bun.sleep(ms));
  const deadline = Date.now() + options.timeout;
  while (Date.now() <= deadline) {
    const state = await readRuntimeState(root, target.address);
    const [pane, processes] = await Promise.all([
      command(herdr(options.target.herdr_session, "pane", "get", options.target.pane)),
      command(herdr(options.target.herdr_session, "pane", "process-info", "--pane", options.target.pane)),
    ]);
    if ((!state || state.owner_token === "") && vacant(pane, processes, options)) return;
    await pause(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Timed out waiting for graceful source release and target vacancy.");
}

/** Self-main returns only after launching one shell-free, deadline-bound continuation. */
async function spawnContinuation(root: string, target: Seat, args: string[], options: RotationOptions, file: string, dependencies: RotationDependencies) {
  const deadline = new Date(Date.parse(dependencies.at?.() ?? new Date().toISOString()) + options.timeout).toISOString();
  const argv = [process.execPath, join(import.meta.dir, "cli.ts"), "--root", root, "pi", "runtime", "rotate", target.address, ...args, "--request-file", file];
  const spec = { argv, shell: false, detached: true, deadline_at: deadline };
  const spawn = dependencies.spawnContinuation ?? (async (value: Record<string, any>) => {
    const child = Bun.spawn(value.argv, { env: { ...process.env, ...dependencies.environment }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    return { pid: child.pid, exited: child.exited };
  });
  const child = await spawn(spec);
  return { schema: "atdd-flow/delegated-runtime-rotation-result/v1", state: "accepted", seat: target.address, by: options.by, task: options.task, request: file, continuation_pid: child.pid };
}

/** Execute validation, request, release, generic launch, and RESUMED in order. */
async function execute(root: string, address: string, args: string[], options: RotationOptions, dependencies: RotationDependencies) {
  const resolved = await canonicalAddress(root, address), target = await seat(root, resolved);
  if (resolve(target.worktree) !== options.target.cwd) throw new Error("Rotation target CWD does not match the exact seat worktree.");
  const task = await exactTask(root, target, options.task), callerAddress = await canonicalAddress(root, options.by), caller = await seat(root, callerAddress);
  await assertAuthority(root, caller, target, task);
  const record = await handover(root, target, options.handover), model = await chosenModel(root, options.model);
  const requestId = digest({ seat: resolved, by: callerAddress, task: options.task, handover: { id: record.handover_id, text: digest(record.text) }, source: options.source, target: options.target, model: options.model ?? null });
  const completed = await completedOrDuplicate(root, target, options, requestId);
  if (completed) return completed;
  await assertSourceReceipt(target, options);
  await assertLiveSource(root, target, options, dependencies);
  const file = handoverReplacementPath(root, resolved), request = requestFor(target, options, record, requestId, dependencies.at?.() ?? new Date().toISOString());
  if (options.requestFile && options.requestFile !== file) throw new Error("Continuation request path does not match the exact seat request.");
  await publishRequest(file, request);
  if (target.address === caller.address && target.role === "main" && !options.requestFile) return spawnContinuation(root, target, args, options, file, dependencies);
  await waitForVacancy(root, target, options, dependencies);
  const selection = model.candidate ? async (_input: ModelSelectionInput): Promise<ModelSelectionResponse> => ({ available: true, model: "governed", selected_model: model.candidate!.id, confidence: 1 }) : dependencies.select;
  await launchPiRuntime(root, resolved, ["--pane", options.target.pane, "--herdr-session", options.target.herdr_session], {
    command: dependencies.command, select: selection, sessionId: dependencies.sessionId, at: dependencies.at,
    requestedCandidate: options.model, rotation: { request, request_sha256: requestId, by: callerAddress, task: options.task, handover: options.handover, requested_model: options.model },
  });
  await resumedHandoverReplacement(root, resolved);
  const rebound = await seat(root, resolved), receiptPath = required(rebound.runtime?.launch_receipt, "the successor launch receipt");
  return rotationResult(rebound, options, await readYaml<RotationReceipt>(receiptPath), receiptPath);
}

/** Attach exact duplicate calls to one in-process execution; changed tuples fail before another effect. */
export function rotatePiRuntime(root: string, address: string, args: string[], dependencies: RotationDependencies = {}) {
  let options: RotationOptions;
  try { options = parseOptions(args); } catch (error) { return Promise.reject(error); }
  const signature = digest({ address, options });
  const current = active.get(address);
  if (current) return current.signature === signature ? current.promise : Promise.reject(new Error("A different rotation tuple is already executing for this target."));
  const promise = execute(root, address, args, options, dependencies);
  active.set(address, { signature, promise });
  void promise.finally(() => { if (active.get(address)?.promise === promise) active.delete(address); }).catch(() => undefined);
  return promise;
}
