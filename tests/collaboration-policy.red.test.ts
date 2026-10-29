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

test("projection caps each Markdown instruction file at 20 lines and fails closed without changing over-cap user content", async () => {
  const root = await workspace();
  const agents = join(root, "AGENTS.md");
  const claude = join(root, "CLAUDE.md");
  const overCap = `${Array.from({ length: 21 }, (_, index) => `user line ${index + 1}`).join("\n")}\n`;
  await writeFile(agents, overCap, "utf8");
  await writeFile(claude, "user content\n", "utf8");

  await expect(projectCollaborationPolicy(root)).rejects.toThrow("exceeds the 20-line cap");
  expect(await readFile(agents, "utf8")).toBe(overCap);
  expect(await readFile(claude, "utf8")).toBe("user content\n");

  const capped = await workspace();
  await projectCollaborationPolicy(capped);
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    expect((await readFile(join(capped, name), "utf8")).trimEnd().split(/\r?\n/)).toHaveLength(3);
  }
});

test("Pi startup resolves the canonical collaboration policy rather than a duplicated runtime copy", () => {
  const instruction = runtimeStartupInstruction("driver.runtime@demo");
  expect(instruction).toContain("you are driver.runtime@demo");
  expect(instruction).toContain(canonicalCollaborationPolicy());
  expect(instruction).toContain(collaborationConventionPath);
});

test("the canonical policy rejects manual Pi launch and bind routes and the README no longer documents them", async () => {
  const policy = canonicalCollaborationPolicy();
  expect(policy).toContain("atdd-flow pi runtime launch");
  expect(policy).toContain("never start bare pi, run herdr agent start manually, or bind a seat by hand");
  expect(await readFile(join(import.meta.dir, "..", "README.md"), "utf8")).not.toContain("herdr agent start pi-runtime");
});
