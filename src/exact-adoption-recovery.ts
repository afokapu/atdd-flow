// URN: component:flow:e006:exact-adoption-recovery:backend:integration
// Tested-By:
// - test:flow:exact-adoption-resumed-proof-and-relaunch
// Runtime: bun
// Purpose: Classify the immutable evidence for one exact Path-A adoption and recovery.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type Seat, paths, readYaml, yaml } from "./core";
import type { HandoverReplacementRequest } from "./handover";
import { readRuntimeState } from "./runtime-state";
import { archivedReceiptMatches, recoveryEvidenceMatches } from "./stale-main-recovery";
import type { Task } from "./tasks";

type ReplacementLaunchReceipt = {
  schema?: string;
  seat?: string;
  tasks?: string[];
  pi_session?: string;
  pi_session_path?: string;
  herdr_session?: string;
  pane?: string;
  handover_replacement?: { request?: HandoverReplacementRequest; successor_session?: string };
  relocation?: {
    source_herdr_session?: string;
    source_pane?: string;
    authorization?: { id?: string; hash?: string };
    backup?: string;
    backup_sha256?: string;
  };
  created_at?: string;
};

type CanonicalSource = NonNullable<NonNullable<HandoverReplacementRequest["supersession"]>["canonical_source"]>;
type TaskEligibility = (task: Task) => boolean | Promise<boolean>;

/** Hash bytes exactly as the immutable records were published. */
function digest(content: string | Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

/** Match both the authorization content and its separately stored digest. */
async function exactAuthorizationMatches(root: string, request: HandoverReplacementRequest) {
  const id = request.authorization.id;
  const folder = join(root, ".atdd-flow", "exact-session-adoption-authorizations");
  try {
    const raw = await readFile(join(folder, `${id}.yaml`), "utf8");
    const storedHash = (await readFile(join(folder, `${id}.sha256`), "utf8")).trim();
    const record = object(yaml.parse<unknown>(raw));
    const source = object(record?.source), target = object(record?.target);
    const observed = {
      storedHash, contentHash: digest(raw), schema: record?.schema, id: record?.id, issuedBy: record?.issued_by,
      seat: record?.seat, session: record?.pi_session, sessionPath: record?.pi_session_path,
      sourceSession: source?.herdr_session, sourcePane: source?.pane,
      targetSession: target?.herdr_session, targetPane: target?.pane, targetCwd: target?.cwd,
    };
    const expected = {
      storedHash: request.authorization.hash, contentHash: request.authorization.hash,
      schema: "atdd-flow/exact-session-adoption-authorization/v1", id, issuedBy: "operator@desk",
      seat: request.seat, session: request.source.pi_session, sessionPath: request.source.pi_session_path,
      sourceSession: request.source.herdr_session, sourcePane: request.source.pane,
      targetSession: request.target.herdr_session, targetPane: request.target.pane, targetCwd: request.target.cwd,
    };
    return JSON.stringify(observed) === JSON.stringify(expected);
  } catch { return false; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Validate the prior canonical receipt without trusting the active adopted receipt. */
function receiptMatchesCanonical(receipt: ReplacementLaunchReceipt, seat: string, canonical: CanonicalSource) {
  return receipt.schema === "atdd-flow/pi-runtime-launch-receipt/v1" && receipt.seat === seat
    && receipt.pi_session === canonical.pi_session && receipt.pi_session_path === canonical.pi_session_path
    && receipt.herdr_session === canonical.herdr_session && receipt.pane === canonical.pane;
}

/** Bind the archived prior receipt to its archived request and successor. */
function receiptProvesRequest(receipt: ReplacementLaunchReceipt, request: HandoverReplacementRequest, canonical: CanonicalSource) {
  return Array.isArray(receipt.tasks) && receipt.tasks.includes(request.task)
    && receipt.handover_replacement?.successor_session === canonical.pi_session
    && JSON.stringify(receipt.handover_replacement.request) === JSON.stringify(request);
}

function validConsumedRequest(request: HandoverReplacementRequest, seat: string) {
  return request.schema === "atdd-flow/context-handover-replacement-request/v1" && request.seat === seat
    && Boolean(request.task && request.handover?.id && request.handover.sha256);
}

/** Rebuild and compare every archived supersession byte and identity. */
async function exactArchiveMatches(request: HandoverReplacementRequest) {
  // Stale-main recovery proves its evidence by the hash-archived stale receipt, not a consumed request.
  const recovery = request.stale_main_recovery;
  if (recovery) return recoveryEvidenceMatches(request, recovery) && await archivedReceiptMatches(request, recovery);
  const proof = request.supersession;
  if (!proof) return false;
  try {
    const requestPath = join(proof.prior_request.archive, "request.yaml");
    const receiptPath = join(proof.prior_request.archive, "launch-receipt.yaml");
    const manifestPath = join(proof.prior_request.archive, "supersession.yaml");
    const [files, requestBytes, receiptBytes, manifestBytes] = await Promise.all([
      readdir(proof.prior_request.archive), readFile(requestPath, "utf8"),
      readFile(receiptPath, "utf8"), readFile(manifestPath, "utf8"),
    ]);
    const archivedRequest = yaml.parse<HandoverReplacementRequest>(requestBytes);
    const archivedReceipt = yaml.parse<ReplacementLaunchReceipt>(receiptBytes);
    const manifest = yaml.print({
      schema: "atdd-flow/context-handover-replacement-supersession/v1", seat: request.seat,
      prior_request: {
        path: proof.prior_request.path, sha256: proof.prior_request.sha256, task: proof.prior_request.task,
        handover: proof.prior_request.handover, handover_sha256: proof.prior_request.handover_sha256,
      },
      prior_receipt: proof.prior_receipt,
    });
    return [
      files.sort().join("\n") === ["launch-receipt.yaml", "request.yaml", "supersession.yaml"].join("\n"),
      basename(proof.prior_request.archive) === proof.prior_request.sha256,
      digest(requestBytes) === proof.prior_request.sha256,
      digest(receiptBytes) === proof.prior_receipt.sha256,
      manifestBytes === manifest,
      validConsumedRequest(archivedRequest, request.seat),
      archivedRequest.task === proof.prior_request.task,
      archivedRequest.handover.id === proof.prior_request.handover,
      archivedRequest.handover.sha256 === proof.prior_request.handover_sha256,
      receiptMatchesCanonical(archivedReceipt, request.seat, proof.canonical_source),
      receiptProvesRequest(archivedReceipt, archivedRequest, proof.canonical_source),
    ].every(Boolean);
  } catch { return false; }
}

/** A single authorization may identify exactly one adoption receipt. */
async function uniqueAdoptionReceipt(root: string, authorizationId: string, expectedPath: string) {
  try {
    const folder = join(root, ".atdd-flow", "runtime-launch");
    const candidates: string[] = [];
    for (const file of await readdir(folder)) {
      if (!file.endsWith(".yaml")) continue;
      const path = join(folder, file);
      try {
        const receipt = yaml.parse<ReplacementLaunchReceipt>(await readFile(path, "utf8"));
        if (receipt.relocation?.authorization?.id === authorizationId) candidates.push(path);
      } catch { /* Malformed receipts cannot prove exact adoption. */ }
    }
    return candidates.length === 1 && resolve(candidates[0]!) === resolve(expectedPath);
  } catch { return false; }
}

/** The failed adopted runtime retains source identity at the exact target pane. */
function exactAdoptionRuntimeMatches(record: Seat, request: HandoverReplacementRequest) {
  const runtime = record.runtime, locator = runtime?.addresses.herdr;
  const observed = {
    supersession: Boolean(request.supersession || request.stale_main_recovery), application: runtime?.application, wake: runtime?.wake,
    session: runtime?.pi_session, sessionPath: runtime?.pi_session_path,
    herdrSession: typeof locator === "string" ? undefined : locator?.session,
    pane: typeof locator === "string" ? undefined : locator?.pane,
  };
  const expected = {
    supersession: true, application: "herdr", wake: "native",
    session: request.source.pi_session, sessionPath: request.source.pi_session_path,
    herdrSession: request.target.herdr_session, pane: request.target.pane,
  };
  return JSON.stringify(observed) === JSON.stringify(expected);
}

/** Require the active request and receipt to describe one exact relocation. */
function exactAdoptionReceiptMatches(receipt: ReplacementLaunchReceipt, activeBytes: string, address: string, request: HandoverReplacementRequest) {
  const relocation = receipt.relocation;
  return [
    activeBytes === yaml.print(request),
    yaml.print(receipt.handover_replacement?.request) === activeBytes,
    receipt.schema === "atdd-flow/pi-runtime-launch-receipt/v1",
    receipt.seat === address,
    receipt.tasks?.length === 1,
    receipt.tasks?.[0] === request.task,
    receipt.pi_session === request.source.pi_session,
    receipt.pi_session_path === request.source.pi_session_path,
    receipt.herdr_session === request.target.herdr_session,
    receipt.pane === request.target.pane,
    receipt.handover_replacement?.successor_session === request.source.pi_session,
    relocation?.source_herdr_session === request.source.herdr_session,
    relocation?.source_pane === request.source.pane,
    relocation?.authorization?.id === request.authorization.id,
    relocation?.authorization?.hash === request.authorization.hash,
    Boolean(relocation?.backup), Boolean(relocation?.backup_sha256), Boolean(receipt.created_at),
  ].every(Boolean);
}

/** Prove the immutable recovery copy is the prefix of the adopted source JSONL. */
async function exactBackupMatches(receipt: ReplacementLaunchReceipt, request: HandoverReplacementRequest) {
  const relocation = receipt.relocation!;
  const [backup, source] = await Promise.all([readFile(relocation.backup!), readFile(request.source.pi_session_path)]);
  return digest(backup) === relocation.backup_sha256
    && source.length >= backup.length
    && source.subarray(0, backup.length).equals(backup);
}

/** A live same-identity adoption is fresh only after its receipt and start. */
function freshAdoptionHeartbeat(runtimeState: Awaited<ReturnType<typeof readRuntimeState>>, receipt: ReplacementLaunchReceipt, address: string, cwd: string) {
  if (!runtimeState) return false;
  return [
    runtimeState.seat === address,
    resolve(runtimeState.cwd) === resolve(cwd),
    Date.parse(runtimeState.started_at) >= Date.parse(receipt.created_at!),
    Date.parse(runtimeState.heartbeat_at) >= Date.parse(runtimeState.started_at),
  ].every(Boolean);
}

/**
 * Classify only the complete immutable evidence emitted by one exact Path-A
 * adoption. The caller supplies the narrow task lifecycle accepted at its
 * boundary; every receipt, archive, authorization, backup, and runtime check
 * remains shared by adopted RESUMED proof and failed-adoption relaunch.
 * Missing or contradictory evidence always returns no classification.
 */
export async function exactFailedAdoptionProof(root: string, record: Seat, address: string, request: HandoverReplacementRequest, taskEligible: TaskEligibility) {
  const receiptPath = record.runtime?.launch_receipt;
  if (!receiptPath || !exactAdoptionRuntimeMatches(record, request)) return undefined;
  try {
    const activePath = join(root, ".atdd-flow", "handover-replacements", `${encodeURIComponent(address)}.yaml`);
    const [activeBytes, receiptBytes, runtimeState, task] = await Promise.all([
      readFile(activePath, "utf8"), readFile(receiptPath, "utf8"), readRuntimeState(root, address),
      readYaml<Task>(paths(root).taskFile(record.project, request.task)),
    ]);
    const receipt = yaml.parse<ReplacementLaunchReceipt>(receiptBytes);
    const evidence = [
      exactAdoptionReceiptMatches(receipt, activeBytes, address, request),
      await taskEligible(task),
      await exactAuthorizationMatches(root, request),
      await exactArchiveMatches(request),
      await uniqueAdoptionReceipt(root, request.authorization.id, receiptPath),
      await exactBackupMatches(receipt, request),
    ];
    if (!evidence.every(Boolean)) return undefined;
    return { receipt, runtimeState, heartbeat: freshAdoptionHeartbeat(runtimeState, receipt, address, request.target.cwd) };
  } catch { return undefined; }
}
