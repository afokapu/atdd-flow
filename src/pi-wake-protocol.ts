// URN: component:flow:e004:pi-wake-protocol:backend:domain
// Tested-By:
// - test:atdd-flow:fleet-model-swap-and-wake
// Runtime: bun
// Purpose: Name shared /flow-wake transcript entries and read a transcript's active branch.

export const wakeCapabilityType = "flow-wake-capability/v1";
export const wakeRequestType = "flow-wake-request/v1";
export const wakeResultType = "flow-wake-result/v1";
export const wakeStartType = "atdd-flow-start";
/** Unique per attempt; also the only argument besides an optional portfolio candidate id the extension command accepts. */
export const wakeRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/;

export type TranscriptEntry = {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: string;
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
};

/** A line that is not complete JSON (a transcript being appended to) is ignored rather than trusted. */
export function parseTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) entries.push(value as TranscriptEntry);
    } catch { /* A partial trailing line is never evidence. */ }
  }
  return entries;
}

/** The chain from the most recently appended entry back through its parents, oldest first; abandoned siblings are excluded. */
export function activeBranch(entries: TranscriptEntry[]): TranscriptEntry[] {
  const nodes = entries.filter((entry) => entry.type !== "session" && typeof entry.id === "string");
  const byId = new Map(nodes.map((entry) => [entry.id!, entry]));
  const chain: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let current = nodes.at(-1);
  while (current && !seen.has(current.id!)) {
    seen.add(current.id!);
    chain.push(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return chain.reverse();
}

export const customEntries = (branch: TranscriptEntry[], customType: string) =>
  branch.filter((entry) => (entry.type === "custom" || entry.type === "custom_message") && entry.customType === customType);

/** The latest model selection on the branch, as `provider/model`. */
export function branchModel(branch: TranscriptEntry[]) {
  const change = branch.filter((entry) => entry.type === "model_change" && entry.provider && entry.modelId).at(-1);
  return change ? { provider: change.provider!, model: change.modelId! } : undefined;
}
