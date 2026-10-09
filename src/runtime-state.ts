import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
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
const serial = new Map<string, Promise<void>>();

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

async function exclusive<T>(file: string, work: () => Promise<T>): Promise<T> {
  const previous = serial.get(file) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  serial.set(file, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (serial.get(file) === queued) serial.delete(file);
  }
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
