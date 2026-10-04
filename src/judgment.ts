import { readFile } from "node:fs/promises";
import { execFile as execute } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { paths, readYaml, required } from "./core";
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
