import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { launchPiRuntime } from "../src/seats";

const roots: string[] = [];
const seat = "driver.runtime@demo";

async function desk() {
  const root = await mkdtemp(join(tmpdir(), "atdd-runtime-launch-"));
  roots.push(root);
  const bin = join(root, "bin");
  const pi = join(bin, "pi");
  await mkdir(bin);
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", executables: { pi } });
  await atomicYaml(paths(root).models, {
    schema: "atdd-workflow/models/v1",
    models: [
      { id: "strong", executable: "pi", args: ["--model", "strong"] },
      { id: "economy", executable: "pi", args: ["--model", "economy"] },
    ],
  });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", roles: {} });
  await atomicYaml(paths(root).seatFile(seat), {
    schema: "atdd-workflow/seat/v2", address: seat, role: "driver", project: "demo", worktree: "/work/demo", branch: "delivery/runtime",
  });
  await atomicYaml(paths(root).taskFile("demo", "runtime"), {
    schema: "atdd-workflow/task/v1", title: "Bounded runtime work", status: "in_progress", coordinator: "coordinator@demo", assignee: seat,
    done_when: [{ text: "Runtime command is tested." }],
  });
  return root;
}

function fakeHerdr(overrides: Partial<{ initial: object; started: object }> = {}) {
  const calls: string[] = [];
  return {
    calls,
    inspect: async () => {
      calls.push("inspect");
      return overrides.initial ?? { session: "forge", pane: "w1:p2", state: "available" };
    },
    stop: async () => { calls.push("stop"); },
    start: async (request: { piSession: string }) => {
      calls.push("start");
      return overrides.started ?? { session: "forge", pane: "w1:p2", pi_session: request.piSession };
    },
  };
}

const selectEconomy = async () => ({ available: true as const, model: "fake-jev", selected_model: "economy", confidence: 0.93 });

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("first Pi launch selects a model, verifies the named Herdr pane, then binds a compact receipt", async () => {
  const root = await desk();
  const herdr = fakeHerdr();

  const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], {
    select: selectEconomy,
    herdr,
    sessionId: () => "new-session",
    at: () => "2026-10-10T14:00:00.000Z",
  });

  expect(herdr.calls).toEqual(["inspect", "start"]);
  expect(result.candidate).toBe("economy");
  expect(result.piSession).toBe("new-session");
  const receipt = await readYaml<Record<string, unknown>>(result.receipt);
  expect(receipt).toMatchObject({ seat, tasks: ["runtime"], candidate: "economy", pi_session: "new-session", pane: "w1:p2" });
  expect(JSON.stringify(receipt)).not.toContain("/bin/pi");
  const bound = await readYaml<Record<string, any>>(paths(root).seatFile(seat));
  expect(bound.runtime).toMatchObject({ application: "herdr", model: "economy", wake: "native", pi_session: "new-session" });
  expect(bound.runtime.launch_receipt).toBe(result.receipt);
});

test("idle resume only accepts the exact stored Pi session and Herdr report", async () => {
  const root = await desk();
  const receipt = join(root, ".atdd-flow", "runtime-launch", "old-session.yaml");
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: "old-session" });
  const saved = await readYaml<Record<string, any>>(paths(root).seatFile(seat));
  saved.runtime = { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, pi_session: "old-session", launch_receipt: receipt };
  await atomicYaml(paths(root).seatFile(seat), saved);
  const herdr = fakeHerdr({ initial: { session: "forge", pane: "w1:p2", state: "idle", pi_session: "old-session" }, started: { session: "forge", pane: "w1:p2", pi_session: "old-session" } });

  const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--resume"], { select: selectEconomy, herdr });

  expect(result.piSession).toBe("old-session");
  expect(herdr.calls).toEqual(["inspect", "stop", "start"]);
  await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--resume"], {
    select: selectEconomy,
    herdr: fakeHerdr({ initial: { session: "forge", pane: "w1:p2", state: "idle", pi_session: "different" } }),
  })).rejects.toThrow("does not match");
});

test("idle exact-session resume stops only the prior Pi and retains its shell through replacement verification", async () => {
  const root = await desk();
  const receipt = join(root, ".atdd-flow", "runtime-launch", "old-session.yaml");
  await atomicYaml(receipt, { schema: "atdd-flow/pi-runtime-launch-receipt/v1", seat, pi_session: "old-session" });
  const saved = await readYaml<Record<string, any>>(paths(root).seatFile(seat));
  saved.runtime = { application: "herdr", addresses: { herdr: { session: "forge", pane: "w1:p2" } }, pi_session: "old-session", launch_receipt: receipt };
  await atomicYaml(paths(root).seatFile(seat), saved);
  const calls: string[] = [];
  let shellRetained = false;
  const herdr = {
    inspect: async () => {
      calls.push("inspect");
      return { session: "forge", pane: "w1:p2", state: "idle", pi_session: "old-session" };
    },
    stop: async (request: { session: string; pane: string; piSession: string }) => {
      calls.push("stop");
      expect(request).toEqual({ session: "forge", pane: "w1:p2", piSession: "old-session" });
      shellRetained = true;
    },
    start: async (request: { session: string; pane: string; piSession: string }) => {
      calls.push("start");
      expect(shellRetained).toBe(true);
      expect(request.piSession).toBe("old-session");
      return { session: "forge", pane: "w1:p2", pi_session: "old-session" };
    },
  };

  await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--resume"], { select: selectEconomy, herdr });

  expect(calls).toEqual(["inspect", "stop", "start"]);
  expect(shellRetained).toBe(true);
});

test("unavailable, low-confidence, or invalid Jev selection falls back to the strongest candidate in its receipt", async () => {
  const cases = [
    async () => ({ available: false as const, reason: "Jev offline" }),
    async () => ({ available: true as const, selected_model: "economy", confidence: 0.74 }),
    async () => ({ available: true as const, selected_model: "missing", confidence: 0.99 }),
  ];
  for (const select of cases) {
    const root = await desk();
    const result = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select, herdr: fakeHerdr(), sessionId: () => crypto.randomUUID() });
    const receipt = await readFile(result.receipt, "utf8");
    expect(result.candidate).toBe("strong");
    expect(receipt).toContain("fallback");
  }
});

test("it refuses unsafe or mismatched panes before starting and dry-run never mutates", async () => {
  const root = await desk();
  for (const state of ["working", "blocked", "unknown"]) {
    const herdr = fakeHerdr({ initial: { session: "forge", pane: "w1:p2", state } });
    await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select: selectEconomy, herdr })).rejects.toThrow(state);
    expect(herdr.calls).toEqual(["inspect"]);
  }
  const badVerification = fakeHerdr({ started: { session: "forge", pane: "w1:p2", pi_session: "other-session" } });
  await expect(launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge"], { select: selectEconomy, herdr: badVerification, sessionId: () => "wanted-session" })).rejects.toThrow("exact requested Pi session");
  expect((await readYaml<Record<string, any>>(paths(root).seatFile(seat))).runtime).toBeUndefined();

  const herdr = fakeHerdr();
  const plan = await launchPiRuntime(root, seat, ["--pane", "w1:p2", "--herdr-session", "forge", "--dry-run"], { select: selectEconomy, herdr, sessionId: () => "dry-session" });
  expect(plan.dryRun).toBe(true);
  expect(herdr.calls).toEqual(["inspect"]);
  expect(await Bun.file(join(root, ".atdd-flow", "runtime-launch", "dry-session.yaml")).exists()).toBe(false);
  const unbound = await readYaml<Record<string, any>>(paths(root).seatFile(seat));
  expect(unbound.runtime).toBeUndefined();
});
