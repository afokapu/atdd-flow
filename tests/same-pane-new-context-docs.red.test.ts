// URN: test:atdd-flow:same-pane-new-context-docs
// Acceptance: acc:flow:E041-UNIT-001
// Acceptance: acc:flow:E036-UNIT-001 - historical record retained unchanged; superseded for current policy by E041.
// Phase: UNIT
// Docs/policy text only: pins the owner-directed source-authored handover -> same-pane /new procedure
// (M-20261104T182609Z-owner-decision_ecd3938c; quiescence per M-20261104T194728Z-message_c62c68d2).
// Supersedes the historical acc:flow:E036-UNIT-001 compaction wording. Runtime prompt/behavior and /new verification belong to other tasks.
import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const conventionFile = join(root, "conventions", "atdd-workflow.workflow", "atdd-workflow.workflow.lifecycle.convention.yaml");

const flat = (text: string) => text.replace(/\s+/g, " ");

async function documents() {
  const convention = Bun.YAML.parse(await Bun.file(conventionFile).text()) as { content: { normative_text: string } };
  return { convention: flat(convention.content.normative_text), readme: flat(await Bun.file(join(root, "README.md")).text()) };
}

async function both() {
  const { convention, readme } = await documents();
  return [convention, readme];
}

test("RED: compaction-primary wording and the 80-90% range are gone from the convention and README", async () => {
  for (const text of await both()) {
    expect(text).not.toContain("primary handover is same-session compaction");
    expect(text).not.toContain("pass the recovery bundle as the compaction summary");
    expect(text).not.toContain("80–90%");
    expect(text).not.toMatch(/pending compaction T2\/T3/);
    expect(text).not.toContain("fail-closed fallback");
  }
});

test("RED: the ~80% source-authored handover then /new in the same bound pane and Pi process is stated", async () => {
  for (const text of await both()) {
    expect(text).toMatch(/~80%|about 80%/);
    expect(text).toMatch(/source[- ](seat )?(writes|authors)[^.]*handover/i);
    expect(text).toContain("`/new`");
    expect(text).toMatch(/same bound pane and Pi process/);
    expect(text).toMatch(/unexecuted message IDs/);
    expect(text).toMatch(/`atdd-flow handover show <address>`/);
  }
});

test("RED: the source reaches a quiescent point and records head, remote push state and pending writes", async () => {
  for (const text of await both()) {
    expect(text).toMatch(/quiescen/);
    for (const inflight of ["push", "rebase", "review submission", "test run"]) expect(text).toContain(inflight);
    expect(text).toMatch(/exact branch(\/bookmark)? head/);
    expect(text).toMatch(/remote push state/);
    expect(text).toMatch(/pending write/);
  }
});

test("RED: the fresh context re-verifies remote state before any push", async () => {
  for (const text of await both()) expect(text).toMatch(/re-verif[^.]*remote state before any push/);
});

test("RED: a third-party-authored handover is only for a source past its window and is unverified", async () => {
  for (const text of await both()) {
    expect(text).toMatch(/past its (context )?window/);
    expect(text).toMatch(/coordinator-authored[^.]*unverified|unverified[^.]*coordinator-authored/);
  }
});

test("RED: docs make no claim that /new is a verified transition until the verifier releases", async () => {
  for (const text of await both()) {
    expect(text).toMatch(/not (yet )?(a )?verified[^.]*same-pane-new-context-verifier-20261104|same-pane-new-context-verifier-20261104[^.]*releas/);
    expect(text).toMatch(/no (`?handover resumed`?, )?bind, launch, pane change, or compaction|without[^.]*bind, launch, pane change/);
  }
});

test("RED: the handover template, validation, RESUMED reporting and Path-A commands remain documented", async () => {
  const { convention, readme } = await documents();
  expect(convention).toContain("atdd-flow handover <address> --check --file <path>");
  expect(convention).toContain("HANDOVER <seat-address> |");
  expect(convention).toContain("`RESUMED; verified N/M; discrepancies: ...`");
  expect(readme).toContain("`handover replace`");
  expect(readme).toContain("--supersede-consumed");
  expect(readme).toContain("No fallback model, relaunch, compaction, seat reassignment, or session replacement exists");
});

test("RED: the historical E036 record is retained and E041 explicitly supersedes it", async () => {
  const historical = await Bun.file(join(root, "plan", "flow", "E036.yaml")).text();
  expect(historical).toContain("urn: acc:flow:E036-UNIT-001");
  expect(historical).toContain("same-session compaction");
  const current = await Bun.file(join(root, "plan", "flow", "E041.yaml")).text();
  expect(current).toMatch(/supersedes the historical\s+acc:flow:E036-UNIT-001/);
});
