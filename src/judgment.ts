import { readFile } from "node:fs/promises";
import { execFile as execute } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { type ModelCandidate, paths, project as readProject, readYaml, required, runOutput, seat as readSeat } from "./core";
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
export type ReviewRoute = "CONFORMANCE" | "ADVERSARIAL";
export type ReviewInput = {
  title: string;
  body?: string;
  source?: string;
  changedFiles?: string[];
  doneWhen: Array<{ text: string; proof?: string }>;
};
export type ReviewSignals = {
  specification: "CLOSED" | "QUESTIONABLE";
  evidence: "DIRECT" | "INDIRECT_OR_INCOMPLETE";
  escapeRisk: "LOCAL" | "CROSS_BOUNDARY_OR_HIGH_CONSEQUENCE";
};
export type ReviewResponse = {
  available: true;
  model?: string;
  route: ReviewRoute;
  confidence: number;
  signals: ReviewSignals;
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
  reviewRoute?: ReviewRoute;
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


const reviewConfidenceFloor = 0.75;
const modelSelectionConfidenceFloor = 0.75;

export async function reviewCheck(input: ReviewInput, options: JudgmentOptions = {}): Promise<ReviewResponse> {
  const judge = await client(options);
  if (!judge) return unavailable("Jev credentials are not configured; use adversarial review conservatively.");
  const questions = {
    specification: choice({
      question: "Are the stated done_when criteria sufficiently closed to judge the intended behavior without inventing missing requirements?",
      task_title: input.title,
      task_body: input.body ?? null,
      done_when: input.doneWhen.map((item) => item.text),
    }, {
      CLOSED: "The criteria define observable required behavior clearly enough for a bounded conformance review.",
      QUESTIONABLE: "Material behavior, assumptions, or success conditions appear underspecified or ambiguous.",
    }),
    evidence: choice({
      question: "Does the supplied proof directly demonstrate the stated done_when behavior?",
      done_when: input.doneWhen,
      source: input.source ?? null,
    }, {
      DIRECT: "The proof is concrete and directly tied to each stated criterion.",
      INDIRECT_OR_INCOMPLETE: "The proof is missing, indirect, overly generic, or does not clearly demonstrate the criterion.",
    }),
    escape_risk: choice({
      question: "Could correctness materially depend on behavior outside the local stated criteria?",
      task_title: input.title,
      task_body: input.body ?? null,
      source: input.source ?? null,
      changed_files: input.changedFiles ?? [],
      done_when: input.doneWhen.map((item) => item.text),
    }, {
      LOCAL: "The change appears local and low-consequence; the stated criteria plausibly bound the important correctness surface.",
      CROSS_BOUNDARY_OR_HIGH_CONSEQUENCE: "The task appears to cross contracts, persistence, authorization, money, concurrency, public APIs, irreversible side effects, or another consequential boundary.",
    }),
  };
  try {
    const response = await judge.systemOne({ state: { task: input }, questions });
    const specification = response.answers.specification;
    const evidence = response.answers.evidence;
    const escapeRisk = response.answers.escape_risk;
    const signals: ReviewSignals = {
      specification: specification?.choice === "CLOSED" ? "CLOSED" : "QUESTIONABLE",
      evidence: evidence?.choice === "DIRECT" ? "DIRECT" : "INDIRECT_OR_INCOMPLETE",
      escapeRisk: escapeRisk?.choice === "LOCAL" ? "LOCAL" : "CROSS_BOUNDARY_OR_HIGH_CONSEQUENCE",
    };
    const confidence = Math.min(specification?.confidence ?? 0, evidence?.confidence ?? 0, escapeRisk?.confidence ?? 0);
    const route: ReviewRoute = signals.specification === "CLOSED"
      && signals.evidence === "DIRECT"
      && signals.escapeRisk === "LOCAL"
      && confidence >= reviewConfidenceFloor
      ? "CONFORMANCE"
      : "ADVERSARIAL";
    return { available: true, ...(response.model ? { model: response.model } : {}), route, confidence, signals };
  } catch (error) {
    return unavailable(`Review check unavailable: ${(error as Error).message}`);
  }
}

export async function reviewTask(root: string, project: string, taskId: string, options: JudgmentOptions = {}) {
  const task = await readYaml<Task>(paths(root).taskFile(project, taskId));
  if (task.schema !== "atdd-workflow/task/v1") throw new Error(`Unsupported task schema: ${taskId}`);
  let changedFiles: string[] | undefined;
  if (task.assignee) {
    try {
      const owner = await readSeat(root, task.assignee);
      const config = await readProject(root, project);
      const role = config.roles[owner.role];
      const base = role?.base ?? config.roles.coordinator?.branch ?? "main";
      const output = await runOutput(["git", "diff", "--name-only", `${base}...HEAD`], owner.worktree);
      changedFiles = output.split("\n").map((entry) => entry.trim()).filter(Boolean).slice(0, 100);
    } catch {
      changedFiles = undefined;
    }
  }
  return reviewCheck({
    title: task.title,
    ...(task.body ? { body: task.body } : {}),
    ...(task.source ? { source: task.source } : {}),
    ...(changedFiles?.length ? { changedFiles } : {}),
    doneWhen: task.done_when,
  }, options);
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
      policy: "Prefer later/weaker candidates whenever they are sufficient. Escalate only for residual ambiguity, cross-system reasoning, adversarial review, high-consequence decisions, or other work that genuinely requires stronger reasoning.",
      seat: input.seat,
      tasks: input.tasks,
      review_route: input.reviewRoute ?? null,
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
