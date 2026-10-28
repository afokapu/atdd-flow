// URN: test:atdd-flow:fleet-model-swap-and-wake
// Acceptance: acc:flow:E004-UNIT-001
// Phase: UNIT
import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, modelPortfolio, paths } from "../src/core";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const session = "01a12345-6789-7abc-8def-0123456789ab";
type SeatSpec = {
  name: string;
  status?: string;
  capability?: boolean;
  retired?: boolean;
  task?: "active" | "done" | "none";
  agent?: boolean;
  pid?: number;
};
type Fixture = {
  root: string;
  bin: string;
  log: string;
  state: string;
  runtimeFile: (name: string) => string;
  transcript: (name: string) => string;
  run: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
};

const entry = (type: string, id: string, parentId: string | null, value: Record<string, unknown>) =>
  JSON.stringify({ type, id, parentId, timestamp: "2026-10-16T03:00:00.000Z", ...value });
async function fixture(specs: SeatSpec[], mode = "complete"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "atdd-pi-wake-red-"));
  const bin = join(root, "bin"), log = join(root, "herdr.log"), state = join(root, "herdr-state.json");
  await Bun.write(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await atomicYaml(paths(root).models, {
    schema: "atdd-workflow/models/v1",
    models: [
      { id: "source", executable: "pi", args: ["--provider", "old", "--model", "source"] },
      { id: "target", executable: "pi", args: ["--provider", "new", "--model", "exact"], enabled: true },
      { id: "disabled", executable: "pi", args: ["--provider", "new", "--model", "disabled"], enabled: false },
    ],
    model_migrations: { restore: { "old/source": "target" } },
  });

  const observations: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index]!, address = `driver.${spec.name}@demo`, pane = `w1:p${index + 1}`;
    const cwd = join(root, "worktrees", spec.name), transcript = join(root, `${spec.name}_${session}.jsonl`), pid = spec.pid ?? 5000 + index;
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: session, timestamp: "2026-10-16T03:00:00.000Z", cwd }),
      entry("model_change", `${spec.name}-model`, null, { provider: "old", modelId: "source" }),
      // A newer raw orphan must not override the selected parent chain.
      entry("model_change", `${spec.name}-orphan`, `${spec.name}-model`, { provider: "wrong", modelId: "orphan" }),
      entry("thinking_level_change", `${spec.name}-thinking`, `${spec.name}-model`, { thinkingLevel: "high" }),
    ];
    if (spec.capability !== false) lines.push(entry("custom", `${spec.name}-capability`, `${spec.name}-thinking`, {
      customType: "flow-wake-capability/v1", data: { seat: address, pi_session: session, pane },
    }));
    await writeFile(transcript, `${lines.join("\n")}\n`);
    await atomicYaml(paths(root).seatFile(address), {
      schema: "atdd-workflow/seat/v2", address, role: "driver", project: "demo", worktree: cwd, branch: `delivery/${spec.name}`,
      runtime: { application: "herdr", wake: "native", addresses: { herdr: { session: "forge", pane } }, pi_session: session, pi_session_path: transcript },
      ...(spec.retired ? { retired: { task: "old", completed_at: "2026-10-16T02:00:00.000Z", summary: "done" } } : {}),
    });
    const taskState = spec.task ?? "active";
    if (taskState !== "none") await atomicYaml(paths(root).taskFile("demo", spec.name), {
      schema: "atdd-workflow/task/v1", title: spec.name, status: taskState === "done" ? "done" : "in_progress",
      coordinator: "main@demo", assignee: address, done_when: [{ text: "wake" }],
    });
    const runtimeFile = join(root, ".atdd-flow", "pi-runtime", `${encodeURIComponent(address)}.yaml`);
    await atomicYaml(runtimeFile, {
      schema: "atdd-flow/pi-runtime-state/v1", seat: address, owner_token: `owner-${spec.name}`, pid,
      model: "source", cwd, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
    });
    observations[pane] = { address, pane, cwd, transcript, pid, status: spec.status ?? "idle", agent: spec.agent === false ? null : "pi" };
  }
  await writeFile(state, JSON.stringify({ mode, observations }));
  await writeFile(log, "");
  await Bun.write(join(root, "fake-herdr.ts"), `#!/usr/bin/env bun
import { appendFile, readFile } from "node:fs/promises";
const args = process.argv.slice(2), state = JSON.parse(await readFile(process.env.FAKE_HERDR_STATE!, "utf8"));
await appendFile(process.env.FAKE_HERDR_LOG!, args.join(" ") + "\\n");
const promptAt = args.indexOf("prompt"), getAt = args.indexOf("get"), paneAt = args.indexOf("--pane");
const pane = promptAt >= 0 ? args[promptAt + 1] : paneAt >= 0 ? args[paneAt + 1] : getAt >= 0 ? args[getAt + 1] : "";
const observed = state.observations[pane];
const print = (value: unknown) => process.stdout.write(JSON.stringify({ id: "fake", result: value }));
if (!observed) { print({}); process.exit(0); }
if (promptAt >= 0) {
  const text = args.slice(promptAt + 2).join(" ");
  if (text === "/reload") {
    if (state.mode !== "no-capability") await appendFile(observed.transcript, JSON.stringify({ type: "custom", id: "reload-capability", parentId: observed.address.split("@")[0].split(".")[1] + "-thinking", timestamp: new Date().toISOString(), customType: "flow-wake-capability/v1", data: { seat: observed.address, pi_session: ${JSON.stringify(session)}, pane } }) + "\\n");
  } else if (text.startsWith("/flow-wake ")) {
    const words = text.split(/\\s+/), requestId = words.at(-1), candidate = words.length === 3 ? words[1] : undefined;
    const raw = (await readFile(observed.transcript, "utf8")).trim().split("\\n").map(JSON.parse), parent = raw.at(-1).id;
    await appendFile(observed.transcript, JSON.stringify({ type: "custom", id: "request-" + requestId, parentId: parent, timestamp: new Date().toISOString(), customType: "flow-wake-request/v1", data: { request_id: requestId, seat: observed.address, pi_session: ${JSON.stringify(session)}, pane, candidate, source: { provider: "old", model: "source", thinking: "high" } } }) + "\\n");
    if (state.mode !== "partial") {
      const modelParent = "request-" + requestId;
      if (candidate) await appendFile(observed.transcript, JSON.stringify({ type: "model_change", id: "changed-" + requestId, parentId: modelParent, timestamp: new Date().toISOString(), provider: "new", modelId: "exact" }) + "\\n");
      const resultParent = candidate ? "changed-" + requestId : modelParent;
      await appendFile(observed.transcript, JSON.stringify({ type: "custom", id: "result-" + requestId, parentId: resultParent, timestamp: new Date().toISOString(), customType: "flow-wake-result/v1", data: { request_id: requestId, outcome: candidate ? "swapped+woke" : "woke", target: candidate ? { provider: "new", model: "exact", thinking: "high" } : { provider: "old", model: "source", thinking: "high" } } }) + "\\n");
      await appendFile(observed.transcript, JSON.stringify({ type: "custom_message", id: "startup-" + requestId, parentId: "result-" + requestId, timestamp: new Date().toISOString(), customType: "atdd-flow-start", content: "recovery plus authoritative next action", display: true, details: { request_id: requestId, wake: true } }) + "\\n");
    }
  }
  print({ accepted: true }); process.exit(0);
}
const agent = observed.agent ? { agent: observed.agent, agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: observed.transcript }, agent_status: observed.status, cwd: observed.cwd, foreground_cwd: observed.cwd, interactive_ready: true, pane_id: pane } : null;
if (args.includes("agent") && getAt >= 0) print({ agent, type: "agent_info" });
else if (args.includes("pane") && getAt >= 0) print({ pane: agent && { ...agent, label: observed.address }, type: "pane_info" });
else if (args.includes("process-info")) print({ process_info: { foreground_process_group_id: observed.pid, foreground_processes: observed.agent ? [{ argv0: "pi", cwd: observed.cwd, name: "node", pid: observed.pid }] : [], pane_id: pane }, type: "pane_process_info" });
else print({});
`);
  await chmod(join(root, "fake-herdr.ts"), 0o755);
  await Bun.write(join(bin, "herdr"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "fake-herdr.ts"))} "$@"\n`);
  await chmod(join(bin, "herdr"), 0o755);

  return {
    root, bin, log, state,
    runtimeFile: (name) => join(root, ".atdd-flow", "pi-runtime", `${encodeURIComponent(`driver.${name}@demo`)}.yaml`),
    transcript: (name) => join(root, `${name}_${session}.jsonl`),
    async run(...args) {
      const child = Bun.spawn([process.execPath, cli, "--root", root, ...args], {
        cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_HERDR_STATE: state, FAKE_HERDR_LOG: log, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, stdout, stderr };
    },
  };
}

async function absent(path: string) {
  return stat(path).then(() => false, () => true);
}

test("RED: models.yaml validates named migrations and exact enabled unambiguous Pi targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-model-migration-red-"));
  try {
    const write = (value: unknown) => atomicYaml(paths(root).models, { schema: "atdd-workflow/models/v1", models: [
      { id: "good", executable: "pi", args: ["--provider", "new", "--model", "exact"] },
      { id: "disabled", executable: "pi", args: ["--provider", "new", "--model", "off"], enabled: false },
      { id: "ambiguous", executable: "pi", args: ["--provider", "one", "--provider", "two", "--model", "same"] },
    ], ...value });
    await write({ model_migrations: { restore: { "old/source": "good" } } });
    expect((await modelPortfolio(root) as unknown as { model_migrations: object }).model_migrations).toEqual({ restore: { "old/source": "good" } });
    for (const [label, target] of [["dangling", "missing"], ["disabled", "disabled"], ["ambiguous", "ambiguous"]]) {
      await write({ model_migrations: { restore: { "old/source": target } } });
      await expect(modelPortfolio(root), label).rejects.toThrow();
    }
    await write({ model_migrations: { "": { "old/source": "good" } } });
    await expect(modelPortfolio(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RED: CLI help exposes the closed fleet wake grammar", async () => {
  const subject = await fixture([{ name: "idle" }]);
  try {
    const result = await subject.run("--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pi wake <seat>|--scope project|desk [--model-profile <name>] --by <authorized-seat>");
  } finally { await rm(subject.root, { recursive: true, force: true }); }
});

test("RED: exact-capability single-seat swap uses transcript entries and leaves Desk/runtime/repository state untouched", async () => {
  const subject = await fixture([{ name: "idle" }]);
  try {
    const beforeRuntime = await readFile(subject.runtimeFile("idle"), "utf8");
    const result = await subject.run("pi", "wake", "driver.idle@demo", "--model-profile", "restore", "--by", "operator@desk");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("driver.idle@demo  swapped+woke");
    const calls = await readFile(subject.log, "utf8");
    expect(calls).toContain("agent prompt w1:p1 /flow-wake target ");
    expect(calls).not.toContain("agent prompt w1:p1 /reload");
    expect(await readFile(subject.runtimeFile("idle"), "utf8")).toBe(beforeRuntime);
    expect(await absent(join(subject.root, ".atdd-flow", "pi-wake"))).toBe(true);
    const transcript = await readFile(subject.transcript("idle"), "utf8");
    expect(transcript).toContain('"customType":"flow-wake-request/v1"');
    expect(transcript).toContain('"provider":"new","modelId":"exact"');
    expect(transcript).toContain('"customType":"flow-wake-result/v1"');
    expect(transcript).toContain('"customType":"atdd-flow-start"');
  } finally { await rm(subject.root, { recursive: true, force: true }); }
});

test("RED: bootstrap sends reload only at idle/done and waits for fresh capability before flow-wake", async () => {
  const success = await fixture([{ name: "idle", capability: false, status: "done" }]);
  try {
    const result = await success.run("pi", "wake", "driver.idle@demo", "--by", "operator@desk");
    expect(result.code, result.stderr).toBe(0);
    const calls = (await readFile(success.log, "utf8")).split("\n").filter((line) => line.includes("agent prompt"));
    expect(calls[0]).toContain("/reload");
    expect(calls[1]).toMatch(/\/flow-wake [^ ]+$/);
  } finally { await rm(success.root, { recursive: true, force: true }); }

  const refused = await fixture([{ name: "idle", capability: false }], "no-capability");
  try {
    const result = await refused.run("pi", "wake", "driver.idle@demo", "--by", "operator@desk");
    expect(result.code).not.toBe(0);
    const calls = await readFile(refused.log, "utf8");
    expect(calls.match(/\/reload/g)).toHaveLength(1);
    expect(calls).not.toContain("/flow-wake");
  } finally { await rm(refused.root, { recursive: true, force: true }); }
});

test("RED: project fleet classifies safe boundaries and dispatches eligible seats sequentially", async () => {
  const subject = await fixture([
    { name: "alpha", status: "idle" }, { name: "bravo", status: "done" }, { name: "working", status: "working", capability: false },
    { name: "blocked", status: "blocked" }, { name: "question", status: "question" }, { name: "retired", retired: true },
    { name: "terminal", task: "done" }, { name: "noagent", agent: false },
  ]);
  try {
    const result = await subject.run("pi", "wake", "--scope", "project", "--by", "main@demo");
    expect(result.code).not.toBe(0); // refused rows make the compact fleet command non-zero
    expect(result.stdout).toContain("driver.alpha@demo  woke");
    expect(result.stdout).toContain("driver.bravo@demo  woke");
    expect(result.stdout).toContain("driver.working@demo  deferred");
    expect(result.stdout).toContain("driver.blocked@demo  refused");
    expect(result.stdout).toContain("driver.question@demo  refused");
    expect(result.stdout).toContain("driver.retired@demo  skipped");
    expect(result.stdout).toContain("driver.terminal@demo  skipped");
    expect(result.stdout).toContain("driver.noagent@demo  skipped");
    const prompts = (await readFile(subject.log, "utf8")).split("\n").filter((line) => line.includes("agent prompt"));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("w1:p1");
    expect(prompts[1]).toContain("w1:p2");
  } finally { await rm(subject.root, { recursive: true, force: true }); }
});

test("RED: stale and partial sessions fail closed without retry or unauthorized grammar fallback", async () => {
  const partial = await fixture([{ name: "idle" }], "partial");
  try {
    const result = await partial.run("pi", "wake", "driver.idle@demo", "--model-profile", "restore", "--by", "operator@desk");
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("driver.idle@demo  failed");
    expect((await readFile(partial.log, "utf8")).match(/\/flow-wake/g)).toHaveLength(1);
  } finally { await rm(partial.root, { recursive: true, force: true }); }

  const stale = await fixture([{ name: "idle" }]);
  try {
    const state = Bun.YAML.parse(await readFile(stale.runtimeFile("idle"), "utf8"));
    await atomicYaml(stale.runtimeFile("idle"), { ...state, pid: 9999 });
    const result = await stale.run("pi", "wake", "driver.idle@demo", "--by", "operator@desk");
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("driver.idle@demo  refused");
    expect(await readFile(stale.log, "utf8")).not.toContain("agent prompt");
  } finally { await rm(stale.root, { recursive: true, force: true }); }

  const grammar = await fixture([{ name: "idle" }]);
  try {
    for (const args of [
      ["pi", "wake", "driver.idle@demo", "--scope", "desk", "--by", "operator@desk"],
      ["pi", "wake", "--scope", "desk", "--by", "main@demo"],
      ["pi", "wake", "driver.idle@demo", "--model-profile", "missing", "--by", "operator@desk"],
      ["pi", "wake", "driver.idle@demo", "--wat", "x", "--by", "operator@desk"],
    ]) expect((await grammar.run(...args)).code, args.join(" ")).not.toBe(0);
    expect(await readFile(grammar.log, "utf8")).not.toContain("agent prompt");
  } finally { await rm(grammar.root, { recursive: true, force: true }); }
});
