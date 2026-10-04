import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchedAddress, launchCommand, notify } from "./adapters";
import {
  type Seat, atomicYaml, canonicalAddress, desk, exists, id, modelPortfolio, now, paths, project,
  readYaml, required, runOutput, seat, values, words, yaml,
} from "./core";
import {
  type JudgmentOptions, type ReviewRoutingResponse, routeBehavioralReview, selectModel,
} from "./judgment";
import { availableModelCandidates, bind, resolveExecutable, resolveModelCommand } from "./seats";
import { type Task } from "./tasks";

const conventionRule = "atdd-bun.review.behavioral-reconciliation";
const conventionRelativePath = "conventions/atdd-bun.review/atdd-bun.review.behavioral-reconciliation.convention.yaml";

export type BehavioralReviewDecision = "APPROVE" | "RETURN" | "ESCALATE";
export type BehavioralReviewResult = {
  intent: { sources: string[]; expected_behavior: string };
  exercise: { boundary: string; evidence: string[] };
  observed: { behavior: string };
  reconciliation: {
    intent_matches_runtime: boolean;
    proof_matches_intent: boolean;
    missing_behavior: string[];
    unexpected_behavior: string[];
    drift: string[];
  };
  decision: BehavioralReviewDecision;
  rationale: string;
  confidence: number;
};

export type BehavioralReviewAttempt = {
  id: string;
  status: "pending" | "complete";
  created_at: string;
  completed_at?: string;
  delivery_head: string;
  routing: {
    classification: "LOCAL" | "ASSEMBLED" | "JOURNEY" | "SYSTEM";
    confidence: number;
    signals: {
      behaviorEffect: "BEHAVIOR_AFFECTING" | "BEHAVIOR_PRESERVING";
      proofBoundary: "LOCAL_ACCEPTANCE" | "ASSEMBLED_API_RUNTIME" | "INTERLOCKING_ROUTE" | "TRAIN" | "USER_JOURNEY";
      crossesMultiplePaths: boolean;
      consequence: "ORDINARY" | "HIGH_CONSEQUENCE";
      reconciliation: "SINGLE_PATH" | "MULTI_PATH_SYSTEM";
      runtimeObservation: "AVAILABLE" | "NOT_AVAILABLE";
    };
  };
  reviewer: { address: string; model: string };
  convention: { rule_id: string; path: string; package_version: string };
  input: {
    task: { title: string; body?: string; source?: string; done_when: Array<{ text: string; proof?: string }> };
    plan_artifacts: string[];
    deterministic_gates: string[];
    executable_proof: string[];
    runtime: { worktree: string; branch: string; head: string };
    implementation: { changed_files: string[]; diff_command: string };
  };
  result?: BehavioralReviewResult;
};

export type BehavioralReviewHistory = {
  schema: "atdd-workflow/behavioral-reviews/v1";
  task: string;
  attempts: BehavioralReviewAttempt[];
};

async function readTask(root: string, projectName: string, taskId: string) {
  const task = await readYaml<Task>(paths(root).taskFile(projectName, taskId));
  if (task.schema !== "atdd-workflow/task/v1") throw new Error(`Unsupported task schema: ${taskId}`);
  return task;
}

export async function readBehavioralReviews(root: string, projectName: string, taskId: string): Promise<BehavioralReviewHistory | undefined> {
  const file = paths(root).behavioralReviewFile(projectName, taskId);
  if (!await exists(file)) return undefined;
  const history = await readYaml<BehavioralReviewHistory>(file);
  if (history.schema !== "atdd-workflow/behavioral-reviews/v1") throw new Error(`Unsupported behavioral review schema: ${taskId}`);
  return history;
}

async function writeBehavioralReviews(root: string, projectName: string, taskId: string, history: BehavioralReviewHistory) {
  await atomicYaml(paths(root).behavioralReviewFile(projectName, taskId), history);
}

async function ownerForTask(root: string, task: Task) {
  return seat(root, required(task.assignee, "a task assignee for behavioral review"));
}

async function explicitWorkflowProfile(worktree: string) {
  const file = join(worktree, "atdd-bun.yaml");
  if (!await exists(file)) return false;
  const config = await readYaml<{ profiles?: string[] }>(file);
  return Array.isArray(config.profiles) && config.profiles.includes("workflow");
}

export async function behavioralReviewRequired(root: string, task: Task) {
  if (!task.assignee) return false;
  return explicitWorkflowProfile((await ownerForTask(root, task)).worktree);
}

async function currentHead(worktree: string) {
  return runOutput(["git", "rev-parse", "HEAD"], worktree);
}

async function assertCleanDelivery(worktree: string) {
  const dirty = await runOutput(["git", "status", "--porcelain"], worktree);
  if (dirty) throw new Error("Final behavioral review requires a clean committed delivery worktree.");
}

async function changedFiles(worktree: string, base: string) {
  const outputs = await Promise.allSettled([
    runOutput(["git", "diff", "--name-only", `${base}...HEAD`], worktree),
    runOutput(["git", "diff", "--name-only"], worktree),
    runOutput(["git", "diff", "--name-only", "--cached"], worktree),
    runOutput(["git", "ls-files", "--others", "--exclude-standard"], worktree),
  ]);
  return [...new Set(outputs.flatMap((output) => output.status === "fulfilled"
    ? output.value.split("\n").map((entry) => entry.trim()).filter(Boolean)
    : []
  ))].slice(0, 200);
}

async function planArtifacts(worktree: string) {
  try {
    const output = await runOutput(["git", "ls-files", "plan"], worktree);
    return output.split("\n").map((entry) => entry.trim()).filter((entry) => entry.endsWith(".yaml")).slice(0, 400);
  } catch {
    return [];
  }
}

async function convention(worktree: string) {
  const packageRoot = join(worktree, "node_modules", "@afokapu", "atdd-bun");
  const file = join(packageRoot, conventionRelativePath);
  if (!await exists(file)) {
    throw new Error(`Installed ATDD Bun does not provide ${conventionRule}; upgrade @afokapu/atdd-bun before final behavioral review.`);
  }
  const packageJson = await readFile(join(packageRoot, "package.json"), "utf8");
  const packageVersion = String(JSON.parse(packageJson).version ?? "unknown");
  return { path: conventionRelativePath, absolutePath: file, packageVersion, text: await readFile(file, "utf8") };
}

function conservativeRouting(): Extract<ReviewRoutingResponse, { available: true }> {
  return {
    available: true,
    classification: "SYSTEM",
    confidence: 0,
    signals: {
      behaviorEffect: "BEHAVIOR_AFFECTING",
      proofBoundary: "USER_JOURNEY",
      crossesMultiplePaths: true,
      consequence: "HIGH_CONSEQUENCE",
      reconciliation: "MULTI_PATH_SYSTEM",
      runtimeObservation: "NOT_AVAILABLE",
    },
  };
}

async function route(
  root: string,
  projectName: string,
  taskId: string,
  task: Task,
  owner: Seat,
  options: JudgmentOptions = {},
) {
  const config = await project(root, projectName);
  const role = config.roles[owner.role];
  const base = role?.base ?? config.roles.coordinator?.branch ?? "main";
  const [files, plans] = await Promise.all([changedFiles(owner.worktree, base), planArtifacts(owner.worktree)]);
  const judgment = await routeBehavioralReview({
    title: task.title,
    ...(task.body ? { body: task.body } : {}),
    ...(task.source ? { source: task.source } : {}),
    doneWhen: task.done_when,
    changedFiles: files,
    planArtifacts: plans,
  }, options);
  return {
    routing: judgment.available ? judgment : conservativeRouting(),
    files,
    plans,
    base,
  };
}

function reviewAddress(projectName: string, taskId: string) {
  return `reviewer.${taskId}@${projectName}`;
}

async function writeReviewerSeat(root: string, projectName: string, taskId: string, owner: Seat) {
  const address = reviewAddress(projectName, taskId);
  const file = paths(root).seatFile(address);
  const previous = await exists(file) ? await readYaml<Seat>(file) : undefined;
  const record: Seat = {
    schema: "atdd-workflow/seat/v2",
    address,
    role: "reviewer",
    project: projectName,
    worktree: owner.worktree,
    branch: owner.branch,
    purpose: `Perform final behavioral reconciliation for ${projectName}/${taskId}; never mutate task state.`,
    ...(previous?.runtime ? { runtime: previous.runtime } : {}),
  };
  await atomicYaml(file, record);
  return record;
}

function reviewerNotice(projectName: string, taskId: string, attempt: BehavioralReviewAttempt, conventionText: string) {
  const resultPath = `/tmp/atdd-workflow-${taskId}-behavioral-review.yaml`;
  return [
    `SYSTEM: you are ${attempt.reviewer.address}. You are the independent final behavioral reviewer for ${projectName}/${taskId}.`,
    "Do not mutate task state, acceptance intent, or implementation. Perform only the final semantic reconciliation defined below.",
    "",
    "AUTHORITATIVE METHOD (ATDD Bun):",
    conventionText,
    "",
    "READ INPUTS IN THIS ORDER:",
    `1. Task criteria/source: atdd-workflow task open ${projectName} ${taskId}`,
    `2. Plan artifacts: ${attempt.input.plan_artifacts.join(", ") || "(none discovered)"}`,
    `3. Deterministic gates: ${attempt.input.deterministic_gates.join("; ")}`,
    `4. Executable proof: ${attempt.input.executable_proof.join("; ") || "(none)"}`,
    `5. Runtime/worktree: ${attempt.input.runtime.worktree} @ ${attempt.input.runtime.head}`,
    `6. Implementation only after reconstructing the behavioral oracle: ${attempt.input.implementation.diff_command}`,
    "",
    `Write the structured review result to ${resultPath} with intent, exercise, observed, reconciliation, decision, rationale, and confidence, then persist it with:`,
    `atdd-workflow behavioral-review record ${projectName} ${taskId} --by ${attempt.reviewer.address} --file ${resultPath}`,
    "Allowed decisions: APPROVE, RETURN, ESCALATE. Do not directly return, block, or complete the task.",
  ].join("\n");
}

export async function launchBehavioralReview(
  root: string,
  projectName: string,
  taskId: string,
  args: string[],
  options: JudgmentOptions = {},
) {
  const task = await readTask(root, projectName, taskId);
  if (task.status !== "review") throw new Error(`Task ${taskId} must be in review before behavioral review.`);
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may launch final behavioral review for ${taskId}.`);
  if (!task.done_when.every((entry) => Boolean(entry.proof))) throw new Error(`Task ${taskId} is missing delivery proof.`);

  const owner = await ownerForTask(root, task);
  await assertCleanDelivery(owner.worktree);

  let gateOutput: string;
  try {
    gateOutput = await runOutput(["atdd-bun"], owner.worktree);
  } catch (error) {
    throw new Error(`Deterministic ATDD Bun gates are red; do not invoke the semantic reviewer: ${(error as Error).message}`);
  }

  const conventionSource = await convention(owner.worktree);
  const routed = await route(root, projectName, taskId, task, owner, options);
  const config = await desk(root);
  const portfolio = await modelPortfolio(root);
  let modelId: string;
  let agent: string;
  let modelArgs: string[] = [];
  if (portfolio) {
    const candidates = availableModelCandidates(config, portfolio);
    if (!candidates.length) throw new Error("No enabled model in models.yaml has an available executable for behavioral review.");
    const selection = routed.routing.confidence < 0.75 ? undefined : await selectModel({
      seat: { address: reviewAddress(projectName, taskId), role: "reviewer", purpose: "Final behavioral reconciliation" },
      tasks: [{ id: taskId, title: task.title, status: task.status, ...(task.body ? { body: task.body } : {}), doneWhen: task.done_when.map((entry) => entry.text) }],
      candidates,
      reviewRouting: {
        classification: routed.routing.classification,
        confidence: routed.routing.confidence,
        signals: routed.routing.signals,
      },
    }, options);
    const selected = selection?.available
      ? required(candidates.find((entry) => entry.id === selection.selected_model), `selected model ${selection.selected_model}`)
      : candidates[0]!;
    const command = resolveModelCommand(config, selected);
    modelId = selected.id;
    agent = command.agent;
    modelArgs = command.args;
  } else {
    const coordinator = await seat(root, task.coordinator);
    const legacyAgent = required(coordinator.agent, "models.yaml or a legacy coordinator agent for behavioral review");
    modelId = legacyAgent;
    agent = resolveExecutable(config, legacyAgent);
  }

  const reviewer = await writeReviewerSeat(root, projectName, taskId, owner);
  const head = await currentHead(owner.worktree);
  const history = await readBehavioralReviews(root, projectName, taskId) ?? {
    schema: "atdd-workflow/behavioral-reviews/v1" as const,
    task: `${projectName}/${taskId}`,
    attempts: [],
  };
  if (history.attempts.at(-1)?.status === "pending") throw new Error(`Task ${taskId} already has a pending behavioral review.`);

  const attempt: BehavioralReviewAttempt = {
    id: id("R"),
    status: "pending",
    created_at: now(),
    delivery_head: head,
    routing: {
      classification: routed.routing.classification,
      confidence: routed.routing.confidence,
      signals: routed.routing.signals,
    },
    reviewer: { address: reviewer.address, model: modelId },
    convention: { rule_id: conventionRule, path: conventionSource.path, package_version: conventionSource.packageVersion },
    input: {
      task: {
        title: task.title,
        ...(task.body ? { body: task.body } : {}),
        ...(task.source ? { source: task.source } : {}),
        done_when: task.done_when,
      },
      plan_artifacts: routed.plans,
      deterministic_gates: [`atdd-bun: PASS${gateOutput ? ` — ${gateOutput.slice(0, 500)}` : ""}`, ...values(args, "--gate")],
      executable_proof: task.done_when.flatMap((entry) => entry.proof ? [entry.proof] : []),
      runtime: { worktree: owner.worktree, branch: owner.branch, head },
      implementation: {
        changed_files: routed.files,
        diff_command: `git diff ${routed.base}...HEAD`,
      },
    },
  };
  history.attempts.push(attempt);
  await writeBehavioralReviews(root, projectName, taskId, history);

  const application = required(words(args, "--application"), "--application");
  const placement = required(words(args, "--placement"), "--placement");
  let output: string;
  try {
    output = await runOutput(launchCommand({
      application,
      placement,
      name: reviewer.address,
      worktree: reviewer.worktree,
      agent,
      args: modelArgs,
      root,
      seat: reviewer.address,
      environment: {
        ATDD_WORKFLOW_REVIEW_TASK: `${projectName}/${taskId}`,
        ATDD_WORKFLOW_REVIEW_ID: attempt.id,
      },
    }));
  } catch (error) {
    history.attempts.pop();
    await writeBehavioralReviews(root, projectName, taskId, history);
    throw error;
  }
  const nativeAddress = launchedAddress(application, placement, output);
  await bind(root, reviewer.address, ["--application", application, "--address", nativeAddress], modelId);
  try {
    await notify(application, nativeAddress, reviewerNotice(projectName, taskId, attempt, conventionSource.text));
  } catch (error) {
    console.warn(`Behavioral review notification for ${reviewer.address} was not delivered: ${(error as Error).message}`);
  }
  console.log(`${attempt.id}  ${routed.routing.classification}  ${modelId}`);
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${label} must be a string array.`);
  return value as string[];
}

function stringValue(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function booleanValue(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function validateResult(value: unknown): BehavioralReviewResult {
  if (!value || typeof value !== "object") throw new Error("Behavioral review result must be a mapping.");
  const result = value as Record<string, any>;
  const decision = result.decision;
  if (!["APPROVE", "RETURN", "ESCALATE"].includes(decision)) throw new Error("decision must be APPROVE, RETURN, or ESCALATE.");
  const confidence = Number(result.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("confidence must be between 0 and 1.");
  return {
    intent: {
      sources: stringArray(result.intent?.sources, "intent.sources"),
      expected_behavior: stringValue(result.intent?.expected_behavior, "intent.expected_behavior"),
    },
    exercise: {
      boundary: stringValue(result.exercise?.boundary, "exercise.boundary"),
      evidence: stringArray(result.exercise?.evidence, "exercise.evidence"),
    },
    observed: { behavior: stringValue(result.observed?.behavior, "observed.behavior") },
    reconciliation: {
      intent_matches_runtime: booleanValue(result.reconciliation?.intent_matches_runtime, "reconciliation.intent_matches_runtime"),
      proof_matches_intent: booleanValue(result.reconciliation?.proof_matches_intent, "reconciliation.proof_matches_intent"),
      missing_behavior: stringArray(result.reconciliation?.missing_behavior, "reconciliation.missing_behavior"),
      unexpected_behavior: stringArray(result.reconciliation?.unexpected_behavior, "reconciliation.unexpected_behavior"),
      drift: stringArray(result.reconciliation?.drift, "reconciliation.drift"),
    },
    decision,
    rationale: stringValue(result.rationale, "rationale"),
    confidence,
  };
}

export async function recordBehavioralReview(root: string, projectName: string, taskId: string, args: string[]) {
  const task = await readTask(root, projectName, taskId);
  if (task.status !== "review") throw new Error(`Task ${taskId} must still be in review when the behavioral result is recorded.`);
  const history = required(await readBehavioralReviews(root, projectName, taskId), `a pending behavioral review for ${taskId}`);
  const attempt = required([...history.attempts].reverse().find((entry) => entry.status === "pending"), `a pending behavioral review for ${taskId}`);
  const actor = required(words(args, "--by"), "--by");
  if (actor !== attempt.reviewer.address) throw new Error(`Only ${attempt.reviewer.address} may record review ${attempt.id}.`);
  const owner = await ownerForTask(root, task);
  if (await currentHead(owner.worktree) !== attempt.delivery_head) throw new Error("Delivery HEAD changed during behavioral review; launch a new review against the current delivery.");
  const file = required(words(args, "--file"), "--file");
  const result = validateResult(yaml.parse(await readFile(file, "utf8")));
  attempt.status = "complete";
  attempt.completed_at = now();
  attempt.result = result;
  await writeBehavioralReviews(root, projectName, taskId, history);
  console.log(`${attempt.id}  ${result.decision}`);
}

export async function openBehavioralReview(root: string, projectName: string, taskId: string) {
  const history = required(await readBehavioralReviews(root, projectName, taskId), `behavioral review history for ${taskId}`);
  console.log(yaml.print(history));
}

export async function assertAcceptedBehavioralReview(root: string, projectName: string, taskId: string, task: Task) {
  if (!await behavioralReviewRequired(root, task)) return;
  const history = required(await readBehavioralReviews(root, projectName, taskId), `final behavioral review for ${taskId}`);
  const latest = required(history.attempts.at(-1), `final behavioral review attempt for ${taskId}`);
  if (latest.status !== "complete" || !latest.result) throw new Error(`Task ${taskId} has no completed final behavioral review.`);
  if (latest.result.decision !== "APPROVE") throw new Error(`Task ${taskId} final behavioral review is ${latest.result.decision}, not APPROVE.`);
  const owner = await ownerForTask(root, task);
  await assertCleanDelivery(owner.worktree);
  if (await currentHead(owner.worktree) !== latest.delivery_head) throw new Error(`Task ${taskId} changed after final behavioral review; review the current delivery before completion.`);
}
