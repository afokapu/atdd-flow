// URN: test:flow:main-launch-replacement-narrow-catch
// Acceptance: acc:flow:E033-UNIT-001
// Phase: UNIT
// Runtime: bun
// Purpose: The exact-adoption fallback replaces only a Path-A eligibility refusal, never another failure.
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { paths, seat } from "../src/core";
import { handoverReplacementPath, mainLaunchReplacement } from "../src/handover";
import { atomicYaml } from "../src/core";
import { fixture, noRequest } from "./stale-adopt-fixtures";

const stale = (address: string, task: string) => ({
  schema: "atdd-flow/context-handover-replacement-request/v1", seat: address, task,
  handover: { id: "H-old", sha256: "1".repeat(64) }, authorization: { id: "A-old", hash: "2".repeat(64) },
  source: { pi_session: "s", pi_session_path: "/p", herdr_session: "forge", pane: "w9:p9" }, target: { herdr_session: "forge", pane: "w9:p9", cwd: "/c" },
  created_at: "2026-10-19T08:22:10.722Z",
});

test("an unreadable project record propagates and is never turned into an adoption", async () => {
  const value = await fixture("atdd-flow");
  const record = await seat(value.root, value.address);
  await writeFile(paths(value.root).projectFile("atdd-flow"), "roles: [unclosed\n");
  await expect(mainLaunchReplacement(value.root, record, value.address, true)).rejects.toThrow();
});

test("a request naming a missing task is a stale Path-A refusal: adoptable when authorized, refused otherwise", async () => {
  const value = await fixture("atdd-flow");
  const record = await seat(value.root, value.address);
  await atomicYaml(handoverReplacementPath(value.root, value.address), stale(value.address, "ghost-task"));
  await expect(mainLaunchReplacement(value.root, record, value.address, true)).resolves.toMatchObject({ taskId: "takeover-1", exactAdoption: true });
  await expect(mainLaunchReplacement(value.root, record, value.address, false)).rejects.toThrow(/Path-A replacement source tuple no longer matches/);
});

test("no request at all stays the original refusal when unauthorized", async () => {
  const value = await fixture("atdd-flow");
  await expect(mainLaunchReplacement(value.root, await seat(value.root, value.address), value.address, false)).rejects.toThrow(noRequest(value.address));
});
