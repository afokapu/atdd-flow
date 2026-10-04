import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAcceptedBehavioralReview, behavioralReviewRequired, recordBehavioralReview } from "../src/reviews";
import { done } from "../src/tasks";

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-review-"));
  const repository = join(root, "repository");
  await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "test@example.test");
  await git(repository, "config", "user.name", "Test");
  await writeFile(join(repository, "atdd-bun.yaml"), "profiles: [workflow]\n");
  await writeFile(join(repository, "delivery.txt"), "reviewed\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "delivery");
  const head = await git(repository, "rev-parse", "HEAD");

  await mkdir(join(root, "work", "demo", "seats", "driver.delivery"), { recursive: true });
  await mkdir(join(root, "work", "demo", "tasks"), { recursive: true });
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: tuios\n");
  await writeFile(join(root, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
roles:
  driver:
    address: driver.{name}@{project}
    branch: delivery/{name}
    base: main
`);
  await writeFile(join(root, "work", "demo", "seats", "driver.delivery", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: driver.delivery@demo
role: driver
project: demo
worktree: ${repository}
branch: main
`);
  const task = {
    schema: "atdd-workflow/task/v1" as const,
    title: "Deliver behavior",
    status: "review" as const,
    coordinator: "coordinator@demo",
    assignee: "driver.delivery@demo",
    done_when: [{ text: "Behavior works", proof: "CI run 42" }],
  };
  await writeFile(join(root, "work", "demo", "tasks", "delivery.yaml"), Bun.YAML.stringify(task));
  return { root, repository, head, task };
}

function history(head: string, decision: "APPROVE" | "RETURN" | "ESCALATE") {
  return {
    schema: "atdd-workflow/behavioral-reviews/v1",
    task: "demo/delivery",
    attempts: [{
      id: "R-test",
      status: "complete",
      created_at: "2026-10-04T00:00:00.000Z",
      completed_at: "2026-10-04T00:01:00.000Z",
      delivery_head: head,
      routing: {
        classification: "LOCAL",
        confidence: 0.9,
        signals: {
          behaviorEffect: "BEHAVIOR_AFFECTING",
          proofBoundary: "LOCAL_ACCEPTANCE",
          crossesMultiplePaths: false,
          consequence: "ORDINARY",
          reconciliation: "SINGLE_PATH",
          runtimeObservation: "AVAILABLE",
        },
      },
      reviewer: { address: "reviewer.delivery@demo", model: "economy" },
      convention: { rule_id: "atdd-bun.review.behavioral-reconciliation", path: "/package/convention.yaml" },
      input: {
        task: { title: "Deliver behavior", done_when: [{ text: "Behavior works", proof: "CI run 42" }] },
        plan_artifacts: [],
        deterministic_gates: ["atdd-bun: PASS"],
        executable_proof: ["CI run 42"],
        runtime: { worktree: "/tmp/repo", branch: "main", head },
        implementation: { changed_files: ["delivery.txt"], diff_command: "git diff main...HEAD" },
      },
      result: {
        intent: { sources: ["plan/example.yaml"], expected_behavior: "Behavior works" },
        exercise: { boundary: "local acceptance", evidence: ["CI run 42"] },
        observed: { behavior: "Behavior works" },
        reconciliation: {
          intent_matches_runtime: true,
          proof_matches_intent: true,
          missing_behavior: [],
          unexpected_behavior: [],
          drift: [],
        },
        decision,
        rationale: "Reconciled.",
        confidence: 0.95,
      },
    }],
  };
}

test("Workflow-governed tasks cannot transition review to done without accepted final review", async () => {
  const { root, head, task } = await fixture();
  try {
    expect(await behavioralReviewRequired(root, task)).toBe(true);
    await expect(assertAcceptedBehavioralReview(root, "demo", "delivery", task)).rejects.toThrow("final behavioral review");
    await expect(done(root, "demo", "delivery", ["--by", "coordinator@demo"])).rejects.toThrow("final behavioral review");

    await writeFile(join(root, "work", "demo", "tasks", "delivery.reviews.yaml"), Bun.YAML.stringify(history(head, "APPROVE")));
    await done(root, "demo", "delivery", ["--by", "coordinator@demo"]);
    expect(await readFile(join(root, "work", "demo", "tasks", "delivery.yaml"), "utf8")).toContain("status: done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only APPROVE on the current clean delivery satisfies completion", async () => {
  const { root, repository, head, task } = await fixture();
  try {
    const file = join(root, "work", "demo", "tasks", "delivery.reviews.yaml");
    await writeFile(file, Bun.YAML.stringify(history(head, "RETURN")));
    await expect(assertAcceptedBehavioralReview(root, "demo", "delivery", task)).rejects.toThrow("RETURN");

    await writeFile(file, Bun.YAML.stringify(history(head, "APPROVE")));
    await assertAcceptedBehavioralReview(root, "demo", "delivery", task);

    await writeFile(join(repository, "delivery.txt"), "changed after review\n");
    await expect(assertAcceptedBehavioralReview(root, "demo", "delivery", task)).rejects.toThrow("clean committed delivery");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recording a reviewer result persists evidence without changing task state", async () => {
  const { root, head } = await fixture();
  try {
    const reviewFile = join(root, "work", "demo", "tasks", "delivery.reviews.yaml");
    const pending = history(head, "APPROVE");
    pending.attempts[0].status = "pending";
    delete pending.attempts[0].completed_at;
    delete pending.attempts[0].result;
    await writeFile(reviewFile, Bun.YAML.stringify(pending));

    const resultFile = join(root, "result.yaml");
    await writeFile(resultFile, Bun.YAML.stringify(history(head, "APPROVE").attempts[0].result));
    await recordBehavioralReview(root, "demo", "delivery", ["--by", "reviewer.delivery@demo", "--file", resultFile]);

    const stored = await readFile(reviewFile, "utf8");
    expect(stored).toContain("decision: APPROVE");
    const task = await readFile(join(root, "work", "demo", "tasks", "delivery.yaml"), "utf8");
    expect(task).toContain("status: review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
