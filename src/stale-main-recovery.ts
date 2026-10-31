// URN: component:flow:e021:stale-main-recovery:backend:integration
// Tested-By:
// - test:atdd-flow:stale-main-binding-recovery
// - test:atdd-flow:stale-main-recovery-resumed
// - test:atdd-flow:stale-main-source-exited-path-a
// - test:atdd-flow:stale-main-s1-exited-recovery
// - test:atdd-flow:relocated-receipt-stale-main-recovery
// Runtime: bun
// Purpose: Evidence rules for operator-authorized stale-main Pi binding recovery.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type Runtime, type Seat, runOutput, yaml } from "./core";
import type { HandoverReplacementRequest, LiveSourceProof } from "./handover";

/**
 * Operator-authorized recovery of a main seat whose recorded Pi is stale while a
 * newer Pi holds the exact canonical pane. The request names both sources and the
 * stale launch receipt, archived by content hash.
 */
export type StaleMainRecovery = {
  canonical_source: { pi_session: string; pi_session_path: string; herdr_session: string; pane: string; cwd: string; launch_receipt: string };
  prior_receipt: { path: string; sha256: string; archive: string };
  /** A superseded active request, preserved by hash; `live_source_exited` proves an active recovery request's own live source Pi was absent from every live Pi agent when a newer source replaced it. */
  prior_request?: { path: string; sha256: string; archive: string; source_exited?: SourceExited; live_source_exited?: SourceExited };
  /** Absent only for a pane-gone relocation, whose source is proven absent rather than live. */
  live_source?: LiveSourceProof;
  /** Present only for a relocated main: an operator manual rebinding receipt, or a launcher receipt whose retired pane is gone. */
  relocation?: Relocation;
};

export const MANUAL_REBINDING_SCHEMA = "atdd-flow/manual-pi-runtime-rebinding-receipt/v1";
export const MANUAL_REBINDING_MODE = "operator-authorized-manual-in-place-adoption";

/** Relocation mode of a launcher-generated receipt whose canonical pane and exact Pi are both absent from Herdr. */
export const PANE_GONE_MODE = "launcher-receipt-pane-gone";

/** The retired placement named by the receipt; lineage only, never a live source. A pane-gone relocation also records the global absence proof. */
export type Relocation = { mode: string; retired: { herdr_session: string; pane: string }; absence?: { authorization_hash: string; verified_at: string } };

/** Proof that a runtime-matching prior request's recorded source Pi was absent from every live Pi agent when it was replaced. */
export type SourceExited = { pi_session: string; pi_session_path: string; herdr_session: string; pane: string; verified_at: string };

type Run = (argv: string[]) => Promise<string>;
type Recorded = { session: string; sessionPath: string; locator: { session: string; pane: string } };
type Source = HandoverReplacementRequest["source"];
type Target = HandoverReplacementRequest["target"];
type PriorReceipt = {
  schema?: string; seat?: string; pi_session?: string; pi_session_path?: string; herdr_session?: string; pane?: string;
  mode?: string; authorized_by?: string; authorization?: string;
  target?: { cwd?: string; pi_session?: string; pi_session_path?: string; herdr_session?: string; pane?: string };
  backup?: { path?: string; bytes?: number; sha256?: string };
};

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
export function receiptProvesCanonical(receipt: PriorReceipt, seat: string, canonical: StaleMainRecovery["canonical_source"], relocation?: Relocation) {
  if (relocation?.mode === PANE_GONE_MODE) return launchReceiptProvesCanonical(receipt, seat, { ...canonical, ...relocation.retired });
  return relocation ? manualReceiptProvesCanonical(receipt, seat, canonical, relocation) : launchReceiptProvesCanonical(receipt, seat, canonical);
}

function launchReceiptProvesCanonical(receipt: PriorReceipt, seat: string, canonical: StaleMainRecovery["canonical_source"]) {
  return receipt.schema === "atdd-flow/pi-runtime-launch-receipt/v1" && receipt.seat === seat
    && receipt.pi_session === canonical.pi_session && receipt.pi_session_path === canonical.pi_session_path
    && receipt.herdr_session === canonical.herdr_session && receipt.pane === canonical.pane;
}

function manualReceiptProvesCanonical(receipt: PriorReceipt, seat: string, canonical: StaleMainRecovery["canonical_source"], relocation: Relocation) {
  return receipt.schema === MANUAL_REBINDING_SCHEMA && receipt.seat === seat && receipt.mode === relocation.mode
    && receipt.pi_session === canonical.pi_session && receipt.pi_session_path === canonical.pi_session_path
    && receipt.herdr_session === relocation.retired.herdr_session && receipt.pane === relocation.retired.pane;
}

const archivePath = (root: string, folder: string, seat: string, hash: string) => join(root, ".atdd-flow", folder, encodeURIComponent(seat), `${hash}.yaml`);

async function publishOrVerify(file: string, bytes: string) {
  await mkdir(dirname(file), { recursive: true });
  try { await writeFile(file, bytes, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
  if (await readFile(file, "utf8") !== bytes) throw new Error("Stale main recovery receipt archive collides with different immutable evidence.");
}

/** Preserve the stale receipt by content hash, create-only; an existing copy must be identical. */
export async function archiveStaleReceipt(root: string, seat: string, canonical: StaleMainRecovery["canonical_source"], relocation?: Relocation): Promise<StaleMainRecovery["prior_receipt"]> {
  let bytes: string;
  try { bytes = await readFile(canonical.launch_receipt, "utf8"); }
  catch { throw new Error("Stale main recovery requires its immutable recorded launch receipt."); }
  if (!receiptProvesCanonical(yaml.parse<PriorReceipt>(bytes), seat, canonical, relocation)) {
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
async function archivePriorRequest(root: string, seat: string, file: string, isLive: (request: HandoverReplacementRequest) => boolean, exit: { canonical: StaleMainRecovery["canonical_source"]; source: Source; verifiedAt: string; assertAbsent: (source: Source) => Promise<void> }) {
  let bytes: string;
  try { bytes = await readFile(file, "utf8"); } catch { return undefined; }
  const prior = yaml.parse<HandoverReplacementRequest>(bytes);
  const kind = priorKind(prior, isLive, exit);
  if (prior.seat !== seat || kind === "live") throw new Error("A live Path-A replacement request already exists; stale main recovery only replaces a request that no longer matches the recorded runtime or whose matching source has exited.");
  if (kind === "live_source_exited") await exit.assertAbsent(prior.source);
  const proof = kind === "source_exited" ? { source_exited: sourceExited(exit.canonical, exit.verifiedAt) }
    : kind === "live_source_exited" ? { live_source_exited: sourceExited(prior.source, exit.verifiedAt) } : {};
  return { path: file, ...await archiveBytes(root, "stale-main-request-archive", seat, bytes), ...proof };
}

/** How an active request relates to the recorded runtime: replaceable as-is, by proven exit of a named source, or still live. */
function priorKind(prior: HandoverReplacementRequest, isLive: (request: HandoverReplacementRequest) => boolean, exit: { canonical: StaleMainRecovery["canonical_source"]; source: Source }) {
  if (!isLive(prior)) return "unmatched";
  if (sourceIsCanonical(prior.source, exit.canonical)) return "source_exited";
  return prior.stale_main_recovery && !sameSource(prior.source, exit.source) ? "live_source_exited" : "live";
}

/** Stale-main recovery proves S0 and any replaced S1 absent from one complete global agent-list snapshot, read once. */
function agentListOnce() {
  let list: Promise<string> | undefined;
  return <T extends { command?: Run }>(dependencies: T): T => {
    const run = dependencies.command ?? runOutput;
    return { ...dependencies, command: (argv: string[]) => argv.slice(3, 5).join(" ") === "agent list" ? (list ??= run(argv)) : run(argv) };
  };
}

function sameSource(a: Source, b: Source) {
  return a.pi_session === b.pi_session && a.pi_session_path === b.pi_session_path;
}

function sourceIsCanonical(source: Source, canonical: StaleMainRecovery["canonical_source"]) {
  return source.pi_session === canonical.pi_session && source.pi_session_path === canonical.pi_session_path
    && source.herdr_session === canonical.herdr_session && source.pane === canonical.pane;
}

const sourceExited = (source: Source, verified_at: string): SourceExited =>
  ({ pi_session: source.pi_session, pi_session_path: source.pi_session_path, herdr_session: source.herdr_session, pane: source.pane, verified_at });

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
    return priorRequest && await archiveIntact(recovery.prior_receipt) && receiptProvesCanonical(yaml.parse<PriorReceipt>(bytes), request.seat, recovery.canonical_source, recovery.relocation);
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

function targetMatches(request: HandoverReplacementRequest, canonical: StaleMainRecovery["canonical_source"], relocation?: Relocation) {
  if (relocation) return relocatedTargetMatches(request, canonical, relocation);
  return canonical.cwd === request.target.cwd && canonical.herdr_session === request.target.herdr_session
    && canonical.pane === request.target.pane && canonical.pi_session !== request.source.pi_session;
}

/** A relocated request names the exact recorded Pi at the retired pane, and moves to the current pane that Herdr observed it on. */
function relocatedTargetMatches(request: HandoverReplacementRequest, canonical: StaleMainRecovery["canonical_source"], relocation: Relocation) {
  return [MANUAL_REBINDING_MODE, PANE_GONE_MODE].includes(relocation.mode)
    && canonical.cwd === request.target.cwd && canonical.herdr_session === request.target.herdr_session && canonical.pane === request.target.pane
    && request.source.pi_session === canonical.pi_session && request.source.pi_session_path === canonical.pi_session_path
    && request.source.herdr_session === relocation.retired.herdr_session && request.source.pane === relocation.retired.pane
    && (relocation.retired.herdr_session !== canonical.herdr_session || relocation.retired.pane !== canonical.pane);
}

/** A pane-gone relocation has no live source: its absence proof must be bound to this request's authorization. */
function absenceMatches(request: HandoverReplacementRequest, relocation: Relocation) {
  return relocation.absence?.authorization_hash === request.authorization.hash && Boolean(relocation.absence.verified_at);
}

function snapshotMatches(request: HandoverReplacementRequest, live: LiveSourceProof | undefined, relocation?: Relocation) {
  if (relocation?.mode === PANE_GONE_MODE) return !live && absenceMatches(request, relocation);
  return live !== undefined && liveSnapshotMatches(request, live, relocation);
}

function liveSnapshotMatches(request: HandoverReplacementRequest, live: LiveSourceProof, relocation?: Relocation) {
  const placement = relocation ? request.target : request.source;
  return live.authorization_hash === request.authorization.hash && live.pi_session === request.source.pi_session
    && live.pi_session_path === request.source.pi_session_path && live.herdr_session === placement.herdr_session
    && live.pane === placement.pane && live.cwd === request.target.cwd && Boolean(live.agent && live.verified_at);
}

function exitMatches(recovery: StaleMainRecovery) {
  const exited = recovery.prior_request?.source_exited, replaced = recovery.prior_request?.live_source_exited;
  return (!exited || (sourceIsCanonical({ ...exited }, recovery.canonical_source) && Boolean(exited.verified_at)))
    && (!replaced || (!(recovery.live_source && sameSource(replaced, recovery.live_source)) && !sourceIsCanonical({ ...replaced }, recovery.canonical_source) && Boolean(replaced.verified_at)));
}

function archiveNamed(prior: { sha256: string; archive: string } | undefined) {
  return !prior || (/^[a-f0-9]{64}$/i.test(prior.sha256) && basename(prior.archive) === `${prior.sha256}.yaml`);
}

/** Request, canonical source and live-source snapshot must describe one exact target tuple. */
export function recoveryEvidenceMatches(request: HandoverReplacementRequest, recovery: StaleMainRecovery) {
  return targetMatches(request, recovery.canonical_source, recovery.relocation) && snapshotMatches(request, recovery.live_source, recovery.relocation) && archiveNamed(recovery.prior_receipt) && archiveNamed(recovery.prior_request) && exitMatches(recovery);
}

/** The recorded runtime must still be the exact stale canonical source named by the recovery request. */
export function staleRecoveryMatches(runtime: Runtime | undefined, request: HandoverReplacementRequest, recovery: StaleMainRecovery) {
  return placementMatches(runtime, recovery.canonical_source) && sessionMatches(runtime, recovery) && recoveryEvidenceMatches(request, recovery);
}

/** Build the recovery record: verify the live source (injected), then archive the stale receipt and any stale active request by hash. */
export async function buildStaleMainRecovery(root: string, seat: string, intent: { record: Seat; source: Source; target: Target; relocation?: Relocation }, active: { file: string; isLive: (request: HandoverReplacementRequest) => boolean }, verify: (absent: Pick<Source, "pi_session" | "pi_session_path">, once: ReturnType<typeof agentListOnce>) => Promise<LiveSourceProof>, agentList: () => Promise<string>, gone: PaneGoneObservation): Promise<StaleMainRecovery> {
  if (intent.relocation?.mode === PANE_GONE_MODE) return buildPaneGoneStaleMainRecovery(root, seat, intent, intent.relocation, active, { agentList, ...gone });
  if (intent.relocation) return buildRelocatedStaleMainRecovery(root, seat, intent, intent.relocation, active, { verify: () => verify(intent.source, agentListOnce()), agentList });
  const canonical = staleCanonicalSource(intent.record, intent.source, intent.target);
  const once = agentListOnce(), live_source = await verify(canonical, once);
  const prior_request = await archivePriorRequest(root, seat, active.file, active.isLive, { canonical, source: intent.source, verifiedAt: live_source.verified_at, assertAbsent: async (source) => { await verify(source, once); } });
  return { canonical_source: canonical, prior_receipt: await archiveStaleReceipt(root, seat, canonical), ...(prior_request ? { prior_request } : {}), live_source };
}


const refuse = (reason: string) => new Error(`Stale main relocation receipt recovery refused: ${reason}.`);

/** True when the seat records a manual binding_mode or its launch receipt is a manual rebinding receipt, rather than a launcher receipt. */
export async function isManualRebindingReceipt(record: Seat) {
  const path = record.runtime?.launch_receipt;
  if (!path) return false;
  if (record.runtime?.binding_mode !== undefined) return true;
  try { return yaml.parse<PriorReceipt>(await readFile(path, "utf8")).schema === MANUAL_REBINDING_SCHEMA; } catch { return false; }
}

/** A backup file must hash to its recorded digest (and size, when recorded) and be the exact byte prefix of the adopted session transcript. */
export async function backupIsTranscriptPrefix(backup: { path?: string; sha256?: string; bytes?: number }, transcriptPath: string) {
  try {
    const [saved, transcript] = await Promise.all([readFile(backup.path!), readFile(transcriptPath)]);
    return sha256(saved) === backup.sha256 && (backup.bytes === undefined || backup.bytes === saved.length)
      && transcript.length >= saved.length && transcript.subarray(0, saved.length).equals(saved);
  } catch { return false; }
}

/** An existing stale active request must retain exactly the retired placement of the recorded Pi. */
async function priorRequestIsRetiredLineage(file: string, receipt: PriorReceipt) {
  let bytes: string;
  try { bytes = await readFile(file, "utf8"); } catch { return true; }
  try {
    const { source, target } = yaml.parse<HandoverReplacementRequest>(bytes);
    return source.pi_session === receipt.pi_session && source.pi_session_path === receipt.pi_session_path
      && [source, target].every((placement) => placement.herdr_session === receipt.herdr_session && placement.pane === receipt.pane);
  } catch { return false; }
}

type Check = [boolean, string];
const firstFailure = (checks: Check[]) => checks.find(([ok]) => !ok)?.[1];

/** The recorded receipt is a complete operator-authorized manual rebinding receipt whose mode equals the seat binding_mode. */
function authorityFailure(receipt: PriorReceipt, record: Seat) {
  return firstFailure([
    [receipt.schema === MANUAL_REBINDING_SCHEMA, "the recorded receipt is not a manual rebinding receipt"],
    [receipt.seat === record.address, "the receipt names another seat"],
    [receipt.mode === MANUAL_REBINDING_MODE && record.runtime?.binding_mode === receipt.mode, "the receipt mode must equal the seat binding_mode"],
    [receipt.authorized_by === "operator@desk" && Boolean(receipt.authorization), "the receipt lacks operator@desk authorization"],
  ]);
}

/** The receipt describes the exact recorded Pi, the canonical worktree and one retired placement. */
function identityFailure(receipt: PriorReceipt, record: Seat, session: string, sessionPath: string) {
  const placement = receipt.target;
  return firstFailure([
    [receipt.pi_session === session && receipt.pi_session_path === sessionPath, "the receipt does not name the exact recorded Pi session"],
    [placement?.pi_session === session && placement.pi_session_path === sessionPath, "the receipt target does not name the exact recorded Pi session"],
    [Boolean(placement?.cwd) && resolve(placement!.cwd!) === resolve(record.worktree), "the receipt cwd is not the canonical main worktree"],
    [Boolean(receipt.pane) && placement?.herdr_session === receipt.herdr_session && placement.pane === receipt.pane, "the receipt placement is inconsistent"],
  ]);
}

/** The request moves the exact recorded Pi from the retired placement to the seat's current locator. */
function requestFailure(receipt: PriorReceipt, source: Source, target: Target, recorded: { session: string; sessionPath: string; locator: { session: string; pane: string } }) {
  return firstFailure([
    [source.pi_session === recorded.session && source.pi_session_path === recorded.sessionPath, "the request source is not the exact recorded Pi"],
    [source.herdr_session === receipt.herdr_session && source.pane === receipt.pane, "the request source must be the receipt's retired placement"],
    [target.herdr_session === recorded.locator.session && target.pane === recorded.locator.pane, "the request target must be the seat's current locator"],
  ]);
}

/**
 * Validate a relocated main before any authorization or Herdr evidence is consulted: the recorded receipt must be a
 * complete operator manual rebinding receipt whose mode equals the seat binding_mode, for the exact recorded Pi, whose
 * backup is a prefix of the adopted transcript, and whose retired placement is the request source and the stale request's
 * placement while the request target is the seat's current locator. Returns the lineage to record.
 */
export async function assertRelocatedBinding(record: Seat, source: Source, target: Target, activeFile: string): Promise<Relocation> {
  const { locator, session, sessionPath, receipt: path } = completeRuntime(record.runtime);
  let receipt: PriorReceipt;
  try { receipt = yaml.parse<PriorReceipt>(await readFile(path, "utf8")); } catch { throw refuse("the recorded relocation receipt is unreadable"); }
  const failure = authorityFailure(receipt, record) ?? identityFailure(receipt, record, session, sessionPath)
    ?? requestFailure(receipt, source, target, { session, sessionPath, locator })
    ?? firstFailure([
      [await backupIsTranscriptPrefix(receipt.backup ?? {}, receipt.pi_session_path!), "the receipt backup is missing, mismatched, or not a prefix of the adopted transcript"],
      [await priorRequestIsRetiredLineage(activeFile, receipt), "the stale active request does not retain the receipt's retired placement"],
    ]);
  if (failure) throw refuse(failure);
  return { mode: receipt.mode!, retired: { herdr_session: receipt.herdr_session!, pane: receipt.pane! } };
}

/** Build the relocated recovery record: the live source (injected) is the exact recorded Pi at the current locator. */
export async function buildRelocatedStaleMainRecovery(root: string, seat: string, intent: { record: Seat; source: Source; target: Target }, relocation: Relocation, active: { file: string }, observe: { verify: () => Promise<LiveSourceProof>; agentList: () => Promise<string> }): Promise<StaleMainRecovery> {
  const { locator, session, sessionPath, receipt } = completeRuntime(intent.record.runtime);
  const canonical = { pi_session: session, pi_session_path: sessionPath, herdr_session: locator.session, pane: locator.pane, cwd: intent.target.cwd, launch_receipt: receipt };
  let live_source: LiveSourceProof;
  try {
    live_source = await observe.verify();
    assertRelocatedAgentList(await observe.agentList(), intent.source, intent.target, relocation.retired);
  } catch (error) { throw refuse((error as Error).message.replace(/\.$/, "")); }
  const prior_request = await archivePriorRequest(root, seat, active.file, () => false, { canonical, source: intent.source, verifiedAt: live_source.verified_at, assertAbsent: async () => {} });
  const prior_receipt = await archiveStaleReceipt(root, seat, canonical, relocation);
  return { canonical_source: canonical, prior_receipt, ...(prior_request ? { prior_request } : {}), live_source, relocation };
}

/** Pi agents from one complete global Herdr agent list, each with its pane and exact session path; `who` names the refusing operation. */
export function listedPiAgents(raw: string, who: string) {
  const incomplete = () => new Error(`${who} requires complete global Herdr agent-list evidence.`);
  const parsed = JSON.parse(raw) as { result?: { agents?: unknown }; agents?: unknown };
  const agents = (parsed.result ?? parsed).agents;
  if (!Array.isArray(agents)) throw incomplete();
  return agents.filter((entry) => {
    if (!entry || typeof entry !== "object") throw incomplete();
    return (entry as { agent?: unknown }).agent === "pi";
  }).map((entry) => {
    const { pane_id, agent_session } = entry as { pane_id?: string; agent_session?: { kind?: string; value?: string } };
    if (agent_session?.kind !== "path" || !agent_session.value) throw incomplete();
    return { pane: pane_id, path: resolve(agent_session.value) };
  });
}

/** A relocated recovery requires the exact recorded Pi once, at the current pane, and no Pi at the retired pane. */
export function assertRelocatedAgentList(raw: string, source: Pick<Source, "pi_session_path">, current: { pane: string }, retired: { pane: string }) {
  const agents = listedPiAgents(raw, "Relocated recovery"), recorded = agents.filter((agent) => agent.path === resolve(source.pi_session_path));
  if (agents.some((agent) => agent.pane === retired.pane)) throw new Error("A Pi is live at the retired relocation pane.");
  if (recorded.some((agent) => agent.pane !== current.pane)) throw new Error("The recorded Pi is also live outside the current pane.");
  if (recorded.length !== 1) throw new Error("The recorded Pi must be listed exactly once at the current pane.");
}

/** A target pane that differs from the source pane is a relocation only for a manual binding or an exact pane-gone launcher receipt; otherwise undefined. */
export async function relocationFor(record: Seat, source: Source, target: Target, activeFile: string): Promise<Relocation | undefined> {
  if (target.pane === source.pane) return undefined;
  return await isManualRebindingReceipt(record) ? assertRelocatedBinding(record, source, target, activeFile) : assertPaneGoneBinding(record, source, target, activeFile);
}

async function readLauncherReceipt(path: string) {
  try {
    const receipt = yaml.parse<PriorReceipt>(await readFile(path, "utf8"));
    return receipt.schema === "atdd-flow/pi-runtime-launch-receipt/v1" ? receipt : undefined;
  } catch { return undefined; }
}

/** The launcher receipt names this seat's exact recorded Pi at a pane other than the seat's current locator. */
function receiptNamesRetiredPane(receipt: PriorReceipt, record: Seat, recorded: Recorded) {
  return receipt.seat === record.address && receipt.pi_session === recorded.session && receipt.pi_session_path === recorded.sessionPath
    && Boolean(receipt.herdr_session && receipt.pane) && (receipt.herdr_session !== recorded.locator.session || receipt.pane !== recorded.locator.pane);
}

/** The request moves the exact recorded Pi from the receipt's retired pane to the seat's current locator. */
function requestMovesRetiredPi(receipt: PriorReceipt, source: Source, target: Target, recorded: Recorded) {
  return source.pi_session === recorded.session && source.pi_session_path === recorded.sessionPath
    && source.herdr_session === receipt.herdr_session && source.pane === receipt.pane
    && target.herdr_session === recorded.locator.session && target.pane === recorded.locator.pane;
}

/** A launcher-generated receipt whose retired canonical pane is the request source while the request target is the seat's current locator; otherwise undefined, so the ordinary released-source-pane guard refuses. */
async function assertPaneGoneBinding(record: Seat, source: Source, target: Target, activeFile: string): Promise<Relocation | undefined> {
  const runtime = record.runtime, locator = runtime?.addresses.herdr;
  if (!runtime?.launch_receipt || typeof locator === "string" || !locator) return undefined;
  const receipt = await readLauncherReceipt(runtime.launch_receipt);
  if (!receipt || !runtime.pi_session || !runtime.pi_session_path) return undefined;
  const recorded = { session: runtime.pi_session, sessionPath: runtime.pi_session_path, locator };
  if (!receiptNamesRetiredPane(receipt, record, recorded) || !requestMovesRetiredPi(receipt, source, target, recorded) || !await priorRequestIsRetiredLineage(activeFile, receipt)) return undefined;
  return { mode: PANE_GONE_MODE, retired: { herdr_session: receipt.herdr_session!, pane: receipt.pane! } };
}

/** Pane ids from one complete global Herdr pane list. */
function listedPaneIds(raw: string) {
  const parsed = JSON.parse(raw) as { result?: { panes?: unknown }; panes?: unknown };
  const panes = (parsed.result ?? parsed).panes;
  const ids = Array.isArray(panes) ? panes.map((pane) => (pane as { pane_id?: unknown } | null)?.pane_id) : undefined;
  if (!ids || ids.some((id) => typeof id !== "string")) throw new Error("Pane-gone recovery requires complete global Herdr pane-list evidence.");
  return ids as string[];
}

const piSessionId = (path: string) => basename(path).match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];

/** Pane-gone recovery requires the retired pane and the exact recorded Pi to be absent from one complete global pane list and agent list. */
export function assertPaneGone(agentsRaw: string, panesRaw: string, source: Pick<Source, "pi_session" | "pi_session_path">, retired: { pane: string }) {
  if (listedPaneIds(panesRaw).includes(retired.pane)) throw new Error("The retired canonical pane is still listed by Herdr.");
  const agents = listedPiAgents(agentsRaw, "Pane-gone recovery");
  if (agents.some((agent) => agent.pane === retired.pane)) throw new Error("A Pi is live at the retired canonical pane.");
  if (agents.some(({ path }) => path === resolve(source.pi_session_path) || piSessionId(path) === source.pi_session)) throw new Error("The exact recorded Pi is still a live Pi agent.");
}

/** Herdr pane-list evidence plus the authorization and clock that bind the absence proof to one request. */
export type PaneGoneObservation = { paneList: () => Promise<string>; authorizationHash: string; at: () => string };

async function buildPaneGoneStaleMainRecovery(root: string, seat: string, intent: { record: Seat; source: Source; target: Target }, pane: Relocation, active: { file: string }, observe: { agentList: () => Promise<string> } & PaneGoneObservation): Promise<StaleMainRecovery> {
  const { locator, session, sessionPath, receipt } = completeRuntime(intent.record.runtime);
  const canonical = { pi_session: session, pi_session_path: sessionPath, herdr_session: locator.session, pane: locator.pane, cwd: intent.target.cwd, launch_receipt: receipt };
  try { assertPaneGone(await observe.agentList(), await observe.paneList(), intent.source, pane.retired); }
  catch (error) { throw new Error(`Path-A replacement target must be the exact released source pane; pane-gone recovery refused: ${(error as Error).message}`); }
  const verified_at = observe.at(), relocation: Relocation = { ...pane, absence: { authorization_hash: observe.authorizationHash, verified_at } };
  const prior_request = await archivePriorRequest(root, seat, active.file, () => false, { canonical, source: intent.source, verifiedAt: verified_at, assertAbsent: async () => {} });
  const prior_receipt = await archiveStaleReceipt(root, seat, canonical, relocation);
  return { canonical_source: canonical, prior_receipt, ...(prior_request ? { prior_request } : {}), relocation };
}
