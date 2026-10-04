import { readFile } from "node:fs/promises";
import { execFile as execute } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { type ModelCandidate, paths, readYaml, required } from "./core";
import { type Task } from "./tasks";

type ChoiceAnswer = { choice: string; confidence: number };
type JudgmentClient = { systemOne(request: unknown): Promise<{ model?: string; answers: Record<string, ChoiceAnswer> }> };
type Credential = () => Promise<string | undefined>;
type Unavailable = { available: false; reason: string };

export type ScoutResult = { path: string; relevance: "relevant" | "not_relevant"; confidence: number };
export type ScoutResponse = { available: true; model?: string; results: ScoutResult[] } | Unavailable;
export type FocusJudgment = "REQUIRED" | "USEFUL_BUT_NOT_REQUIRED" | "SPECULATIVE";
export type FocusResponse = { available: true; model?: string; judgment: FocusJudgment; confidence: number } | Unavailable;
export type ScoutInput = { goal: string; candidates: string[]; question?: string };
export type FocusInput = { title: string; body?: string; doneWhen: string[]; proposedAction: string };
export type ReviewClass = "LOCAL" | "ASSEMBLED" | "JOURNEY" | "SYSTEM";
export type ProofBoundary = "LOCAL_ACCEPTANCE" | "ASSEMBLED_API_RUNTIME" | "INTERLOCKING_ROUTE" | "TRAIN" | "USER_JOURNEY";
export type ReviewRoutingInput = {
  title: string;
  body?: string;
  source?: string;
  doneWhen: Array<{ text: string; proof?: string }>;
  changedFiles?: string[];
  planArtifacts?: string[];
  criticalCategories?: string[];
};
export type ReviewRoutingSignals = {
  behaviorEffect: "BEHAVIOR_AFFECTING" | "BEHAVIOR_PRESERVING";
  proofBoundary: ProofBoundary;
  crossesMultiplePaths: boolean;
  consequence: "ORDINARY" | "HIGH_CONSEQUENCE";
  reconciliation: "SINGLE_PATH" | "MULTI_PATH_SYSTEM";
  runtimeObservation: "AVAILABLE" | "NOT_AVAILABLE";
};
export type ReviewRoutingResponse = {
  available: true;
  model?: string;
  classification: ReviewClass;
  confidence: number;
  signals: ReviewRoutingSignals;
} | Unavailable;
export type ModelSelectionInput = {
  seat: { address: string; role: string; purpose?: string };
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    body?: string;
    doneWhen: string[];
    blocker?: string;
  }>;
  candidates: ModelCandidate[];
  reviewRouting?: {
    classification: ReviewClass;
    confidence: number;
    signals: ReviewRoutingSignals;
  };
};
export type ModelSelectionResponse = {
  available: true;
  model?: string;
  selected_model: string;
  confidence: number;
} | Unavailable;
export type JudgmentOptions = { client?: JudgmentClient; credential?: Credential };

const excerptLimit = 6_000;
const keychainService = "atdd-workflow.typesafe";
const execFile = promisify(execute);
const unavailable = (reason: string): Unavailable => ({ available: false, reason });

async function keychainCredential(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const account = process.env.USER ?? process.env.LOGNAME;
  if (!account) return undefined;
  try {
    const { stdout } = await execFile("/usr/bin/security", [
      "find-generic-password", "-s", keychainService, "-a", account, "-w",
    ], { encoding: "utf8", timeout: 1_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the optional Jev credential without writing it to workflow state. */
export async function resolveJevApiKey(options: JudgmentOptions = {}): Promise<string | undefined> {
  return process.env.TYPESAFE_API_KEY?.trim() || await (options.credential ?? keychainCredential)();
}

async function client(options: JudgmentOptions) {
  if (options.client) return options.client;
  const apiKey = await resolveJevApiKey(options);
  if (!apiKey) return undefined;
  return new TypeSafeClient({ apiKey, logLevel: "off", timeout: 5_000, retry: { maxRetries: 0 } }) as unknown as JudgmentClient;
}

async function candidate(path: string) {
  try {
    return { path, excerpt: (await readFile(resolve(path), "utf8")).slice(0, excerptLimit) };
  } catch {
    return { path, excerpt: "" };
  }
}

export async function scout(input: ScoutInput, options: JudgmentOptions = {}): Promise<ScoutResponse> {
  if (!input.candidates.length) return unavailable("No candidate paths were supplied.");
  const judge = await client(options);
  if (!judge) return unavailable("Jev credentials are not configured; continue using repository evidence.");
  const candidates = await Promise.all(input.candidates.map(candidate));
  const questions = Object.fromEntries(candidates.map((entry, index) => [`candidate_${index}`, choice({
    question: "Is this file relevant to the current implementation goal?",
    goal: input.goal,
    focus: input.question ?? "Identify files worth reading before implementation.",
    candidate_path: entry.path,
  }, {
    relevant: "The file is likely needed to understand, implement, or verify the stated goal.",
    not_relevant: "The file is unlikely to help with the stated goal at this time.",
  })]));
  try {
    const response = await judge.systemOne({ state: { goal: input.goal, question: input.question ?? null, candidates }, questions });
    return {
      available: true,
      ...(response.model ? { model: response.model } : {}),
      results: candidates.map((entry, index) => {
        const answer = response.answers[`candidate_${index}`];
        return { path: entry.path, relevance: answer?.choice === "relevant" ? "relevant" : "not_relevant", confidence: answer?.confidence ?? 0 };
      }),
    };
  } catch (error) {
    return unavailable(`Scout unavailable: ${(error as Error).message}`);
  }
}

export async function focusCheck(input: FocusInput, options: JudgmentOptions = {}): Promise<FocusResponse> {
  const judge = await client(options);
  if (!judge) return unavailable("Jev credentials are not configured; prefer the smaller reversible solution.");
  const questions = {
    scope: choice({
      question: "How necessary is the proposed action for the current task?",
      task_title: input.title,
      task_body: input.body ?? null,
      done_when: input.doneWhen,
      proposed_action: input.proposedAction,
    }, {
      REQUIRED: "Necessary now to satisfy a done_when criterion, correct a verified failure, or resolve a verified blocker.",
      USEFUL_BUT_NOT_REQUIRED: "Could improve the system but is not necessary for the current task; prefer the smaller solution.",
      SPECULATIVE: "Future-proofing, unrelated cleanup, generalized abstraction, or other work outside the current task.",
    }),
  };
  try {
    const response = await judge.systemOne({ state: { task: input, proposed_action: input.proposedAction }, questions });
    const answer = response.answers.scope;
    const judgment = (["REQUIRED", "USEFUL_BUT_NOT_REQUIRED", "SPECULATIVE"] as const).includes(answer?.choice as FocusJudgment)
      ? answer.choice as FocusJudgment
      : "USEFUL_BUT_NOT_REQUIRED";
    return { available: true, ...(response.model ? { model: response.model } : {}), judgment, confidence: answer?.confidence ?? 0 };
  } catch (error) {
    return unavailable(`Focus check unavailable: ${(error as Error).message}`);
  }
}

export async function focusTask(root: string, project: string, taskId: string, proposedAction: string, options: JudgmentOptions = {}) {
  const task = await readYaml<Task>(paths(root).taskFile(project, taskId));
  if (task.schema !== "atdd-workflow/task/v1") throw new Error(`Unsupported task schema: ${taskId}`);
  return focusCheck({
    title: task.title,
    ...(task.body ? { body: task.body } : {}),
    doneWhen: task.done_when.map((item) => item.text),
    proposedAction: required(proposedAction, "--action"),
  }, options);
}


const reviewRoutingConfidenceFloor = 0.75;
const modelSelectionConfidenceFloor = 0.75;

export async function routeBehavioralReview(input: ReviewRoutingInput, options: JudgmentOptions = {}): Promise<ReviewRoutingResponse> {
  const judge = await client(options);
  if (!judge) return unavailable("Jev credentials are not configured; route final review conservatively as SYSTEM.");
  const questions = {
    classification: choice({
      question: "What is the required complexity of the final behavioral reconciliation?",
      task_title: input.title,
      task_body: input.body ?? null,
      source: input.source ?? null,
      done_when: input.doneWhen,
      changed_files: input.changedFiles ?? [],
      plan_artifacts: input.planArtifacts ?? [],
      critical_categories: input.criticalCategories ?? ["authorization", "destructive mutation", "persistence", "financial effect", "security"],
    }, {
      LOCAL: "One local acceptance or similarly narrow behavioral path is sufficient.",
      ASSEMBLED: "The behavior must be reconciled at an assembled API/runtime or interlocking boundary.",
      JOURNEY: "The user-visible or train/journey behavior must be exercised end to end.",
      SYSTEM: "The delivery crosses multiple paths, boundaries, journeys, trains, or high-consequence system behavior and needs system-level reconciliation.",
    }),
    behavior_effect: choice({
      question: "Is the delivery externally behavior-affecting or intended to preserve behavior?",
      task_title: input.title,
      task_body: input.body ?? null,
      done_when: input.doneWhen.map((item) => item.text),
      changed_files: input.changedFiles ?? [],
    }, {
      BEHAVIOR_AFFECTING: "The delivery intentionally changes externally observable behavior.",
      BEHAVIOR_PRESERVING: "The delivery is intended to preserve externally observable behavior while changing structure or implementation.",
    }),
    proof_boundary: choice({
      question: "What is the highest relevant executable proof boundary for this delivery?",
      source: input.source ?? null,
      done_when: input.doneWhen,
      plan_artifacts: input.planArtifacts ?? [],
    }, {
      LOCAL_ACCEPTANCE: "A local acceptance/unit behavioral boundary is the highest relevant proof.",
      ASSEMBLED_API_RUNTIME: "An assembled API or runtime boundary is required.",
      INTERLOCKING_ROUTE: "An interlocking route is the highest relevant proof boundary.",
      TRAIN: "A train-level boundary is required.",
      USER_JOURNEY: "A user journey or equivalent end-to-end boundary is required.",
    }),
    cross_paths: choice({
      question: "Does the delivery cross multiple wagons, trains, routes, journeys, or equivalent behavioral paths?",
      plan_artifacts: input.planArtifacts ?? [],
      changed_files: input.changedFiles ?? [],
    }, {
      SINGLE: "The delivery stays within one relevant behavioral path.",
      MULTIPLE: "The delivery crosses multiple relevant behavioral paths or ownership boundaries.",
    }),
    consequence: choice({
      question: "Does the delivery affect a high-consequence domain or configured critical category?",
      task_title: input.title,
      task_body: input.body ?? null,
      changed_files: input.changedFiles ?? [],
      critical_categories: input.criticalCategories ?? ["authorization", "destructive mutation", "persistence", "financial effect", "security"],
    }, {
      ORDINARY: "No high-consequence or configured critical category is materially involved.",
      HIGH_CONSEQUENCE: "A high-consequence or configured critical category is materially involved.",
    }),
    reconciliation: choice({
      question: "Is the final review primarily a single-path reconciliation or a multi-path/system reconciliation?",
      plan_artifacts: input.planArtifacts ?? [],
      changed_files: input.changedFiles ?? [],
    }, {
      SINGLE_PATH: "One behavioral path can be reconciled against intent.",
      MULTI_PATH_SYSTEM: "Several paths or system interactions must be reconciled together.",
    }),
    runtime: choice({
      question: "Is direct runtime observation available from the declared plan, harness, or executable proof?",
      done_when: input.doneWhen,
      plan_artifacts: input.planArtifacts ?? [],
    }, {
      AVAILABLE: "The declared plan or harness exposes a runtime boundary the reviewer can exercise directly.",
      NOT_AVAILABLE: "No direct runtime observation is declared or available from the supplied context.",
    }),
  };
  try {
    const response = await judge.systemOne({ state: { task: input }, questions });
    const classificationAnswer = response.answers.classification;
    const behavior = response.answers.behavior_effect;
    const boundary = response.answers.proof_boundary;
    const crossPaths = response.answers.cross_paths;
    const consequence = response.answers.consequence;
    const reconciliation = response.answers.reconciliation;
    const runtime = response.answers.runtime;
    const classifications = ["LOCAL", "ASSEMBLED", "JOURNEY", "SYSTEM"] as const;
    const boundaries = ["LOCAL_ACCEPTANCE", "ASSEMBLED_API_RUNTIME", "INTERLOCKING_ROUTE", "TRAIN", "USER_JOURNEY"] as const;
    const confidence = Math.min(
      classificationAnswer?.confidence ?? 0,
      behavior?.confidence ?? 0,
      boundary?.confidence ?? 0,
      crossPaths?.confidence ?? 0,
      consequence?.confidence ?? 0,
      reconciliation?.confidence ?? 0,
      runtime?.confidence ?? 0,
    );
    const rawClassification = classifications.includes(classificationAnswer?.choice as ReviewClass)
      ? classificationAnswer!.choice as ReviewClass
      : "SYSTEM";
    const classification = confidence >= reviewRoutingConfidenceFloor ? rawClassification : "SYSTEM";
    const signals: ReviewRoutingSignals = {
      behaviorEffect: behavior?.choice === "BEHAVIOR_PRESERVING" ? "BEHAVIOR_PRESERVING" : "BEHAVIOR_AFFECTING",
      proofBoundary: boundaries.includes(boundary?.choice as ProofBoundary) ? boundary!.choice as ProofBoundary : "USER_JOURNEY",
      crossesMultiplePaths: crossPaths?.choice === "MULTIPLE",
      consequence: consequence?.choice === "ORDINARY" ? "ORDINARY" : "HIGH_CONSEQUENCE",
      reconciliation: reconciliation?.choice === "SINGLE_PATH" ? "SINGLE_PATH" : "MULTI_PATH_SYSTEM",
      runtimeObservation: runtime?.choice === "AVAILABLE" ? "AVAILABLE" : "NOT_AVAILABLE",
    };
    return { available: true, ...(response.model ? { model: response.model } : {}), classification, confidence, signals };
  } catch (error) {
    return unavailable(`Behavioral review routing unavailable: ${(error as Error).message}`);
  }
}

export async function selectModel(input: ModelSelectionInput, options: JudgmentOptions = {}): Promise<ModelSelectionResponse> {
  const candidates = input.candidates.filter((entry) => entry.enabled !== false);
  if (!candidates.length) return unavailable("No enabled model candidates were supplied.");
  if (candidates.length === 1) return { available: true, selected_model: candidates[0]!.id, confidence: 1 };
  const judge = await client(options);
  if (!judge) return unavailable("Jev credentials are not configured; use the strongest available model.");
  const criteria = Object.fromEntries(candidates.map((entry, index) => [entry.id,
    `Rank ${index + 1} of ${candidates.length}, ordered strongest to weakest. Select this only when it is the weakest listed model that can reliably complete the current responsibility.${entry.description ? ` ${entry.description}` : ""}`,
  ]));
  const questions = {
    model: choice({
      question: "Which listed model is the weakest candidate sufficient to complete the seat's current work reliably?",
      policy: "Prefer later/weaker candidates whenever they are sufficient. Use review routing complexity, cross-system scope, high-consequence flags, and residual uncertainty to justify stronger candidates; do not treat role names as capability requirements.",
      seat: input.seat,
      tasks: input.tasks,
      review_routing: input.reviewRouting ?? null,
      candidates: candidates.map((entry, index) => ({ id: entry.id, rank: index + 1, description: entry.description ?? null })),
    }, criteria),
  };
  try {
    const response = await judge.systemOne({ state: input, questions });
    const answer = response.answers.model;
    if (!answer || !candidates.some((entry) => entry.id === answer.choice)) {
      return unavailable("Jev returned a model outside the configured portfolio; use the strongest available model.");
    }
    if ((answer.confidence ?? 0) < modelSelectionConfidenceFloor) {
      return unavailable("Jev model selection confidence is low; use the strongest available model.");
    }
    return {
      available: true,
      ...(response.model ? { model: response.model } : {}),
      selected_model: answer.choice,
      confidence: answer.confidence ?? 0,
    };
  } catch (error) {
    return unavailable(`Model selection unavailable: ${(error as Error).message}`);
  }
}
