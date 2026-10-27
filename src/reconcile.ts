// URN: component:flow:obligation-continuation:backend:application
// Runtime: bun
// Purpose: Wake an idle owner of an existing actionable Flow obligation; never create or complete work.
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
};

type Attempt = { schema: "atdd-flow/continuation-attempt/v1"; key: string; at: string; count: number };
const agentName = (address: string) => `flow-${address.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`.slice(0, 32);
const fingerprint = (directive: TaskDirective, session: string | undefined, owner: string) =>
  createHash("sha256").update(JSON.stringify({ directive, session, owner })).digest("hex");
const attemptFile = (root: string, address: string) =>
  join(root, ".atdd-flow", "continuation", `${encodeURIComponent(address)}.yaml`);

/** Only a verified, idle Herdr agent may be prompted; unknown states are not idle. */
async function inspectHerdr(locator: HerdrLocator, address: string) {
  const raw = JSON.parse(await runOutput(["herdr", "--session", locator.session, "agent", "get", agentName(address)]));
  const envelope = raw?.result ?? raw;
  const agent = envelope?.agent ?? envelope;
  if (agent?.name !== agentName(address) || agent?.pane_id !== locator.pane) return "unverified";
  return String(agent?.agent_status ?? agent?.status ?? agent?.state ?? "unverified").toLowerCase();
}

async function seats(root: string): Promise<Seat[]> {
  const found: Seat[] = [];
  for (const project of await readdir(paths(root).work, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const local of await readdir(paths(root).seats(project.name), { withFileTypes: true }).catch(() => [])) {
      if (!local.isDirectory()) continue;
      found.push(await readYaml<Seat>(join(paths(root).seats(project.name), local.name, "seat.yaml")));
    }
  }
  return found;
}

/**
 * One-shot, file-based reconciliation. Task state selects the actor; Herdr is only
 * observed for safe delivery. Attempts are advisory and fenced by the live runtime
 * owner token. No task, seat, inbox, or authorization record is modified.
 */
export async function reconcileOnce(root: string, options: ReconcileOptions = {}): Promise<Reconciliation[]> {
  const at = options.now ?? new Date();
  const cooldownMs = options.cooldownMs ?? 5 * 60_000;
  const maxNudges = options.maxNudges ?? 2;
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0 || !Number.isInteger(maxNudges) || maxNudges < 1)
    throw new Error("Invalid continuation cooldown or maximum nudge count.");
  const observe = options.inspect ?? inspectHerdr;
  const wake = options.wake ?? ((locator: HerdrLocator, notice: string) => notify("herdr", locator.pane, notice, locator.session));
  const results: Reconciliation[] = [];
  for (const owner of await seats(root)) {
    if (owner.retired) continue;
    const directive = await nextDirective(root, owner.address);
    // No command means the actor is legitimately awaiting a dependency or decision.
    if (!directive?.command) continue;
    const output = (outcome: Outcome) => results.push({ seat: owner.address, task: `${directive.project}/${directive.task}`, outcome });
    const runtime = owner.runtime, locator = runtime?.addresses.herdr;
    if (runtime?.application !== "herdr" || !locator || typeof locator === "string") { output("inactive"); continue; }
    const active = await readRuntimeState(root, owner.address);
    if (!active || isRuntimeStateStale(active, 60_000, at)
      || (runtime.pi_session && active.pi_session !== runtime.pi_session)) { output("inactive"); continue; }
    let status: string;
    try { status = await observe(locator, owner.address); }
    catch { output("unverified"); continue; }
    if (status === "unverified") { output("unverified"); continue; }
    if (status !== "idle" && status !== "done") { output("busy"); continue; }
    if (options.dryRun) { output("dry_run"); continue; }
    const key = fingerprint(directive, runtime.pi_session, active.owner_token);
    const result = await withOwnedRuntimeState(root, owner.address, active.owner_token, async (): Promise<Outcome> => {
      const file = attemptFile(root, owner.address);
      const prior = await readYaml<Attempt>(file).catch(() => undefined);
      const repeated = prior?.schema === "atdd-flow/continuation-attempt/v1" && prior.key === key;
      if (repeated && prior!.count >= maxNudges) return "exhausted";
      if (repeated && at.getTime() - Date.parse(prior!.at) < cooldownMs) return "cooldown";
      await mkdir(join(root, ".atdd-flow", "continuation"), { recursive: true });
      await atomicYaml(file, { schema: "atdd-flow/continuation-attempt/v1", key,
        at: at.toISOString(), count: repeated ? prior!.count + 1 : 1 } satisfies Attempt);
      try {
        await wake(locator, `${directiveNotice(owner.address, directive)} The task remains open. Continue within your authority; escalate a real blocker rather than ending the obligation.`);
        return "woke";
      } catch { return "wake_failed"; }
    });
    output(result.owned ? result.value : "replaced");
  }
  return results;
}
