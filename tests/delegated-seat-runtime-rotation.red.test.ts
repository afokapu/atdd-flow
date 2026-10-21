// URN: test:atdd-flow:delegated-seat-runtime-rotation:E007-RED-001
// Acceptance: acc:flow:E007-RED-001
// Phase: RED
// Layer: integration
// Runtime: bun
// Structural RED marker; the behavioral expectations below are the causal oracle: expect.fail("delegated rotation is not implemented")

import { afterEach, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicYaml, exists, paths, readYaml, yaml } from "../src/core";
import { handoverReplacementPath } from "../src/handover";
import { registerRuntimeState } from "../src/runtime-state";
import {
  at, args, cleanupFixtures, fakeHerdr, fixture, immutableSnapshot, processEffects, publicHerdr, rotate,
  sourcePath, sourceSession, successorPath, successorSession,
} from "./helpers/delegated-runtime-rotation-fixture.red.test";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
async function invokePublic(root: string, commandArgs: string[]) {
  const child = Bun.spawn([process.execPath, cli, "--root", root, "pi", "runtime", "rotate", "driver.rotate@demo", ...commandArgs], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

afterEach(cleanupFixtures);

test("public CLI declares the one-command delegated rotation grammar", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "--help"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain("atdd-flow pi runtime rotate <address> --by <caller> --task <id> --handover <id>");
  expect(output).toContain("--source-pi-session <id>");
  expect(output).toContain("--target-herdr-session <session>");
  expect(output).toContain("[--model <candidate>] [--timeout-ms <milliseconds>]");
});

test("public CLI subprocess completes with the default Herdr command runner", async () => {
  const value = await fixture(), fake = await publicHerdr(value);
  const invocation = invokePublic(value.root, args(value, { "--timeout-ms": "1000" }));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const calls = await Bun.file(fake.log).exists() ? await readFile(fake.log, "utf8") : "";
    if (calls.includes("pane get") && calls.includes("pane process-info")) break;
    await Bun.sleep(5);
  }
  expect(await exists(handoverReplacementPath(value.root, value.target))).toBe(false);
  await fake.release();
  const completed = await invocation;
  expect(completed.exitCode, completed.stderr).toBe(0);
  const resultStart = completed.stdout.lastIndexOf("\n{\n");
  expect(resultStart, completed.stdout).toBeGreaterThanOrEqual(0);
  expect(yaml.parse<Record<string, any>>(completed.stdout.slice(resultStart + 1))).toMatchObject({
    schema: "atdd-flow/delegated-runtime-rotation-result/v1", state: "complete", seat: value.target,
    successor: { pi_session: expect.any(String), pi_session_path: expect.stringContaining("fresh_") },
    resumed: { verified: 6, total: 6 },
  });
  expect(await readFile(fake.log, "utf8")).toContain("agent start");
});

test("public CLI stale source has zero request, process, receipt, or binding effects", async () => {
  const value = await fixture(), fake = await publicHerdr(value), before = await immutableSnapshot(value);
  const completed = await invokePublic(value.root, args(value, { "--source-pi-session": successorSession }));
  expect(completed.exitCode).not.toBe(0);
  expect(completed.stderr).toMatch(/source tuple is stale/i);
  expect(await immutableSnapshot(value)).toEqual(before);
  expect(await Bun.file(fake.log).exists()).toBe(false);
});

test("one main-authorized invocation completes request through fresh receipt and RESUMED 6/6", async () => {
  const value = await fixture();
  const herdr = fakeHerdr(value);
  const result = await rotate(value, herdr);

  expect(result).toMatchObject({
    schema: "atdd-flow/delegated-runtime-rotation-result/v1", state: "complete", seat: value.target, by: value.caller, task: "rotate",
    source: { pi_session: sourceSession, pi_session_path: sourcePath },
    successor: { pi_session: successorSession, pi_session_path: successorPath },
    target: { herdr_session: "forge", pane: "w1:p2", cwd: value.targetWorktree },
    model: { requested: "economy", selected: "economy" }, resumed: { verified: 6, total: 6 },
  });
  expect(herdr.starts()).toBe(1);
  expect(await exists(handoverReplacementPath(value.root, value.target))).toBe(true);
  const receipt = await readYaml<Record<string, any>>(result.launch_receipt);
  expect(receipt).toMatchObject({
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: value.target, tasks: ["rotate"], candidate: "economy",
    pi_session: successorSession, pi_session_path: successorPath,
    rotation: { by: value.caller, task: "rotate", handover: "H-rotate-1" },
  });
  const bound = await readYaml<Record<string, any>>(paths(value.root).seatFile(value.target));
  expect(bound.runtime).toMatchObject({ wake: "native", pi_session: successorSession, pi_session_path: successorPath, launch_receipt: result.launch_receipt });
  expect(await exists(paths(value.root).threads)).toBe(false);
  expect(await exists(join(value.root, ".atdd-flow", "pi-inbox"))).toBe(false);
});

test("named coordinator rotates only its directly governed driver", async () => {
  const value = await fixture({ caller: "coordinator.payments@demo", taskCoordinator: "coordinator.payments@demo" });
  const result = await rotate(value, fakeHerdr(value));
  expect(result).toMatchObject({ state: "complete", by: "coordinator.payments@demo", seat: "driver.rotate@demo", resumed: { verified: 6, total: 6 } });
});

test("authority is closed against driver, generic coordinator, cross-project and upward callers", async () => {
  const cases: Array<[string, FixtureOptions]> = [
    ["driver caller", { caller: "driver.rotate@demo" }],
    ["generic coordinator", { caller: "coordinator@demo", taskCoordinator: "coordinator@demo" }],
    ["cross-project main", { caller: "main@other" }],
    ["coordinator rotates coordinator", { caller: "coordinator.payments@demo", targetRole: "coordinator", target: "coordinator.payments@demo" }],
    ["coordinator rotates main", { caller: "coordinator.payments@demo", targetRole: "main", target: "main@demo" }],
  ];
  for (const [label, options] of cases) {
    const value = await fixture(options), herdr = fakeHerdr(value), before = await immutableSnapshot(value);
    await expect(rotate(value, herdr)).rejects.toThrow(/authori|direct|same project|main|coordinator/i);
    expect(await immutableSnapshot(value), label).toEqual(before);
    expect(processEffects(herdr.calls), label).toEqual([]);
  }
});

test("operator remains exceptional while an authorized project caller is live", async () => {
  const value = await fixture({ caller: "operator@desk" }), herdr = fakeHerdr(value), before = await immutableSnapshot(value);
  // main@demo is deliberately live in the Desk fixture, so operator fallback is ineligible.
  await registerRuntimeState(value.root, { seat: "main@demo", owner_token: "live-main", pid: 103, model: "strong", cwd: "/work/primary" }, at);
  await expect(rotate(value, herdr)).rejects.toThrow(/operator|fallback|authorized.*live/i);
  expect((await immutableSnapshot(value)).seat).toBe(before.seat);
  expect(await exists(handoverReplacementPath(value.root, value.target))).toBe(false);
  expect(processEffects(herdr.calls)).toEqual([]);
});

test("stale tuple, retired target, ambiguous task and ineligible task fail before writes or process effects", async () => {
  const cases: Array<[string, FixtureOptions, Record<string, string | undefined>]> = [
    ["stale source", {}, { "--source-pi-session": successorSession }],
    ["retired", { retired: true }, {}],
    ["two eligible tasks", { secondEligibleTask: true }, {}],
    ["blocked", { blocker: "wait" }, {}],
    ["review", { taskStatus: "review" }, {}],
    ["coordinator handoff", { handoff: { state: "awaiting_coordinator", evidence: "M-proof", updated_at: at } }, {}],
  ];
  for (const [label, options, overrides] of cases) {
    const value = await fixture(options), herdr = fakeHerdr(value), before = await immutableSnapshot(value);
    await expect(rotate(value, herdr, args(value, overrides))).rejects.toThrow(/source|retired|exactly one|eligible|blocked|review|handoff|task/i);
    expect(await immutableSnapshot(value), label).toEqual(before);
    expect(processEffects(herdr.calls), label).toEqual([]);
  }
});

test("model input is an enabled candidate id only and cannot bypass receipt evidence", async () => {
  for (const model of ["missing", "pi --model arbitrary", "/tmp/pi"]) {
    const value = await fixture(), herdr = fakeHerdr(value), before = await immutableSnapshot(value);
    await expect(rotate(value, herdr, args(value, { "--model": model }))).rejects.toThrow(/model|candidate|enabled/i);
    expect(await immutableSnapshot(value)).toEqual(before);
    expect(processEffects(herdr.calls)).toEqual([]);
  }
});

test("failed source vacancy preserves only the complete authoritative request and never launches or binds", async () => {
  const value = await fixture(), herdr = fakeHerdr(value, { releaseOnPause: false });
  const beforeSeat = await readFile(paths(value.root).seatFile(value.target), "utf8");
  await expect(rotate(value, herdr, args(value, { "--timeout-ms": "5" }))).rejects.toThrow(/release|vacan|timeout/i);

  const request = await readYaml<Record<string, any>>(handoverReplacementPath(value.root, value.target));
  expect(request).toMatchObject({ seat: value.target, task: "rotate", source: { pi_session: sourceSession }, target: { pane: "w1:p2" } });
  expect(await readFile(paths(value.root).seatFile(value.target), "utf8")).toBe(beforeSeat);
  expect((await readdir(join(value.root, ".atdd-flow", "runtime-launch"))).sort()).toEqual(["source.yaml"]);
  expect(processEffects(herdr.calls)).toEqual([]);
});

test("EXECUTING duplicate starts attach to one exact request and one successor; changed tuple refuses", async () => {
  const value = await fixture();
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const herdr = fakeHerdr(value, { startGate });

  const first = rotate(value, herdr);
  for (let attempts = 0; attempts < 100 && herdr.starts() === 0; attempts += 1) await Bun.sleep(2);
  expect(herdr.starts()).toBe(1);

  // The first invocation is EXECUTING after Herdr accepted one start but before its receipt/bind.
  const duplicate = rotate(value, herdr);
  const changed = rotate(value, herdr, args(value, { "--target-pane": "w9:p9" }));
  await expect(changed).rejects.toThrow(/different|tuple|request|target/i);
  expect(herdr.starts()).toBe(1);

  releaseStart();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  expect(duplicateResult).toEqual(firstResult);
  expect(herdr.starts()).toBe(1);
  expect((await readdir(join(value.root, ".atdd-flow", "runtime-launch"))).filter((file) => file.endsWith(".yaml"))).toHaveLength(2);
  expect((await readYaml<Record<string, any>>(paths(value.root).seatFile(value.target))).runtime.pi_session).toBe(successorSession);

  const completedRetry = await rotate(value, herdr);
  expect(completedRetry).toEqual(firstResult);
  expect(herdr.starts()).toBe(1);
});

test("duplicate writer and substituted receipt evidence fail closed without a second successor", async () => {
  const value = await fixture(), herdr = fakeHerdr(value);
  const duplicate = join(value.root, ".atdd-flow", "runtime-launch", "duplicate.yaml");
  await atomicYaml(duplicate, {
    schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat: value.target, tasks: ["rotate"], candidate: "economy",
    pi_session: successorSession, pi_session_path: successorPath, herdr_session: "forge", pane: "w1:p2",
    rotation: { by: value.caller, task: "rotate", handover: "H-rotate-1" },
  });
  await expect(rotate(value, herdr)).rejects.toThrow(/duplicate|receipt|writer/i);
  expect(herdr.starts()).toBe(0);
  expect(processEffects(herdr.calls)).toEqual([]);
});

test("main self-rotation delegates one shell-safe deadline-bound continuation and leaves no resident child", async () => {
  const value = await fixture({ targetRole: "main", target: "main@demo", caller: "main@demo" });
  const herdr = fakeHerdr(value);
  const observed: Array<Record<string, any>> = [];
  let activeChildren = 0;
  let childExit: Promise<number> | undefined;
  const result = await rotate(value, herdr, args(value, { "--timeout-ms": "100" }), {
    spawnContinuation: async (spec: Record<string, any>) => {
      observed.push(spec);
      activeChildren += 1;
      childExit = Promise.resolve(0).finally(() => { activeChildren -= 1; });
      return { pid: 404, exited: childExit };
    },
    environment: { ATDD_WORKFLOW_SEAT: "main@demo" },
  });

  expect(result).toMatchObject({ schema: "atdd-flow/delegated-runtime-rotation-result/v1", state: "accepted", seat: "main@demo" });
  expect(observed).toHaveLength(1);
  expect(Array.isArray(observed[0]!.argv)).toBe(true);
  expect(observed[0]!.argv).toContain(handoverReplacementPath(value.root, value.target));
  expect(observed[0]!.shell).toBe(false);
  expect(observed[0]!.detached).toBe(true);
  expect(Date.parse(observed[0]!.deadline_at) - Date.parse(at)).toBeLessThanOrEqual(100);
  await childExit;
  expect(activeChildren).toBe(0);
  expect(herdr.starts()).toBe(0);
});
