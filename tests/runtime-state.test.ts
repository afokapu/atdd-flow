import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRuntimeState,
  heartbeatRuntimeState,
  isRuntimeStateStale,
  readRuntimeState,
  registerRuntimeState,
  runtimeStatePath,
} from "../src/runtime-state";

const time = "2026-10-09T12:00:00.000Z";
const later = "2026-10-09T12:00:10.000Z";
const runtime = (owner_token: string) => ({
  seat: "driver.runtime@demo",
  owner_token,
  pid: 1234,
  model: "pi",
  cwd: "/work/demo",
});

async function temporaryDesk() {
  return mkdtemp(join(tmpdir(), "atdd-runtime-state-"));
}

test("stores one encoded advisory record per seat without using Desk records", async () => {
  const root = await temporaryDesk();
  try {
    const file = runtimeStatePath(root, "driver.runtime@demo");
    expect(file).toBe(join(root, ".atdd-flow", "pi-runtime", "driver.runtime%40demo.yaml"));

    await registerRuntimeState(root, runtime("owner-one"), time);
    expect(await readRuntimeState(root, "driver.runtime@demo")).toEqual({
      schema: "atdd-flow/pi-runtime-state/v1",
      ...runtime("owner-one"),
      started_at: time,
      heartbeat_at: time,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a newer same-seat registration replaces only its advisory owner", async () => {
  const root = await temporaryDesk();
  try {
    const unrelated = join(root, "work", "demo", "seats", "driver.runtime", "seat.yaml");
    await mkdir(join(root, "work", "demo", "seats", "driver.runtime"), { recursive: true });
    await writeFile(unrelated, "seat authority remains external\n");
    await registerRuntimeState(root, runtime("owner-one"), time);
    await registerRuntimeState(root, { ...runtime("owner-two"), pid: 5678, model: "pi-new" }, later);

    expect(await readRuntimeState(root, "driver.runtime@demo")).toMatchObject({
      owner_token: "owner-two", pid: 5678, model: "pi-new", started_at: later, heartbeat_at: later,
    });
    expect(await readFile(unrelated, "utf8")).toBe("seat authority remains external\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale owners cannot heartbeat or clear a replacement", async () => {
  const root = await temporaryDesk();
  try {
    await registerRuntimeState(root, runtime("owner-one"), time);
    await registerRuntimeState(root, runtime("owner-two"), later);

    expect(await heartbeatRuntimeState(root, "driver.runtime@demo", "owner-one", "2026-10-09T12:00:20.000Z")).toBeUndefined();
    expect(await clearRuntimeState(root, "driver.runtime@demo", "owner-one")).toBe(false);
    expect(await readRuntimeState(root, "driver.runtime@demo")).toMatchObject({ owner_token: "owner-two", heartbeat_at: later });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the current owner alone updates advisory activity and may clear it", async () => {
  const root = await temporaryDesk();
  try {
    await registerRuntimeState(root, runtime("owner-one"), time);
    expect(await heartbeatRuntimeState(root, "driver.runtime@demo", "owner-one", later)).toMatchObject({
      owner_token: "owner-one", started_at: time, heartbeat_at: later,
    });
    expect(await clearRuntimeState(root, "driver.runtime@demo", "owner-one")).toBe(true);
    expect(await readRuntimeState(root, "driver.runtime@demo")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or malformed runtime state is absent rather than authoritative", async () => {
  const root = await temporaryDesk();
  try {
    expect(await readRuntimeState(root, "driver.runtime@demo")).toBeUndefined();
    const file = runtimeStatePath(root, "driver.runtime@demo");
    await mkdir(join(root, ".atdd-flow", "pi-runtime"), { recursive: true });
    await writeFile(file, "not: [valid\n");
    expect(await readRuntimeState(root, "driver.runtime@demo")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeat age is an advisory stale signal only", async () => {
  const root = await temporaryDesk();
  try {
    const state = await registerRuntimeState(root, runtime("owner-one"), time);
    expect(isRuntimeStateStale(state, 10_001, new Date(later))).toBe(false);
    expect(isRuntimeStateStale(state, 10_000, new Date(later))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
