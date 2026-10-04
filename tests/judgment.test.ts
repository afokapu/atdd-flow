import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { focusCheck, resolveJevApiKey, reviewCheck, scout, selectModel } from "../src/judgment";

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

test("Jev credentials may come from the local credential source", async () => {
  const original = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    expect(await resolveJevApiKey({ credential: async () => "keychain-test-key" })).toBe("keychain-test-key");
  } finally {
    if (original === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = original;
  }
});


test("review-check keeps closed direct local work on conformance review", async () => {
  const result = await reviewCheck({
    title: "Keep retry behavior stable",
    doneWhen: [{ text: "Retry test passes", proof: "bun test tests/retry.test.ts" }],
  }, { client: { systemOne: async () => response({
    specification: { choice: "CLOSED", confidence: 0.96 },
    evidence: { choice: "DIRECT", confidence: 0.93 },
    escape_risk: { choice: "LOCAL", confidence: 0.91 },
  }) } });
  expect(result).toEqual({
    available: true,
    model: "jev-stub",
    route: "CONFORMANCE",
    confidence: 0.91,
    signals: { specification: "CLOSED", evidence: "DIRECT", escapeRisk: "LOCAL" },
  });
});

test("review-check escalates shared or consequential uncertainty to adversarial review", async () => {
  const result = await reviewCheck({
    title: "Change authorization boundary",
    doneWhen: [{ text: "Authorized callers succeed", proof: "integration suite" }],
  }, { client: { systemOne: async () => response({
    specification: { choice: "CLOSED", confidence: 0.95 },
    evidence: { choice: "DIRECT", confidence: 0.92 },
    escape_risk: { choice: "CROSS_BOUNDARY_OR_HIGH_CONSEQUENCE", confidence: 0.97 },
  }) } });
  expect(result.available).toBe(true);
  if (result.available) expect(result.route).toBe("ADVERSARIAL");
});

test("review-check treats low-confidence classification as residual uncertainty", async () => {
  const result = await reviewCheck({
    title: "Small local change",
    doneWhen: [{ text: "Unit test passes", proof: "test run" }],
  }, { client: { systemOne: async () => response({
    specification: { choice: "CLOSED", confidence: 0.94 },
    evidence: { choice: "DIRECT", confidence: 0.70 },
    escape_risk: { choice: "LOCAL", confidence: 0.91 },
  }) } });
  expect(result.available).toBe(true);
  if (result.available) expect(result.route).toBe("ADVERSARIAL");
});

test("model selection lets Jev choose the weakest sufficient configured candidate", async () => {
  const result = await selectModel({
    seat: { address: "driver.runtime@demo", role: "driver" },
    tasks: [{ id: "retry", title: "Fix retry", status: "in_progress", doneWhen: ["Retry test passes"] }],
    candidates: [
      { id: "strong", executable: "strong-agent" },
      { id: "economy", executable: "economy-agent" },
    ],
  }, { client: { systemOne: async () => response({ model: { choice: "economy", confidence: 0.89 } }) } });
  expect(result).toEqual({ available: true, model: "jev-stub", selected_model: "economy", confidence: 0.89 });
});

test("a one-model portfolio does not spend a Jev call", async () => {
  let called = false;
  const result = await selectModel({
    seat: { address: "driver.runtime@demo", role: "driver" },
    tasks: [],
    candidates: [{ id: "only", executable: "only-agent" }],
  }, { client: { systemOne: async () => { called = true; return response({}); } } });
  expect(result).toEqual({ available: true, selected_model: "only", confidence: 1 });
  expect(called).toBe(false);
});


test("low-confidence model selection escalates instead of trusting a weak choice", async () => {
  const result = await selectModel({
    seat: { address: "driver.runtime@demo", role: "driver" },
    tasks: [{ id: "retry", title: "Fix retry", status: "in_progress", doneWhen: ["Retry test passes"] }],
    candidates: [
      { id: "strong", executable: "strong-agent" },
      { id: "economy", executable: "economy-agent" },
    ],
  }, { client: { systemOne: async () => response({ model: { choice: "economy", confidence: 0.60 } }) } });
  expect(result.available).toBe(false);
  if (!result.available) expect(result.reason).toContain("confidence is low");
});
