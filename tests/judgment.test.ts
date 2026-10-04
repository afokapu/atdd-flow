import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { focusCheck, scout } from "../src/judgment";

const response = (answers: Record<string, { choice: string; confidence: number }>) => ({ model: "jev-stub", answers });

test("scout returns read-only relevance judgments for candidate files", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-judgment-"));
  try {
    const relevant = join(root, "retry.ts");
    const unrelated = join(root, "avatar.ts");
    await writeFile(relevant, "export const retry = () => undefined;\n");
    await writeFile(unrelated, "export const avatar = () => undefined;\n");
    const before = await readFile(relevant, "utf8");
    const result = await scout({ goal: "Fix payment retry behavior", candidates: [relevant, unrelated] }, {
      client: { systemOne: async () => response({
        candidate_0: { choice: "relevant", confidence: 0.98 },
        candidate_1: { choice: "not_relevant", confidence: 0.08 },
      }) },
    });
    expect(result).toEqual({
      available: true,
      model: "jev-stub",
      results: [
        { path: relevant, relevance: "relevant", confidence: 0.98 },
        { path: unrelated, relevance: "not_relevant", confidence: 0.08 },
      ],
    });
    expect(await readFile(relevant, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("focus-check returns one bounded scope judgment without changing state", async () => {
  const result = await focusCheck({
    title: "Fix payment retry behavior",
    body: "Keep the existing provider contract.",
    doneWhen: ["Retry test passes"],
    proposedAction: "Add a generic retry orchestration service.",
  }, { client: { systemOne: async () => response({ scope: { choice: "SPECULATIVE", confidence: 0.94 } }) } });
  expect(result).toEqual({ available: true, model: "jev-stub", judgment: "SPECULATIVE", confidence: 0.94 });
});

test("judgment helper failures remain non-blocking", async () => {
  const result = await focusCheck({
    title: "Fix retry behavior", doneWhen: ["Test passes"], proposedAction: "Add a dependency",
  }, { client: { systemOne: async () => { throw new Error("provider unavailable"); } } });
  expect(result.available).toBe(false);
  if (!result.available) expect(result.reason).toContain("provider unavailable");
});
