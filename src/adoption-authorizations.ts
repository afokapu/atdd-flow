// URN: component:flow:e006:adoption-authorizations:backend:integration
// Tested-By:
// - test:flow:exact-adoption-resumed-proof-and-relaunch
// Runtime: bun
// Purpose: Create and resolve exact-session adoption authorizations.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { now, required, words, yaml } from "./core";

export const authorizationSchema = "atdd-flow/exact-session-adoption-authorization/v1" as const;
export type ExactSessionAdoptionAuthorization = {
  schema: typeof authorizationSchema;
  id: string;
  issued_by: "operator@desk";
  created_at: string;
  seat: string;
  pi_session: string;
  pi_session_path: string;
  source: { herdr_session: string; pane: string };
  target: { herdr_session: string; pane: string; cwd: string };
};

// Ids are path components, so only A- plus a safe charset is accepted; this blocks traversal.
const validId = (value: string) => /^A-[A-Za-z0-9_-]+$/.test(value);
// A blank value can never bind an adoption, so whitespace-only strings count as missing.
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
// Records and their digests live side by side in one create-only directory.
function authorizationDir(root: string) {
  return join(root, ".atdd-flow", "exact-session-adoption-authorizations");
}
function path(root: string, id: string) {
  return join(authorizationDir(root), `${id}.yaml`);
}
function hashPath(root: string, id: string) {
  return join(authorizationDir(root), `${id}.sha256`);
}
// SHA-256 of the exact record bytes; any later edit changes the digest.
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

// The tuple check is split by concern so every predicate stays small and independently readable.
function validHeader(record: ExactSessionAdoptionAuthorization) {
  return record.schema === authorizationSchema && validId(record.id) && record.issued_by === "operator@desk" && nonEmpty(record.created_at);
}
// Seat and Pi session identity must be present.
function validSubject(record: ExactSessionAdoptionAuthorization) {
  return nonEmpty(record.seat) && nonEmpty(record.pi_session) && nonEmpty(record.pi_session_path);
}
// The source Herdr placement must be present.
function validSource(record: ExactSessionAdoptionAuthorization) {
  return nonEmpty(record.source?.herdr_session) && nonEmpty(record.source?.pane);
}
// The target Herdr placement and working directory must be present.
function validTarget(record: ExactSessionAdoptionAuthorization) {
  return nonEmpty(record.target?.herdr_session) && nonEmpty(record.target?.pane) && nonEmpty(record.target?.cwd);
}
function tuple(record: ExactSessionAdoptionAuthorization) {
  return validHeader(record) && validSubject(record) && validSource(record) && validTarget(record);
}

/**
 * Issue a create-only operator authorization: the record and its digest are written with the `wx` flag,
 * so an existing id can never be overwritten or silently reissued with a different tuple.
 */
export async function createExactSessionAdoptionAuthorization(root: string, id: string, args: string[]) {
  if (!validId(id)) throw new Error("Exact-session adoption authorization id must use A- followed by letters, numbers, underscores, or hyphens.");
  if (words(args, "--by") !== "operator@desk") throw new Error("Only operator@desk may issue an exact-session adoption authorization.");
  const record: ExactSessionAdoptionAuthorization = {
    schema: authorizationSchema, id, issued_by: "operator@desk", created_at: now(),
    seat: required(words(args, "--seat"), "--seat"), pi_session: required(words(args, "--pi-session"), "--pi-session"),
    pi_session_path: resolve(required(words(args, "--pi-session-path"), "--pi-session-path")),
    source: { herdr_session: required(words(args, "--source-herdr-session"), "--source-herdr-session"), pane: required(words(args, "--source-pane"), "--source-pane") },
    target: { herdr_session: required(words(args, "--target-herdr-session"), "--target-herdr-session"), pane: required(words(args, "--target-pane"), "--target-pane"), cwd: resolve(required(words(args, "--target-cwd"), "--target-cwd")) },
  };
  const file = path(root, id);
  const content = yaml.print(record);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, { encoding: "utf8", flag: "wx" });
  await writeFile(hashPath(root, id), `${digest(content)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${id}\n`);
}

// The adoption tuple a launch asks to use; the stored record must match it field for field.
type ExpectedTuple = Omit<ExactSessionAdoptionAuthorization, "schema" | "id" | "issued_by" | "created_at">;

// The operator-issued record must bind every element of the adoption tuple, not a subset.
// Seat and Pi session identity.
function sameSubject(record: ExactSessionAdoptionAuthorization, expected: ExpectedTuple) {
  return record.seat === expected.seat && record.pi_session === expected.pi_session && record.pi_session_path === expected.pi_session_path;
}
// Where the session runs before the move.
function sameSource(record: ExactSessionAdoptionAuthorization, expected: ExpectedTuple) {
  return record.source.herdr_session === expected.source.herdr_session && record.source.pane === expected.source.pane;
}
// Where the session will run after the move, including its working directory.
function sameTarget(record: ExactSessionAdoptionAuthorization, expected: ExpectedTuple) {
  return record.target.herdr_session === expected.target.herdr_session && record.target.pane === expected.target.pane && record.target.cwd === expected.target.cwd;
}
function same(record: ExactSessionAdoptionAuthorization, expected: ExpectedTuple) {
  return sameSubject(record, expected) && sameSource(record, expected) && sameTarget(record, expected);
}

// A receipt that already names this authorization id means the one-shot authorization was consumed.
async function used(root: string, id: string) {
  const folder = join(root, ".atdd-flow", "runtime-launch");
  try {
    const files = await readdir(folder);
    for (const file of files.filter((entry) => entry.endsWith(".yaml"))) {
      try {
        const value = yaml.parse<Record<string, unknown>>(await readFile(join(folder, file), "utf8"));
        const authorization = value.relocation && typeof value.relocation === "object" ? (value.relocation as Record<string, unknown>).authorization : undefined;
        if (authorization && typeof authorization === "object" && (authorization as Record<string, unknown>).id === id) return true;
      } catch { /* Malformed receipts never authorize reuse. */ }
    }
  } catch { /* No previous receipt means unused. */ }
  return false;
}

// Each reader fails with the same operator-facing message the combined resolver always used.
async function readRecord(root: string, id: string) {
  let raw: string;
  try { raw = await readFile(path(root, id), "utf8"); }
  catch { throw new Error("Exact-session adoption requires an existing immutable operator authorization record."); }
  try { return { raw, record: yaml.parse<ExactSessionAdoptionAuthorization>(raw) }; }
  catch { throw new Error("Exact-session adoption requires a well-formed immutable operator authorization record."); }
}

// The digest written next to the record at creation proves the record was never edited afterwards.
async function readStoredHash(root: string, id: string, raw: string) {
  let storedHash: string;
  try { storedHash = (await readFile(hashPath(root, id), "utf8")).trim(); }
  catch { throw new Error("Exact-session adoption requires a create-only immutable operator authorization record."); }
  if (!/^[a-f0-9]{64}$/i.test(storedHash) || storedHash !== digest(raw)) throw new Error("Exact-session adoption requires an immutable operator authorization record.");
  return storedHash;
}

/** Resolve only a create-only operator record whose complete tuple matches before runtime projection. */
export async function resolveExactSessionAdoptionAuthorization(root: string, id: string, expected: ExpectedTuple) {
  if (!validId(id)) throw new Error("Exact-session adoption requires an immutable operator authorization record id.");
  const { raw, record } = await readRecord(root, id);
  const storedHash = await readStoredHash(root, id, raw);
  if (!tuple(record) || record.id !== id || !same(record, expected)) throw new Error("Exact-session adoption requires an immutable operator authorization record bound to the exact adoption tuple.");
  if (await used(root, id)) throw new Error("Exact-session adoption authorization record was already used.");
  return { id, hash: storedHash };
}
