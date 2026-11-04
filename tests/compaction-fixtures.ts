// URN: component:flow:e031:compaction-fixtures:backend:integration
// Tested-By:
// - test:flow:same-session-compaction-engine
// - test:flow:same-session-compaction-wiring
// Runtime: bun
// Purpose: Build throwaway Desk and seat fixtures for same-session compaction tests

import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveIdentity } from "../src/compaction-handover";

export const seatAddress = "driver.delivery@demo";
export const live: LiveIdentity = { pi_session: "01a12345-6789-7abc-8def-0123456789ab", herdr_session: "forge", pane: "w1:p2" };
export const roots: string[] = [];
/** Every test file calls this once so each fixture Desk is removed after its test. */
export function installFixtureCleanup() {
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
}

export async function fixture(options: { threshold?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-compaction-"));
  roots.push(root);
  const seatDir = join(root, "work", "demo", "seats", "driver.delivery");
  await mkdir(seatDir, { recursive: true });
  const receipt = join(root, ".atdd-flow", "runtime-launch", "verified.yaml");
  await mkdir(join(root, ".atdd-flow", "runtime-launch"), { recursive: true });
  await writeFile(receipt, `schema: atdd-flow/pi-runtime-launch-receipt/v1\nseat: ${seatAddress}\npi_session: ${live.pi_session}\n`);
  await writeFile(join(root, "desk.yaml"), `schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n${options.threshold ? `context_handover:\n  threshold_percent: ${options.threshold}\n` : ""}`);
  await writeFile(join(root, "work", "demo", "project.yaml"), "schema: atdd-workflow/project/v1\nproject: demo\n");
  const seatFile = join(seatDir, "seat.yaml");
  await writeFile(seatFile, [
    "schema: atdd-workflow/seat/v2", `address: ${seatAddress}`, "role: driver", "project: demo", "worktree: /tmp/delivery", "branch: delivery/test",
    "runtime:", "  application: herdr", "  addresses:", "    herdr:", `      session: ${live.herdr_session}`, `      pane: ${live.pane}`,
    `  pi_session: ${live.pi_session}`, "  pi_session_path: /tmp/pi/session.jsonl", `  launch_receipt: ${receipt}`, "",
  ].join("\n"));
  return { root, seatFile, handoverFile: join(seatDir, "handover.yaml"), checkpointFile: join(seatDir, "checkpoint.yaml"), receipt };
}

export function handover(id = "H-20261104T070000Z-compaction", options: { supersedes?: string; broken?: boolean } = {}) {
  return [
    `HANDOVER ${seatAddress} | 2026-11-04T07:00:00Z | handover-id ${id} | supersedes ${options.supersedes ?? "none"}`,
    "Runtime: pi | 01a12345 | model anthropic/claude-sonnet-5-5 | context 85%",
    "1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS",
    "- Seat: driver.delivery@demo (driver), project demo",
    ...(options.broken ? [] : ["2. OPEN WORK AND IN-FLIGHT OPERATIONS", "- demo/delivery in_progress/green, commit d60116f"]),
    "3. DEPENDENCIES", "- WAITING ON: none", "- OWED BY ME: none",
    "4. RESUME PROCEDURE AND NEXT ACTIONS", "1. Run atdd-flow open driver.delivery@demo.", "",
  ].join("\n");
}
export const note = { summary: "compacting in place at 85%", next_action: "continue GREEN for demo/delivery" };
export const branch = [{ id: "e1" }, { id: "e2" }, { id: "e3" }];

