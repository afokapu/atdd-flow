// URN: test:atdd-flow:compaction-policy-docs
// Acceptance: acc:flow:E036-UNIT-001
// Phase: UNIT
// Docs/policy text only: pins the operator-approved compaction wording
// (M-20261104T061532Z-t4-wording-approved_999f7ac0). Runtime prompt/behavior is T2/T3.
import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const conventionFile = join(root, "conventions", "atdd-workflow.workflow", "atdd-workflow.workflow.lifecycle.convention.yaml");

const approved = "At 80–90% context, Flow’s primary handover is same-session compaction: validate and record the handover/checkpoint, pass the recovery bundle as the compaction summary, and continue in the same Pi session, JSONL, Herdr pane, and Flow binding. Every seat self-services this primary path. If compaction is unavailable, fails an invariant, or the session is stuck, Flow uses the verified PR #111 new-pane successor path as the fail-closed fallback; operator intervention is fallback-only.";

const flat = (text: string) => text.replace(/\s+/g, " ");

async function documents() {
  const convention = Bun.YAML.parse(await Bun.file(conventionFile).text()) as { content: { normative_text: string } };
  return { convention: flat(convention.content.normative_text), readme: flat(await Bun.file(join(root, "README.md")).text()) };
}

test("RED: lifecycle convention and README carry the operator-approved compaction wording verbatim", async () => {
  const { convention, readme } = await documents();
  expect(convention).toContain(approved);
  expect(readme).toContain(approved);
});

test("RED: the superseded fixed-80% stop-and-replace wording is gone from the convention and README", async () => {
  const { convention, readme } = await documents();
  expect(convention).not.toContain("stops at 80% context usage");
  expect(convention).not.toContain("The old session then makes no further tool calls");
  expect(readme).not.toContain("At 80% context usage a seat writes a structured handover");
});

test("RED: docs state the 80% start, the 90% bound, and that runtime prompt behavior is pending T2/T3", async () => {
  const { convention, readme } = await documents();
  for (const text of [convention, readme]) {
    expect(text).toMatch(/begins? at 80% and no later than 90%/);
    expect(text).toMatch(/runtime prompt and behavior (are|remain) pending (compaction )?T2\/T3/);
  }
});

test("RED: the handover template, validation and RESUMED reporting remain in the convention", async () => {
  const { convention } = await documents();
  expect(convention).toContain("atdd-flow handover <address> --check --file <path>");
  expect(convention).toContain("HANDOVER <seat-address> |");
  expect(convention).toContain("`RESUMED; verified N/M; discrepancies: ...`");
});

test("RED: README labels Path-A replacement as the fail-closed fallback without changing commands", async () => {
  const { readme } = await documents();
  expect(readme).toMatch(/Path-A replacement[^.]*fail-closed fallback/);
  expect(readme).toContain("`handover replace`");
  expect(readme).toContain("--supersede-consumed");
  expect(readme).toContain("No fallback model, relaunch, compaction, seat reassignment, or session replacement exists");
});
