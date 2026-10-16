// URN: component:flow:e004:seat-recovery-fixtures:backend:integration
// Tested-By:
// - test:atdd-flow:seat-recovery-bundle
// - test:atdd-flow:seat-recovery-injection
// Runtime: bun
// Purpose: Build throwaway Desk, git and Pi-session fixtures for recovery tests.

import { afterEach } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml } from "../src/core";

// Contract under test (RED): a pure read-only `recoveryBundle(root, seat, { sessionPath?, now? })` renders <=50 lines / <=5KB.
// Line shapes: "RECOVERY BUNDLE <seat> | <iso>", then "<field>: ..." lines, "task <id> ...", "inbound|outbound <id> <from> -> <to> <age>",
// "recent <message-id> <thread subject>". Any unreadable source renders "<field>: unavailable (<reason>)".

export const now = new Date("2026-10-15T12:00:00.000Z");
export const seat = "driver.pi@demo";
export const session = "01a12345-6789-7abc-8def-0123456789ab";
export const cleanups: string[] = [];
export const originalPath = process.env.PATH;
export const savedEnv = ["ATDD_WORKFLOW_ROOT", "ATDD_WORKFLOW_SEAT", "ATDD_FLOW_PI_SESSION", "ATDD_FLOW_HERDR_SESSION", "ATDD_FLOW_HERDR_PANE"].map((name) => [name, process.env[name]] as const);

/** Every test file calls this once so temp dirs, PATH and Flow env are restored after each test. */
export function installCleanup() {
  afterEach(async () => {
    process.env.PATH = originalPath;
    for (const [name, value] of savedEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
}

/** A uniquely named temp directory removed after the test. */
export async function temp(label: string) {
  const path = await mkdtemp(join(tmpdir(), `atdd-seat-recovery-${label}-`));
  cleanups.push(path);
  return path;
}

/** Runs git with a fixed identity and unsigned commits; throws on non-zero exit. */
export function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (result.exitCode) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** One pushed commit, one local unpushed commit, one dirty tracked file and one untracked file. */
export async function repository(base: string, extraUntracked = 0) {
  const origin = join(base, "origin.git");
  const worktree = join(base, "wt");
  git(base, "init", "--bare", "--initial-branch=main", origin);
  git(base, "clone", origin, worktree);
  git(worktree, "checkout", "-B", "main");
  await writeFile(join(worktree, "a.txt"), "one\n");
  git(worktree, "add", "."); git(worktree, "commit", "-m", "first"); git(worktree, "push", "-u", "origin", "main");
  await writeFile(join(worktree, "b.txt"), "two\n");
  git(worktree, "add", "."); git(worktree, "commit", "-m", "second");
  await writeFile(join(worktree, "a.txt"), "dirty\n");
  await writeFile(join(worktree, "new.txt"), "untracked\n");
  for (let index = 0; index < extraUntracked; index += 1) await writeFile(join(worktree, `extra-${String(index).padStart(3, "0")}.txt`), "x\n");
  git(worktree, "status", "--porcelain");
  return worktree;
}

/** Puts a stub `gh` first on PATH so PR/CI reads are deterministic and offline. */
export async function fakeGh(base: string, script: string) {
  const bin = join(base, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "gh"), `#!/bin/sh\n${script}\n`);
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
}

export const prJson = JSON.stringify({
  number: 42, state: "OPEN", url: "https://example.test/pr/42",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }, { status: "IN_PROGRESS", conclusion: "" }],
});

/** Minimal Desk with one project named demo. */
export async function desk(root: string) {
  await atomicYaml(join(root, "desk.yaml"), { schema: "atdd-workflow/desk/v1", desk: "test", application: "herdr" });
  await atomicYaml(join(root, "work", "demo", "project.yaml"), { schema: "atdd-workflow/project/v1", project: "demo" });
  await mkdir(join(root, "threads"), { recursive: true });
}

/** Writes seat.yaml for an address, optionally with a recorded runtime. */
export async function seatRecord(root: string, address: string, worktree: string, runtime?: Record<string, unknown>) {
  const local = address.split("@")[0]!;
  await atomicYaml(join(root, "work", "demo", "seats", local, "seat.yaml"), {
    schema: "atdd-workflow/seat/v2", address, role: local.startsWith("driver") ? "driver" : local === "main" ? "main" : "coordinator", project: "demo", worktree, branch: "main",
    ...(runtime ? { runtime } : {}),
  });
}

/** Writes one task record; fields override the in-progress driver default. */
export async function task(root: string, id: string, fields: Record<string, unknown>) {
  await atomicYaml(join(root, "work", "demo", "tasks", `${id}.yaml`), {
    schema: "atdd-workflow/task/v1", title: `Task ${id}`, status: "in_progress", coordinator: "main@demo", assignee: seat, done_when: [{ text: "Done." }], ...fields,
  });
}

/** Writes one open thread record. */
export async function thread(root: string, id: string, subject: string, participants = ["main@demo", seat]) {
  await atomicYaml(join(root, "threads", id, "thread.yaml"), { schema: "atdd-workflow/thread/v1", id, participants, subject, state: "open" });
}

/** Writes one message record into a thread. */
export async function message(root: string, threadId: string, id: string, fields: Record<string, unknown>) {
  await atomicYaml(join(root, "threads", threadId, `${id}.yaml`), {
    schema: "atdd-workflow/message/v1", id, kind: "message", created_at: "2026-10-15T00:00:00.000Z", body: "body", ...fields,
  });
}

/** Serialises session entries as JSON lines. */
export function jsonl(entries: unknown[]) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
export const call = (id: string, command: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] } });
export const outcome = (id: string, isError: boolean, text: string) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "bash", isError, content: [{ type: "text", text }] } });

/** Writes a fake Pi session JSONL file and returns its path. */
export async function sessionFile(base: string, entries: unknown[], name = "2026-10-14T10-00-00-000Z_old.jsonl") {
  const path = join(base, "sessions", name);
  await mkdir(join(base, "sessions"), { recursive: true });
  await writeFile(path, jsonl(entries));
  return path;
}

export const lines = (bundle: string) => bundle.split("\n");
export const field = (bundle: string, prefix: string) => lines(bundle).find((line) => line.startsWith(prefix));

/** Recursive path:mtime:content-hash listing used to prove nothing was written. */
export async function snapshot(path: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) out.push(...await snapshot(full));
    else out.push(`${full}:${(await stat(full)).mtimeMs}:${Bun.hash(await readFile(full))}`);
  }
  return out;
}

/** Full Desk + checkpoint + threads + git fixture used by the field-completeness tests. */
export async function populated() {
  const base = await temp("full");
  const root = join(base, "desk");
  const worktree = await repository(base);
  const sessionPath = await sessionFile(base, [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "TRANSCRIPT-SECRET narrative" }] } },
    call("c1", "bun test tests/old.test.ts"), outcome("c1", true, "1 fail\nexited with code 1"),
    call("c2", "ls -la"), outcome("c2", false, "files"),
    call("c3", "bun run check"), outcome("c3", false, "all good"),
    call("c4", "echo done"), outcome("c4", false, "done"),
  ]);
  await desk(root);
  await seatRecord(root, seat, worktree, {
    application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, pi_session: session, pi_session_path: sessionPath,
  });
  await seatRecord(root, "main@demo", base);
  await atomicYaml(join(root, "work", "demo", "seats", "driver.pi", "checkpoint.yaml"), {
    schema: "atdd-workflow/checkpoint/v1", seat, status: "active", updated_at: "2026-10-15T10:00:00.000Z", summary: "Halfway through RED tests", next_action: "Finish RED",
  });
  await task(root, "alpha", {
    phase: "red", handoff: { state: "awaiting_coordinator", evidence: "M-red-ev", updated_at: "2026-10-15T09:00:00.000Z" },
    blocker: "waiting on owner", depends_on: ["dep-task"], done_when: [{ text: "A", proof: "p" }, { text: "B" }],
  });
  await task(root, "dep-task", { status: "todo", assignee: "main@demo" });
  await task(root, "finished-task", { status: "done", done_when: [{ text: "A", proof: "p" }] });
  await thread(root, "T-1", "Subject One");
  await message(root, "T-1", "M-in1", { from: "main@demo", to: [seat], expects_result: true, created_at: "2026-10-12T12:00:00.000Z" });
  await message(root, "T-1", "M-out1", { from: seat, to: ["main@demo"], expects_result: true, created_at: "2026-10-14T12:00:00.000Z" });
  await message(root, "T-1", "M-ans", { from: "main@demo", to: [seat], expects_result: true, created_at: "2026-10-13T12:00:00.000Z" });
  await message(root, "T-1", "M-ans-r", { from: seat, to: ["main@demo"], kind: "result", in_reply_to: "M-ans", created_at: "2026-10-13T13:00:00.000Z" });
  await thread(root, "T-2", "Own Thread");
  for (let index = 1; index <= 6; index += 1) {
    await message(root, "T-2", `M-own-${index}`, { from: seat, to: ["main@demo"], body: `SECRETBODY-${index}`, created_at: `2026-10-15T0${index}:30:00.000Z` });
  }
  await fakeGh(base, `echo '${prJson}'`);
  return { base, root, worktree, sessionPath };
}

