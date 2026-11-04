import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalCollaborationPolicy, collaborationConventionPath, collaborationPolicyPointer, projectCollaborationPolicy, runtimeStartupInstruction } from "../src/collaboration-policy";
import { init, initProject, migrate, spawn } from "../src/seats";
import { post, startThread, status as threadStatus } from "../src/threads";

const start = "<!-- atdd-flow:collaboration-policy:start -->";
const end = "<!-- atdd-flow:collaboration-policy:end -->";
const pointer = collaborationPolicyPointer;
const managed = `${start}\n${pointer}\n${end}\n`;

async function workspace() {
  return mkdtemp(join(tmpdir(), "atdd-flow-collaboration-policy-"));
}

test("projects one byte-identical managed collaboration-policy pointer into both instruction files", async () => {
  const root = await workspace();
  await projectCollaborationPolicy(root);

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    expect(await readFile(join(root, name), "utf8")).toBe(managed);
  }
  expect(canonicalCollaborationPolicy()).toContain("Delegation flows operator → main → named coordinator → driver.");
});

test("projection preserves user content, repairs drift, replaces old blocks, and is idempotent", async () => {
  const root = await workspace();
  const path = join(root, "AGENTS.md");
  await writeFile(path, `# User instructions\n\n${start}\nwrong\n${end}\n\nUser content.\n\n${start}\nstale duplicate\n${end}\n`, "utf8");

  await projectCollaborationPolicy(root);
  const projected = await readFile(path, "utf8");
  expect(projected).toBe(`# User instructions\n\n${managed}\nUser content.\n\n`);
  expect((projected.match(new RegExp(start, "g")) ?? [])).toHaveLength(1);
  expect((projected.match(new RegExp(end, "g")) ?? [])).toHaveLength(1);

  await projectCollaborationPolicy(root);
  expect(await readFile(path, "utf8")).toBe(projected);
  expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(managed);
});

test("Desk init and migration projection create and repair the managed instruction files", async () => {
  const root = await workspace();
  await init(root, "demo", []);
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(managed);
  await writeFile(join(root, "CLAUDE.md"), "user text\n", "utf8");
  await migrate(root);
  expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(`user text\n\n${managed}`);
});

test("an unresolved expects_result remains visible after later thread activity", async () => {
  const root = await workspace();
  await init(root, "demo", []);
  await initProject(root, "demo");
  await spawn(root, "demo", "coordinator", "main", ["--worktree", join(root, "coordinator")]);
  await spawn(root, "demo", "driver", "worker", ["--worktree", join(root, "driver")]);
  const thread = await startThread(root, ["--with", "coordinator@demo,driver.worker@demo", "--subject", "Outstanding request"]);
  const request = await post(root, thread, ["--from", "coordinator@demo", "--to", "driver.worker@demo", "--expects-result", "--body", "Return evidence."]);
  await post(root, thread, ["--from", "coordinator@demo", "--to", "driver.worker@demo", "--body", "Later work occurred."]);

  const output: string[] = [];
  const log = console.log;
  console.log = (line: string) => { output.push(line); };
  try { await threadStatus(root); }
  finally { console.log = log; }
  expect(output.join("\n")).toContain(`waiting:${request}@driver.worker@demo`);
});

test("canonical policy requires inbox-first, task-message, operator-routing, and main-merge custody", () => {
  const policy = canonicalCollaborationPolicy();
  expect(policy).toContain("reconcile their durable inbox as the first action at every session, turn, and task resumption");
  expect(policy).toContain("Messages only communicate, evidence, consensus, authorization, or status");
  expect(policy).toContain("The operator accepts and receipts inbound communication from any seat");
  expect(policy).toContain("Only main@project executes that project repository merge");
});

const seatManagement = "Manage every project main, coordinator, and driver seat only through atdd-flow canonical commands (spawn, bind, pi runtime launch, task lifecycle, handover); start, stop, rebind, or succeed a seat by hand only under explicit owner direction and always complete the supported bind/reconciliation immediately after.";
const lines = (count: number, prefix = "owner line") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
const lineTotal = (text: string) => text ? text.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;

test("S1: canonical policy and runtime startup carry the operator seat-management instruction verbatim", () => {
  expect(canonicalCollaborationPolicy()).toContain(seatManagement);
  expect(runtimeStartupInstruction("driver.runtime@demo")).toContain(seatManagement);
});

test("S2: a long owner file keeps every owner byte and gains only the managed block", async () => {
  const root = await workspace();
  const owner = `${lines(40)}\n`;
  await writeFile(join(root, "AGENTS.md"), owner, "utf8");
  await writeFile(join(root, "CLAUDE.md"), owner, "utf8");

  await projectCollaborationPolicy(root);

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    expect(await readFile(join(root, name), "utf8")).toBe(`${owner}\n${managed}`);
  }
});

test("S2: same-size managed block replacement in a long file preserves all owner bytes outside the markers", async () => {
  const root = await workspace();
  const before = `${lines(30, "before")}\n`;
  const after = `\n${lines(30, "after")}\n`;
  const stale = `${start}\nATDD Flow collaboration policy: stale pointer ${"x".repeat(pointer.length - 33)}\n${end}\n`;
  const path = join(root, "AGENTS.md");
  await writeFile(path, `${before}${stale}${after}`, "utf8");

  await projectCollaborationPolicy(root);
  const projected = await readFile(path, "utf8");
  expect(projected).toBe(`${before}${managed}${after}`);

  await projectCollaborationPolicy(root);
  expect(await readFile(path, "utf8")).toBe(projected);
});

test("S2: empty, whitespace-only and placeholder files never lose owner bytes", async () => {
  const cases: Record<string, string> = {
    empty: "",
    whitespace: "  \t\n\n   ",
    placeholder: "<!-- placeholder: add project instructions -->\n",
    placeholderNoNewline: "TODO",
    ownerSeatLine: `${seatManagement}\n`,
  };
  for (const [label, owner] of Object.entries(cases)) {
    const root = await workspace();
    await writeFile(join(root, "AGENTS.md"), owner, "utf8");
    await writeFile(join(root, "CLAUDE.md"), owner, "utf8");

    await projectCollaborationPolicy(root);
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const projected = await readFile(join(root, name), "utf8");
      expect(projected.includes(managed), label).toBe(true);
      expect(projected.replace(managed, ""), label).toContain(owner);
      expect(projected.startsWith(owner), label).toBe(true);
    }
  }
});

test("S2: the cap bounds only the managed projection delta, never owner content", async () => {
  const root = await workspace();
  const owner = `${lines(500)}\n`;
  await writeFile(join(root, "AGENTS.md"), owner, "utf8");

  await projectCollaborationPolicy(root);
  const projected = await readFile(join(root, "AGENTS.md"), "utf8");
  expect(lineTotal(projected) - lineTotal(owner)).toBeLessThanOrEqual(4);
  expect(projected.split(start)).toHaveLength(2);

  const fresh = await workspace();
  await projectCollaborationPolicy(fresh);
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    expect(lineTotal(await readFile(join(fresh, name), "utf8"))).toBe(3);
  }
});

test("Pi startup resolves the canonical collaboration policy rather than a duplicated runtime copy", () => {
  const instruction = runtimeStartupInstruction("driver.runtime@demo");
  expect(instruction).toContain("you are driver.runtime@demo");
  expect(instruction).toContain(canonicalCollaborationPolicy());
  expect(instruction).toContain(collaborationConventionPath);
});
