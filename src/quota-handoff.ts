// URN: component:flow:e014:quota-handoff:backend:application
// Tested-By:
// - test:flow:session-rotation:E014-UNIT-001
// Runtime: bun
// Purpose: Select an authenticated quota rescue model for handoff-only work.
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { desk, modelPortfolio, seat } from "./core";
import { availableModelCandidates, resolveModelCommand } from "./pi-runtime-launch";

export type RescueContext = Pick<ExtensionContext, "model" | "modelRegistry">;
export type RescueHost = Pick<ExtensionAPI, "setModel">;

/** A quota_handoff_model role entry is only a rescue candidate, not an assurance
 * of quota independence. The Pi registry and authentication must accept it.
 */
export async function selectQuotaHandoffModel(root: string, address: string,
  context: RescueContext, host: RescueHost) {
  const owner = await seat(root, address);
  if (owner.role === "main" || !["driver", "coordinator"].includes(owner.role)) return false;
  const config = await desk(root);
  const candidateId = config.quota_handoff_model?.[owner.role];
  const portfolio = await modelPortfolio(root);
  if (!candidateId || !portfolio) return false;
  const candidate = availableModelCandidates(config, portfolio).find((entry) => entry.id === candidateId);
  if (!candidate) return false;
  const command = resolveModelCommand(config, candidate);
  if (basename(command.agent) !== "pi") return false;
  const flag = command.args.indexOf("--model");
  const exact = flag >= 0 ? command.args[flag + 1] : undefined;
  const match = exact?.match(/^([^/]+)\/(.+)$/);
  if (!match) return false;
  const provider = match[1]!, modelId = match[2]!;
  if (context.model?.provider === provider && context.model?.id === modelId) return false;
  const model = context.modelRegistry.find(provider, modelId);
  return model ? host.setModel(model) : false;
}

/** The fallback's authority is constrained to producing a handover record.
 * Use ordinary string concatenation here: this text is a Pi prompt, not HTML.
 */
export const quotaHandoffInstruction = (address: string, bundle?: string) =>
  "SYSTEM: Provider quota exhausted for " + address + ". You are the configured fallback model and may ONLY produce a validated Flow handover. "
  + "Do not implement code, modify tasks, mark work complete, or alter delegation. "
  + "Read 'atdd-flow open " + address + "', inspect the Desk and current worktree, and write the four-section handover "
  + "using the canonical Flow lifecycle convention. Validate and record it with 'atdd-flow handover " + address
  + " --file <exact-path>'. State unresolved dependencies and precise next actions. "
  + "Stop after the handover is recorded. Flow will relaunch an eligible execution model from models.yaml after release."
  + (bundle ? "\n" + bundle : "");
