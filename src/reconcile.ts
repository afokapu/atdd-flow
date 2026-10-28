// URN: component:flow:e012:reconcile:backend:application
// Tested-By:
// - test:flow:continuation:E012-UNIT-001
// Runtime: bun
// Purpose: Wake idle owners of existing actionable Flow obligations.
import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { notify } from "./adapters";
import { type HerdrLocator, type Seat, atomicYaml, paths, readYaml, runOutput } from "./core";
import { type TaskDirective, directiveNotice, nextDirective } from "./tasks";
import { isRuntimeStateStale, readRuntimeState, withOwnedRuntimeState } from "./runtime-state";

type Outcome = "woke" | "dry_run" | "cooldown" | "exhausted" | "inactive" | "unverified" | "busy" | "replaced" | "wake_failed";
export type Reconciliation = { seat: string; task: string; outcome: Outcome };
export type ReconcileOptions = {
  now?: Date;
  dryRun?: boolean;
  cooldownMs?: number;
  maxNudges?: number;
  inspect?: (locator: HerdrLocator, seat: string) => Promise<string>;
  wake?: (locator: HerdrLocator, notice: string) => Promise<void>;
  warn?: (message: string) => void;
};

type Attempt = { schema: "atdd-flow/continuation-attempt/v1"; key: string; at: string; count: number };
type Target = { owner: Seat; directive: TaskDirective; locator: HerdrLocator; token: string };
type Settings = Required<Pick<ReconcileOptions, "now" | "cooldownMs" | "maxNudges" | "inspect" | "wake">> & { dryRun: boolean };

const agentName = (address: string) => `flow-${address.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`.slice(0, 32);
const fingerprint = (target: Target) =>
  createHash("sha256").update(JSON.stringify({ directive: target.directive, session: target.owner.runtime?.pi_session, owner: target.token })).digest("hex");
const attemptFile = (root: string, address: string) =>
  join(root, ".atdd-flow", "continuation", `${encodeURIComponent(address)}.yaml`);

/** Read Herdr status without treating missing or mismatched identities as healthy.
 * The live host is an observation surface, never a seat registry.
 */
async function inspectHerdr(locator: HerdrLocator, address: string) {
  const raw = JSON.parse(await runOutput(["herdr", "--session", locator.session, "agent", "get", agentName(address)]));
  const envelope = raw?.result ?? raw;
  const agent = envelope?.agent ?? envelope;
  if (agent?.name !== agentName(address) || agent?.pane_id !== locator.pane) return "unverified";
  return String(agent?.agent_status ?? agent?.status ?? agent?.state ?? "unverified").toLowerCase();
}

/** Discover durable seat identity from the existing Desk directories.
 * No second fleet registry is created or synchronized.
 */
async function seats(root: string, warn: (message: string) => void): Promise<Seat[]> {
  const found: Seat[] = [];
  for (const project of await readdir(paths(root).work, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const local of await readdir(paths(root).seats(project.name), { withFileTypes: true }).catch(() => [])) {
      if (!local.isDirectory()) continue;
      const folder = join(paths(root).seats(project.name), local.name);
      // A completely empty directory (hidden entries included) is a ghost, not a seat: skip it once, never delete it.
      // Any directory with content but no seat.yaml still fails closed in readYaml.
      if ((await readdir(folder)).length === 0) { warn(`Skipping empty seat directory without a seat record: ${folder}`); continue; }
      found.push(await readYaml<Seat>(join(folder, "seat.yaml")));
    }
  }
  return found;
}

function validateLimits(cooldownMs: number, maxNudges: number) {
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error("Invalid continuation cooldown.");
  if (!Number.isInteger(maxNudges) || maxNudges < 1) throw new Error("Invalid maximum nudge count.");
}

function settings(options: ReconcileOptions): Settings {
  const cooldownMs = options.cooldownMs ?? 5 * 60_000;
  const maxNudges = options.maxNudges ?? 2;
  validateLimits(cooldownMs, maxNudges);
  return {
    now: options.now ?? new Date(),
    dryRun: options.dryRun ?? false,
    cooldownMs, maxNudges,
    inspect: options.inspect ?? inspectHerdr,
    wake: options.wake ?? ((locator, notice) => notify("herdr", locator.pane, notice, locator.session)),
  };
}

const outcome = (owner: Seat, directive: TaskDirective, status: Outcome): Reconciliation =>
  ({ seat: owner.address, task: `${directive.project}/${directive.task}`, outcome: status });

/** An actionable target also needs a live, matching runtime observation.
 * This deliberately refuses an unknown or stale session rather than guessing.
 */
async function target(root: string, owner: Seat, directive: TaskDirective, at: Date): Promise<Target | undefined> {
  const runtime = owner.runtime;
  const locator = runtime?.addresses.herdr;
  if (runtime?.application !== "herdr" || !locator || typeof locator === "string") return;
  const active = await readRuntimeState(root, owner.address);
  if (!active) return;
  if (isRuntimeStateStale(active, 60_000, at)) return;
  if (runtime.pi_session && active.pi_session !== runtime.pi_session) return;
  return { owner, directive, locator, token: active.owner_token };
}

/** The per-seat retry memo is advisory: changing work or replacing an agent
 * starts a new key, while unchanged instructions have bounded retries.
 */
function attemptDisposition(previous: Attempt | undefined, key: string, config: Settings): Outcome | undefined {
  if (previous?.schema !== "atdd-flow/continuation-attempt/v1") return;
  if (previous.key !== key) return;
  if (previous.count >= config.maxNudges) return "exhausted";
  if (config.now.getTime() - Date.parse(previous.at) < config.cooldownMs) return "cooldown";
}

/** Write the attempt before contacting Herdr, so a transient host failure
 * cannot turn repeated reconciliation into a prompt storm.
 */
async function wakeOnce(root: string, candidate: Target, config: Settings): Promise<Outcome> {
  const file = attemptFile(root, candidate.owner.address);
  const key = fingerprint(candidate);
  const previous = await readYaml<Attempt>(file).catch(() => undefined);
  const suppressed = attemptDisposition(previous, key, config);
  if (suppressed) return suppressed;
  const count = previous?.key === key ? previous.count + 1 : 1;
  await mkdir(join(root, ".atdd-flow", "continuation"), { recursive: true });
  await atomicYaml(file, { schema: "atdd-flow/continuation-attempt/v1", key, at: config.now.toISOString(), count } satisfies Attempt);
  try {
    await config.wake(candidate.locator, `${directiveNotice(candidate.owner.address, candidate.directive)} The task remains open. Continue within your authority; escalate a real blocker rather than ending the obligation.`);
    return "woke";
  } catch { return "wake_failed"; }
}

async function reconcileSeat(root: string, owner: Seat, config: Settings): Promise<Reconciliation | undefined> {
  if (owner.retired) return;
  const directive = await nextDirective(root, owner.address);
  // A directive without a command is a legitimate wait on another actor.
  if (!directive?.command) return;
  const candidate = await target(root, owner, directive, config.now);
  if (!candidate) return outcome(owner, directive, "inactive");
  let status: string;
  try { status = await config.inspect(candidate.locator, owner.address); }
  catch { return outcome(owner, directive, "unverified"); }
  if (status === "unverified") return outcome(owner, directive, "unverified");
  if (status !== "idle" && status !== "done") return outcome(owner, directive, "busy");
  if (config.dryRun) return outcome(owner, directive, "dry_run");
  // Serialize with a live runtime's token-fenced wake; a replacement cannot be prompted.
  const result = await withOwnedRuntimeState(root, owner.address, candidate.token, () => wakeOnce(root, candidate, config));
  return outcome(owner, directive, result.owned ? result.value : "replaced");
}

/** One-shot, advisory fleet reconciliation. Task state remains the sole work authority. */
export async function reconcileOnce(root: string, options: ReconcileOptions = {}): Promise<Reconciliation[]> {
  const config = settings(options);
  const results: Reconciliation[] = [];
  for (const owner of await seats(root, options.warn ?? ((message) => process.stderr.write(`warning: ${message}\n`)))) {
    const result = await reconcileSeat(root, owner, config);
    if (result) results.push(result);
  }
  return results;
}
