// URN: test:flow:dos-supersession-launch-eligibility
// Acceptance: acc:flow:E006-RED-001
// Phase: E2E
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { handoverReplacementPath, replacementForMainLaunch, type HandoverReplacementRequest } from "../src/handover";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const project = "dos-play", address = `main@${project}`;
const sourceSession = "c3c6a761-c15d-4b27-8894-6e4ac44ddcad";
const sourcePath = `/Users/alecfokapu/.pi/agent/sessions/dos-play/source_${sourceSession}.jsonl`;
const takeoverTask = "main-successor-checkpoint-fresh-20261020";
const pane = "w2K:p2", herdrSession = "forge", cwd = "/Users/alecfokapu/Github/dos-play";
const repositoryHead = "d2c2cc668f46420ea22c1ad25458c79f508a7ac6";
const roots: string[] = [];

async function invokeAtRoot(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ATDD_WORKFLOW_ROOT: root, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

function fakeHerdr(root: string, occupied: boolean) {
  const state = join(root, "herdr-state.json");
  const executable = join(root, "bin", "herdr");
  const script = `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2), operation = args.slice(2);
const stateFile = ${JSON.stringify(state)}, root = ${JSON.stringify(root)};
const cwd = ${JSON.stringify(cwd)}, pane = ${JSON.stringify(pane)}, address = ${JSON.stringify(address)};
const emit = (value) => process.stdout.write(JSON.stringify({ result: value }));
const running = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : undefined;
if (operation[0] === "workspace" && operation[1] === "list") emit({ workspaces: [{ workspace_id: "w2K", label: ${JSON.stringify(project)}, worktree: { checkout_path: cwd } }] });
else if (operation[0] === "tab" && operation[1] === "list") emit({ tabs: [{ tab_id: "w2K:t1", workspace_id: "w2K", label: address }] });
else if (operation[0] === "pane" && operation[1] === "list") emit({ panes: [{ pane_id: pane, tab_id: "w2K:t1", label: address }] });
else if (operation[0] === "pane" && operation[1] === "get") emit({ pane: running
  ? { pane_id: pane, agent: "pi", agent_status: "idle", agent_session: { kind: "path", source: "herdr:pi", value: running.path }, cwd, label: address }
  : { pane_id: pane, agent: null, agent_status: "unknown", agent_session: null, cwd, label: address } });
else if (operation[0] === "pane" && operation[1] === "process-info") emit({ process_info: { pane_id: pane, shell_pid: 42,
  foreground_processes: running ? [{ name: "node", argv0: "pi", pid: 100, cwd }] : [{ name: "zsh", argv0: "zsh", pid: 42, cwd }] } });
else if (operation[0] === "pane" && operation[1] === "run") emit({ pane_id: pane });
else if (operation[0] === "agent" && operation[1] === "start") {
  const separator = operation.indexOf("--"), piArgs = operation.slice(separator + 1), idAt = piArgs.indexOf("--session-id");
  const id = piArgs[idAt + 1], path = root + "/fresh_" + id + ".jsonl";
  writeFileSync(path, '{"type":"session"}\\n');
  writeFileSync(stateFile, JSON.stringify({ id, path }));
  emit({ name: "flow-main-dos-play" });
} else if (operation[0] === "agent" && operation[1] === "get") emit({ agent: {
  name: "flow-main-dos-play", agent: "pi", pane_id: pane, agent_status: "idle",
  agent_session: { kind: "path", source: "herdr:pi", value: running.path }, cwd,
} });
else { console.error("unexpected Herdr command: " + args.join(" ")); process.exit(2); }
`;
  return Promise.all([
    writeFile(executable, script).then(() => chmod(executable, 0o755)),
    ...(occupied ? [writeFile(state, JSON.stringify({ id: sourceSession, path: sourcePath }))] : []),
  ]);
}

async function fixture(options: { occupied?: boolean; status?: "todo" | "in_progress" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-dos-supersession-launch-"));
  roots.push(root);
  const bin = join(root, "bin"), pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await fakeHerdr(root, options.occupied ?? false);
  await atomicYaml(paths(root).desk, {
    schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi },
  });
  await atomicYaml(paths(root).models, {
    schema: "atdd-workflow/models/v1", models: [{ id: "economy", executable: "pi" }],
  });
  await atomicYaml(paths(root).projectFile(project), {
    schema: "atdd-workflow/project/v1", project, repository: cwd, roles: {},
  });
  const priorReceipt = join(root, ".atdd-flow", "runtime-launch", `${sourceSession}-44e21f2d.yaml`);
  await atomicYaml(priorReceipt, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: address, tasks: ["prior-main-successor"],
    candidate: "economy", pi_session: sourceSession, pi_session_path: sourcePath,
    herdr_session: herdrSession, pane, created_at: "2026-10-20T10:30:00.000Z",
  });
  await atomicYaml(paths(root).seatFile(address), {
    schema: "atdd-workflow/seat/v2", address, role: "main", project, worktree: cwd, branch: "main",
    runtime: {
      application: "herdr", addresses: { herdr: { session: herdrSession, pane } }, wake: "native",
      pi_session: sourceSession, pi_session_path: sourcePath, launch_receipt: priorReceipt,
    },
  });
  await atomicYaml(paths(root).taskFile(project, takeoverTask), {
    schema: "atdd-workflow/task/v1", title: "Fresh DOS checkpoint successor",
    status: options.status ?? "in_progress", coordinator: address, assignee: address,
    source: repositoryHead, done_when: [{ text: "Fresh successor resumes the checkpoint." }],
  });

  const request: HandoverReplacementRequest = {
    schema: "atdd-flow/context-handover-replacement-request/v1", seat: address, task: takeoverTask,
    handover: { id: "H-20261020T103000Z-dos-checkpoint-successor", sha256: "1".repeat(64) },
    authorization: { id: "A-dos-checkpoint-successor", hash: "2".repeat(64) },
    source: { pi_session: sourceSession, pi_session_path: sourcePath, herdr_session: herdrSession, pane },
    target: { herdr_session: herdrSession, pane, cwd },
    supersession: {
      prior_request: {
        path: handoverReplacementPath(root, address), sha256: "3".repeat(64), task: "prior-main-successor",
        handover: "H-20261020T100000Z-prior-dos-successor", handover_sha256: "4".repeat(64),
        archive: join(root, ".atdd-flow", "handover-replacement-archive", encodeURIComponent(address), "3".repeat(64)),
      },
      prior_receipt: { path: priorReceipt, sha256: "5".repeat(64), successor_session: sourceSession },
      canonical_source: {
        pi_session: sourceSession, pi_session_path: sourcePath, herdr_session: herdrSession, pane, cwd,
        launch_receipt: priorReceipt,
      },
      live_source: {
        authorization_hash: "2".repeat(64), pi_session: sourceSession, pi_session_path: sourcePath,
        herdr_session: herdrSession, pane, cwd, agent: "flow-main-dos-play", verified_at: "2026-10-20T10:40:00.000Z",
      },
    },
    created_at: "2026-10-20T10:40:00.000Z",
  };
  await atomicYaml(handoverReplacementPath(root, address), request);
  return { root, priorReceipt, request };
}

async function changeTask(root: string, change: Record<string, unknown>) {
  const file = paths(root).taskFile(project, takeoverTask);
  await atomicYaml(file, { ...await readYaml<Record<string, unknown>>(file), ...change });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("DOS public normal launch accepts the request-named evidence-empty IN_PROGRESS supersession task", async () => {
  const value = await fixture();
  const launched = await invokeAtRoot(value.root, "pi", "runtime", "launch", address, "--pane", pane, "--herdr-session", herdrSession);

  expect(launched).toMatchObject({ exitCode: 0 });
  expect(launched.output).toContain(`Launched Pi runtime for ${address} with economy.`);
  expect(basename(value.priorReceipt)).toBe(`${sourceSession}-44e21f2d.yaml`);
  const task = await readYaml<Record<string, unknown>>(paths(value.root).taskFile(project, takeoverTask));
  expect(task).toMatchObject({ status: "in_progress", source: repositoryHead, done_when: [{ text: "Fresh successor resumes the checkpoint." }] });
  const seat = await readYaml<Record<string, any>>(paths(value.root).seatFile(address));
  expect(seat.runtime).toMatchObject({ application: "herdr", addresses: { herdr: { session: herdrSession, pane } } });
  expect(seat.runtime.pi_session).not.toBe(sourceSession);
  expect(await readYaml<Record<string, any>>(seat.runtime.launch_receipt)).toMatchObject({
    seat: address, tasks: [takeoverTask], handover_replacement: { request: value.request },
  });
});

test("canonical supersession preserves TODO and refuses non-empty, unrelated, mismatched, or occupied recovery", async () => {
  const todo = await fixture({ status: "todo" });
  await expect(replacementForMainLaunch(todo.root, await readYaml(paths(todo.root).seatFile(address)), address)).resolves.toMatchObject({ request: { task: takeoverTask } });

  const cases: Array<[string, (root: string) => Promise<void>]> = [
    ["unrelated", async (root) => {
      await changeTask(root, { status: "done" });
      await atomicYaml(paths(root).taskFile(project, "unrelated"), {
        schema: "atdd-workflow/task/v1", title: "Unrelated", status: "in_progress",
        coordinator: address, assignee: address, done_when: [{ text: "Unrelated." }],
      });
    }],
    ["proven", async (root) => changeTask(root, { done_when: [{ text: "Fresh successor resumes.", proof: "runtime result" }] })],
    ["blocked", async (root) => changeTask(root, { blocker: "hold" })],
    ["handoff", async (root) => changeTask(root, { handoff: { state: "executing", evidence: "M-proof", updated_at: "2026-10-20T10:41:00.000Z" } })],
    ["review", async (root) => changeTask(root, { status: "review" })],
    ["runtime mismatch", async (root) => {
      const file = paths(root).seatFile(address), seat = await readYaml<Record<string, any>>(file);
      await atomicYaml(file, { ...seat, runtime: { ...seat.runtime, pi_session: "different-session" } });
    }],
    ["ordinary non-supersession", async (root) => {
      const file = handoverReplacementPath(root, address), request = await readYaml<HandoverReplacementRequest>(file);
      delete request.supersession;
      await atomicYaml(file, request);
    }],
  ];
  for (const [label, arrange] of cases) {
    const value = await fixture();
    await arrange(value.root);
    await expect(replacementForMainLaunch(value.root, await readYaml(paths(value.root).seatFile(address)), address), label).rejects.toThrow("ready main takeover task");
  }

  const occupied = await fixture({ occupied: true });
  const rejected = await invokeAtRoot(occupied.root, "pi", "runtime", "launch", address, "--pane", pane, "--herdr-session", herdrSession);
  expect(rejected.exitCode).toBe(1);
  expect(rejected.output).toContain("New launch requires an available shell pane.");
});
