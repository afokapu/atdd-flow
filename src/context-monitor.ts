// URN: component:flow:e025:context-monitor:backend:application
// Tested-By:
// - test:atdd-flow:server-side-context-monitor
// Runtime: bun
// Purpose: Prompt the context-threshold handover from Flow, using the exact Pi transcript.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalAddress, modelPortfolio, now, piModel, type ModelPortfolio, yaml } from "./core";
import { handoverThresholdInstruction } from "./collaboration-policy";
import { contextHandoverThreshold } from "./handover";
import { type Outcome, type Prepared, herdr, hold, message, parseWakeArguments, prepare, readBranch, targetAddresses } from "./pi-wake";
import { recoveryFor } from "./recovery-bundle";
import type { TranscriptEntry } from "./pi-wake-protocol";
import { customEntries } from "./pi-wake-protocol";

export const monitorUsage = "Use `atdd-flow pi context-monitor <seat>|--scope project|desk --by <authorized-seat> [--dry-run]`.";
export type MonitorOutcome = Outcome | "prompted" | "would-prompt" | "below" | "already";
export type MonitorRow = { seat: string; outcome: MonitorOutcome; detail?: string };

/** The extension's own threshold prompt; the same custom type also carries successor prompts, so only the threshold detail counts. */
const thresholdPromptType = "atdd-flow-context-handover-replacement";
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const monitorRow = (seat: string, outcome: MonitorOutcome, detail?: string): MonitorRow => ({ seat, outcome, ...(detail ? { detail } : {}) });
export const markerPath = (root: string, seat: string, piSession: string) => join(root, ".atdd-flow", "context-monitor", `${encodeURIComponent(seat)}__${piSession}.yaml`);

/** The last assistant turn on the active branch: its exact model and the context it occupied. */
export function lastAssistantUsage(branch: TranscriptEntry[]) {
  for (const entry of [...branch].reverse()) {
    const body = object((entry as Record<string, unknown>).message);
    if (entry.type !== "message" || body?.role !== "assistant") continue;
    const tokens = object(body.usage)?.totalTokens;
    if (typeof tokens === "number" && tokens > 0 && typeof body.provider === "string" && typeof body.model === "string") return { tokens, provider: body.provider, model: body.model };
  }
  return undefined;
}

/** The window the Desk declares for exactly this provider/model; nothing is inferred. */
function declaredWindow(portfolio: ModelPortfolio | undefined, provider: string, model: string) {
  const windows = (portfolio?.models ?? []).flatMap((candidate) => {
    const exact = piModel(candidate);
    return exact?.provider === provider && exact.model === model && candidate.context_window ? [candidate.context_window] : [];
  });
  return windows.length === 1 ? windows[0] : undefined;
}

const format = (value: number) => `${Math.round(value * 10) / 10}%`;

/** The reason a session needs no prompt yet (already prompted, no usage, no declared window), else its measured context. */
async function measure(root: string, address: string, ready: { sessionPath: string; sessionId: string }, portfolio: ModelPortfolio | undefined) {
  const branch = await readBranch(ready.sessionPath).catch((error) => error as Error);
  if (branch instanceof Error) return monitorRow(address, "refused", `cannot read the Pi transcript: ${branch.message}`);
  if (customEntries(branch, thresholdPromptType).some((entry) => entry.details?.threshold !== undefined)) return monitorRow(address, "already", "threshold prompt already in the transcript");
  if (await Bun.file(markerPath(root, address, ready.sessionId)).exists()) return monitorRow(address, "already", "this Pi session was already prompted");
  const usage = lastAssistantUsage(branch);
  if (!usage) return monitorRow(address, "skipped", "no assistant usage recorded in the transcript");
  const window = declaredWindow(portfolio, usage.provider, usage.model);
  if (!window) return monitorRow(address, "skipped", `no context_window declared for ${usage.provider}/${usage.model}`);
  return { percent: usage.tokens / window * 100, window };
}

/** Create-only marker first so a concurrent monitor cannot double-prompt; a failed prompt releases it. */
async function prompt(root: string, address: string, ready: { session: string; pane: string; sessionId: string }, percent: number, threshold: number, summary: string) {
  const marker = markerPath(root, address, ready.sessionId);
  const bundle = await recoveryFor(root, address, "threshold", ready.sessionId).catch(() => undefined);
  await mkdir(dirname(marker), { recursive: true });
  try { await writeFile(marker, yaml.print({ schema: "atdd-flow/context-monitor-marker/v1", seat: address, pi_session: ready.sessionId, percent: Math.floor(percent), threshold, prompted_at: now() }), { encoding: "utf8", flag: "wx" }); }
  catch { return monitorRow(address, "already", "this Pi session was already prompted"); }
  try { await herdr(ready.session, "agent", "prompt", ready.pane, handoverThresholdInstruction(Math.floor(percent), threshold, bundle)); }
  catch (error) { await rm(marker, { force: true }); return monitorRow(address, "failed", message(error)); }
  return monitorRow(address, "prompted", summary);
}

async function monitorOne(root: string, address: string, prepared: Extract<Prepared, { record: unknown }>, threshold: number, portfolio: ModelPortfolio | undefined, dryRun: boolean): Promise<MonitorRow> {
  const { ready } = prepared;
  const measured = await measure(root, address, ready, portfolio);
  if ("outcome" in measured) return measured;
  const summary = `${format(measured.percent)} of ${measured.window} tokens`;
  if (measured.percent < threshold) return monitorRow(address, "below", `${summary}; threshold ${threshold}%`);
  if (dryRun) return monitorRow(address, "would-prompt", `${summary}; threshold ${threshold}%`);
  return prompt(root, address, ready, measured.percent, threshold, summary);
}

/** Runs the closed `pi context-monitor` grammar; each seat's row is reported in lexical order as it completes. */
export async function monitorContext(root: string, args: string[], report: (line: MonitorRow) => void = () => undefined) {
  const dryRun = args.includes("--dry-run");
  const options = (() => { try { return parseWakeArguments(args.filter((argument) => argument !== "--dry-run")); } catch { throw new Error(monitorUsage); } })();
  if (options.profile) throw new Error(monitorUsage);
  const actor = await canonicalAddress(root, options.by);
  const addresses = (await targetAddresses(root, options, actor)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const threshold = await contextHandoverThreshold(root), portfolio = await modelPortfolio(root);
  const rows: MonitorRow[] = [];
  for (const address of addresses) {
    const prepared: Prepared = await prepare(root, address, actor).catch((error) => hold(address, "failed", message(error)));
    const outcome = "row" in prepared ? monitorRow(prepared.row.seat, prepared.row.outcome, prepared.row.detail)
      : await monitorOne(root, address, prepared, threshold, portfolio, dryRun).catch((error) => monitorRow(address, "failed", message(error)));
    rows.push(outcome);
    report(outcome);
  }
  return { rows, success: rows.every((entry) => entry.outcome !== "refused" && entry.outcome !== "failed") };
}

export const formatMonitorRow = (entry: MonitorRow) => `${entry.seat}  ${entry.outcome}${entry.detail ? `  ${entry.detail}` : ""}`;
