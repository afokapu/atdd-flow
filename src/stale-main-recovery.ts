// URN: component:flow:e021:stale-main-recovery:backend:integration
// Tested-By:
// - test:atdd-flow:stale-main-binding-recovery
// - test:atdd-flow:stale-main-recovery-resumed
// - test:atdd-flow:stale-main-source-exited-path-a
// Runtime: bun
// Purpose: Evidence rules for operator-authorized stale-main Pi binding recovery.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type Runtime, type Seat, yaml } from "./core";
import type { HandoverReplacementRequest, LiveSourceProof } from "./handover";

/**
 * Operator-authorized recovery of a main seat whose recorded Pi is stale while a
 * newer Pi holds the exact canonical pane. The request names both sources and the
 * stale launch receipt, archived by content hash.
 */
export type StaleMainRecovery = {
  canonical_source: { pi_session: string; pi_session_path: string; herdr_session: string; pane: string; cwd: string; launch_receipt: string };
  prior_receipt: { path: string; sha256: string; archive: string };
  /** A superseded active request that no longer matches the recorded runtime, preserved by hash. */
  prior_request?: { path: string; sha256: string; archive: string; source_exited?: SourceExited };
  live_source: LiveSourceProof;
};

/** Proof that a runtime-matching prior request's recorded source Pi was absent from every live Pi agent when it was replaced. */
export type SourceExited = { pi_session: string; pi_session_path: string; herdr_session: string; pane: string; verified_at: string };

type Source = HandoverReplacementRequest["source"];
type Target = HandoverReplacementRequest["target"];
type PriorReceipt = { schema?: string; seat?: string; pi_session?: string; pi_session_path?: string; herdr_session?: string; pane?: string };

const sha256 = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");

/** A complete recorded herdr runtime with a receipt, or no recovery is possible. */
function completeRuntime(runtime: Runtime | undefined) {
  const locator = runtime?.addresses.herdr;
  if (runtime?.application !== "herdr" || typeof locator === "string" || !locator
    || !runtime.pi_session || !runtime.pi_session_path || !runtime.launch_receipt) {
    throw new Error("Stale main recovery requires a complete canonical main runtime receipt.");
  }
  return { locator, session: runtime.pi_session, sessionPath: runtime.pi_session_path, receipt: runtime.launch_receipt };
}

/** The stale source is the recorded runtime in the exact target pane; the live source must be a different Pi. */
export function staleCanonicalSource(record: Seat, source: Source, target: Target): StaleMainRecovery["canonical_source"] {
  const { locator, session, sessionPath, receipt } = completeRuntime(record.runtime);
  if (locator.session !== target.herdr_session || locator.pane !== target.pane) {
    throw new Error("Stale main recovery target must be the recorded canonical Herdr placement.");
  }
  if (session === source.pi_session || sessionPath === source.pi_session_path) {
    throw new Error("Stale main recovery requires a live source that differs from the recorded runtime; use the ordinary Path-A replacement.");
  }
  return { pi_session: session, pi_session_path: sessionPath, herdr_session: locator.session, pane: locator.pane, cwd: target.cwd, launch_receipt: receipt };
}

/** The archived receipt must name exactly the recorded canonical seat, session, path and placement. */
export function receiptProvesCanonical(receipt: PriorReceipt, seat: string, canonical: StaleMainRecovery["canonical_source"]) {
  return receipt.schema === "atdd-flow/pi-runtime-launch-receipt/v1" && receipt.seat === seat
    && receipt.pi_session === canonical.pi_session && receipt.pi_session_path === canonical.pi_session_path
    && receipt.herdr_session === canonical.herdr_session && receipt.pane === canonical.pane;
}

const archivePath = (root: string, folder: string, seat: string, hash: string) => join(root, ".atdd-flow", folder, encodeURIComponent(seat), `${hash}.yaml`);

async function publishOrVerify(file: string, bytes: string) {
  await mkdir(dirname(file), { recursive: true });
  try { await writeFile(file, bytes, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
  if (await readFile(file, "utf8") !== bytes) throw new Error("Stale main recovery receipt archive collides with different immutable evidence.");
}

/** Preserve the stale receipt by content hash, create-only; an existing copy must be identical. */
export async function archiveStaleReceipt(root: string, seat: string, canonical: StaleMainRecovery["canonical_source"]): Promise<StaleMainRecovery["prior_receipt"]> {
  let bytes: string;
  try { bytes = await readFile(canonical.launch_receipt, "utf8"); }
  catch { throw new Error("Stale main recovery requires its immutable recorded launch receipt."); }
  if (!receiptProvesCanonical(yaml.parse<PriorReceipt>(bytes), seat, canonical)) {
    throw new Error("Stale main recovery recorded launch receipt does not prove the recorded canonical runtime.");
  }
  return { path: canonical.launch_receipt, ...await archiveBytes(root, "stale-main-receipt-archive", seat, bytes) };
}

async function archiveBytes(root: string, folder: string, seat: string, bytes: string) {
  const hash = sha256(bytes), archive = archivePath(root, folder, seat, hash);
  await publishOrVerify(archive, bytes);
  return { sha256: hash, archive };
}

/**
 * An existing active request may be replaced when it no longer matches the recorded runtime. A request that still
 * matches is replaceable only when its recorded source is exactly the stale canonical source, which the caller has
 * already proven absent from every live Pi agent. The old bytes are archived by hash with that source-exit evidence.
 */
async function archivePriorRequest(root: string, seat: string, file: string, isLive: (request: HandoverReplacementRequest) => boolean, exit: { canonical: StaleMainRecovery["canonical_source"]; verifiedAt: string }) {
  let bytes: string;
  try { bytes = await readFile(file, "utf8"); } catch { return undefined; }
  const prior = yaml.parse<HandoverReplacementRequest>(bytes);
  const matching = isLive(prior), exited = matching && sourceIsCanonical(prior.source, exit.canonical);
  if (prior.seat !== seat || (matching && !exited)) throw new Error("A live Path-A replacement request already exists; stale main recovery only replaces a request that no longer matches the recorded runtime or whose matching source has exited.");
  const source_exited = exited ? sourceExited(exit.canonical, exit.verifiedAt) : undefined;
  return { path: file, ...await archiveBytes(root, "stale-main-request-archive", seat, bytes), ...(source_exited ? { source_exited } : {}) };
}

function sourceIsCanonical(source: Source, canonical: StaleMainRecovery["canonical_source"]) {
  return source.pi_session === canonical.pi_session && source.pi_session_path === canonical.pi_session_path
    && source.herdr_session === canonical.herdr_session && source.pane === canonical.pane;
}

const sourceExited = (canonical: StaleMainRecovery["canonical_source"], verified_at: string): SourceExited =>
  ({ pi_session: canonical.pi_session, pi_session_path: canonical.pi_session_path, herdr_session: canonical.herdr_session, pane: canonical.pane, verified_at });

/** Swap the active request through a staged file so readers never observe a partial request. */
export async function replaceActiveRequest(file: string, content: string) {
  const staged = `${file}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(staged, content, { encoding: "utf8", flag: "wx" }); await rename(staged, file); }
  finally { await rm(staged, { force: true }); }
}

/** An archive file must still hash to its recorded digest. */
async function archiveIntact(prior: { sha256: string; archive: string }) {
  try { return sha256(await readFile(prior.archive, "utf8")) === prior.sha256; } catch { return false; }
}

/** The archived receipt must prove the canonical source, and any archived prior request must be intact. */
export async function archivedReceiptMatches(request: HandoverReplacementRequest, recovery: StaleMainRecovery) {
  try {
    const bytes = await readFile(recovery.prior_receipt.archive, "utf8");
    const priorRequest = !recovery.prior_request || await archiveIntact(recovery.prior_request);
    return priorRequest && await archiveIntact(recovery.prior_receipt) && receiptProvesCanonical(yaml.parse<PriorReceipt>(bytes), request.seat, recovery.canonical_source);
  } catch { return false; }
}

function placementMatches(runtime: Runtime | undefined, canonical: StaleMainRecovery["canonical_source"]) {
  const locator = runtime?.addresses.herdr;
  return runtime?.application === "herdr" && typeof locator !== "string"
    && locator?.session === canonical.herdr_session && locator.pane === canonical.pane;
}

function sessionMatches(runtime: Runtime | undefined, recovery: StaleMainRecovery) {
  const canonical = recovery.canonical_source;
  return runtime?.pi_session === canonical.pi_session && runtime.pi_session_path === canonical.pi_session_path
    && runtime.launch_receipt === canonical.launch_receipt && recovery.prior_receipt.path === runtime.launch_receipt;
}

function targetMatches(request: HandoverReplacementRequest, canonical: StaleMainRecovery["canonical_source"]) {
  return canonical.cwd === request.target.cwd && canonical.herdr_session === request.target.herdr_session
    && canonical.pane === request.target.pane && canonical.pi_session !== request.source.pi_session;
}

function snapshotMatches(request: HandoverReplacementRequest, live: LiveSourceProof) {
  return live.authorization_hash === request.authorization.hash && live.pi_session === request.source.pi_session
    && live.pi_session_path === request.source.pi_session_path && live.herdr_session === request.source.herdr_session
    && live.pane === request.source.pane && live.cwd === request.target.cwd && Boolean(live.agent && live.verified_at);
}

function exitMatches(recovery: StaleMainRecovery) {
  const exited = recovery.prior_request?.source_exited;
  return !exited || (sourceIsCanonical({ ...exited }, recovery.canonical_source) && Boolean(exited.verified_at));
}

function archiveNamed(prior: { sha256: string; archive: string } | undefined) {
  return !prior || (/^[a-f0-9]{64}$/i.test(prior.sha256) && basename(prior.archive) === `${prior.sha256}.yaml`);
}

/** Request, canonical source and live-source snapshot must describe one exact target tuple. */
export function recoveryEvidenceMatches(request: HandoverReplacementRequest, recovery: StaleMainRecovery) {
  return targetMatches(request, recovery.canonical_source) && snapshotMatches(request, recovery.live_source) && archiveNamed(recovery.prior_receipt) && archiveNamed(recovery.prior_request) && exitMatches(recovery);
}

/** The recorded runtime must still be the exact stale canonical source named by the recovery request. */
export function staleRecoveryMatches(runtime: Runtime | undefined, request: HandoverReplacementRequest, recovery: StaleMainRecovery) {
  return placementMatches(runtime, recovery.canonical_source) && sessionMatches(runtime, recovery) && recoveryEvidenceMatches(request, recovery);
}

/** Build the recovery record: verify the live source (injected), then archive the stale receipt and any stale active request by hash. */
export async function buildStaleMainRecovery(root: string, seat: string, intent: { record: Seat; source: Source; target: Target }, active: { file: string; isLive: (request: HandoverReplacementRequest) => boolean }, verify: (canonical: StaleMainRecovery["canonical_source"]) => Promise<LiveSourceProof>): Promise<StaleMainRecovery> {
  const canonical = staleCanonicalSource(intent.record, intent.source, intent.target);
  const live_source = await verify(canonical);
  const prior_request = await archivePriorRequest(root, seat, active.file, active.isLive, { canonical, verifiedAt: live_source.verified_at });
  return { canonical_source: canonical, prior_receipt: await archiveStaleReceipt(root, seat, canonical), ...(prior_request ? { prior_request } : {}), live_source };
}
