// URN: component:flow:e004:collaboration-policy:backend:application
// Tested-By:
// - test:atdd-flow:seat-recovery-bundle
// Runtime: bun
// Purpose: Define the project collaboration policy and its startup instruction.

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const collaborationConventionPath = "conventions/atdd-flow.collaboration/atdd-flow.collaboration.convention.yaml";
const startMarker = "<!-- atdd-flow:collaboration-policy:start -->";
const endMarker = "<!-- atdd-flow:collaboration-policy:end -->";
export const collaborationPolicyPointer = `ATDD Flow collaboration policy: node_modules/@afokapu/atdd-flow/${collaborationConventionPath} (source checkout: ${collaborationConventionPath})`;

type Convention = { content?: { canonical_policy?: unknown } };

/** Pi loads extensions through Node/jiti, where Bun's import.meta.dir is undefined. */
const sourceDirectory = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

function conventionFile() {
  return join(sourceDirectory, "..", collaborationConventionPath);
}

/** The convention is the sole policy text; projections and runtimes resolve it from here. */
export function canonicalCollaborationPolicy() {
  const convention = parse(readFileSync(conventionFile(), "utf8")) as Convention;
  const policy = convention.content?.canonical_policy;
  if (typeof policy !== "string" || !policy.trim()) throw new Error("Collaboration convention requires content.canonical_policy.");
  return policy.trim();
}

function block() {
  return `${startMarker}\n${collaborationPolicyPointer}\n${endMarker}\n`;
}

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const existingBlock = new RegExp(`${escaped(startMarker)}\\r?\\n[\\s\\S]*?${escaped(endMarker)}(?:\\r?\\n)?`, "g");

/** Replaces every prior managed block with one canonical pointer while retaining all other bytes. */
export function projectCollaborationPolicyText(source: string) {
  const matches = [...source.matchAll(existingBlock)];
  if (matches.length) {
    const first = matches[0]!;
    const before = source.slice(0, first.index);
    const after = source.slice((first.index ?? 0) + first[0].length).replace(existingBlock, "");
    return `${before}${block()}${after}`;
  }
  if (!source) return block();
  return `${source}${source.endsWith("\n") ? "\n" : "\n\n"}${block()}`;
}

function lineCount(text: string) {
  return text ? text.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;
}

/** Idempotently projects the canonical pointer while preserving user content and refusing oversized instruction files. */
export async function projectCollaborationPolicy(root: string) {
  const projections = await Promise.all(["AGENTS.md", "CLAUDE.md"].map(async (name) => {
    const file = join(root, name);
    let source = "";
    try { source = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { name, file, source, next: projectCollaborationPolicyText(source) };
  }));
  for (const { name, source, next } of projections) {
    if (lineCount(source) > 20 || lineCount(next) > 20) {
      throw new Error(`${name} exceeds the 20-line cap; refusing projection without changing user content.`);
    }
  }
  await Promise.all(projections.map(async ({ file, source, next }) => {
    if (next !== source) await writeFile(file, next, "utf8");
  }));
}

const withBundle = (text: string, bundle?: string) => bundle ? `${text}\n${bundle}` : text;

/** The one startup handoff for supported Flow-managed runtimes, resolved from the canonical convention. */
export function runtimeStartupInstruction(seat: string, bundle?: string) {
  return withBundle(`SYSTEM: you are ${seat}. Collaboration policy: ${canonicalCollaborationPolicy()} Canonical convention: ${collaborationConventionPath}. Read your durable seat and assigned work with: atdd-flow open ${seat}. Continue assigned in_progress work until it is review-ready or explicitly blocked.`, bundle);
}

/** The 80% handover prompt; the computed bundle gives the handover record exact current state. */
export function handoverThresholdInstruction(percent: number, threshold: number, bundle?: string) {
  return withBundle(`SYSTEM: Context ${percent}% reached the Flow handover threshold (${threshold}%). Finish or undo the atomic step, record a validated handover, then stop new work; do not compact or release a session.`, bundle);
}

/** The Path-A successor prompt; the bundle points at the predecessor session file. */
export function successorInstruction(seat: string, handoverId: string, bundle?: string) {
  return withBundle(`SYSTEM: Path-A handover ${handoverId} is injected for ${seat}. Read atdd-flow handover show ${seat}, reconcile the live Desk, then report RESUMED with verified/total counts and discrepancies.`, bundle);
}
