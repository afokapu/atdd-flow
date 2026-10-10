import { mkdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { addressParts, atomicYaml, yaml } from "./core";

/**
 * A local, advisory observation of one runtime for one already-authoritative
 * Desk seat. This record is deliberately not a registry: it cannot select a
 * recipient, deliver mail, or change any Desk-owned state.
 */
export type RuntimeState = {
  schema: "atdd-flow/pi-runtime-state/v1";
  seat: string;
  owner_token: string;
  pid: number;
  model: string;
  cwd: string;
  started_at: string;
  heartbeat_at: string;
};

export type RuntimeStateRegistration = Pick<RuntimeState, "seat" | "owner_token" | "pid" | "model" | "cwd">;

const schema = "atdd-flow/pi-runtime-state/v1" as const;
const lockStaleMs = 5 * 60_000;
const lockAttempts = 2_000;
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp(value: unknown): value is string {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function valid(value: unknown): value is RuntimeState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.schema === schema
    && nonEmpty(record.seat)
    && nonEmpty(record.owner_token)
    && Number.isInteger(record.pid) && (record.pid as number) > 0
    && nonEmpty(record.model)
    && nonEmpty(record.cwd)
    && timestamp(record.started_at)
    && timestamp(record.heartbeat_at);
}

function assertRegistration(value: RuntimeStateRegistration) {
  addressParts(value.seat);
  if (!nonEmpty(value.owner_token)) throw new Error("Runtime state requires a non-empty owner token.");
  if (!Number.isInteger(value.pid) || value.pid <= 0) throw new Error("Runtime state requires a positive integer pid.");
  if (!nonEmpty(value.model)) throw new Error("Runtime state requires a model.");
  if (!nonEmpty(value.cwd)) throw new Error("Runtime state requires a cwd.");
}

/** A mkdir lock serializes state mutation and final wake authorization across Pi processes. */
async function exclusive<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
    try {
      await mkdir(lock);
      try { return await work(); }
      finally { await rm(lock, { recursive: true, force: true }); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > lockStaleMs) await rm(lock, { recursive: true, force: true });
        else await pause(5);
      } catch { await pause(5); }
    }
  }
  throw new Error(`Timed out waiting for runtime-state lock ${file}`);
}

/** A deterministic, per-seat local advisory state path; it never resolves Desk membership. */
export function runtimeStatePath(root: string, seat: string) {
  addressParts(seat);
  return join(root, ".atdd-flow", "pi-runtime", `${encodeURIComponent(seat)}.yaml`);
}

/** Generate an opaque token for a runtime owner that needs one. */
export function runtimeOwnerToken() {
  return randomUUID();
}

/**
 * Atomically publish a new advisory observation for this seat. A later
 * registration replaces the record and therefore fences a prior owner token.
 */
export async function registerRuntimeState(root: string, registration: RuntimeStateRegistration, at = new Date().toISOString()) {
  assertRegistration(registration);
  if (!timestamp(at)) throw new Error("Runtime state requires a valid timestamp.");
  const file = runtimeStatePath(root, registration.seat);
  const state: RuntimeState = { schema, ...registration, started_at: at, heartbeat_at: at };
  return exclusive(file, async () => {
    await atomicYaml(file, state);
    return state;
  });
}

/** Read an advisory record. Missing or invalid local state is deliberately treated as absent. */
export async function readRuntimeState(root: string, seat: string): Promise<RuntimeState | undefined> {
  const file = runtimeStatePath(root, seat);
  try {
    const value = yaml.parse<unknown>(await readFile(file, "utf8"));
    return valid(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** True only while this token owns the current advisory record; never a governance decision. */
export async function ownsRuntimeState(root: string, seat: string, ownerToken: string) {
  return (await readRuntimeState(root, seat))?.owner_token === ownerToken;
}

/**
 * Invoke a wake action only while this process still owns the current record.
 * The filesystem lock is shared by separate Pi processes and is held through
 * the action, so registration cannot replace the owner mid-wake.
 */
export async function withOwnedRuntimeState<T>(root: string, seat: string, ownerToken: string, action: () => Promise<T> | T) {
  const file = runtimeStatePath(root, seat);
  return exclusive(file, async () => {
    if (!await ownsRuntimeState(root, seat, ownerToken)) return { owned: false as const };
    return { owned: true as const, value: await action() };
  });
}

/** Remove an abandoned advisory observation only when its heartbeat has expired. */
export async function clearStaleRuntimeState(root: string, seat: string, maxAgeMs: number, observedAt = new Date()) {
  const file = runtimeStatePath(root, seat);
  return exclusive(file, async () => {
    const current = await readRuntimeState(root, seat);
    if (!current || !isRuntimeStateStale(current, maxAgeMs, observedAt)) return false;
    try {
      await unlink(file);
      return true;
    } catch {
      return false;
    }
  });
}

/** Update activity only if this owner still holds the current advisory record. */
export async function heartbeatRuntimeState(root: string, seat: string, ownerToken: string, at = new Date().toISOString()) {
  if (!nonEmpty(ownerToken)) throw new Error("Runtime state requires a non-empty owner token.");
  if (!timestamp(at)) throw new Error("Runtime state requires a valid timestamp.");
  const file = runtimeStatePath(root, seat);
  return exclusive(file, async () => {
    const current = await readRuntimeState(root, seat);
    if (!current || current.owner_token !== ownerToken) return undefined;
    const next = { ...current, heartbeat_at: at };
    await atomicYaml(file, next);
    return next;
  });
}

/** Remove local advisory state only if this owner still owns it. */
export async function clearRuntimeState(root: string, seat: string, ownerToken: string) {
  if (!nonEmpty(ownerToken)) throw new Error("Runtime state requires a non-empty owner token.");
  const file = runtimeStatePath(root, seat);
  return exclusive(file, async () => {
    const current = await readRuntimeState(root, seat);
    if (!current || current.owner_token !== ownerToken) return false;
    try {
      await unlink(file);
      return true;
    } catch {
      return false;
    }
  });
}

/** This local age calculation is informational only and cannot govern Desk work. */
export function isRuntimeStateStale(state: RuntimeState, maxAgeMs: number, observedAt = new Date()) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error("Runtime state max age must be a non-negative number.");
  return observedAt.getTime() - Date.parse(state.heartbeat_at) >= maxAgeMs;
}
