import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths, readYaml } from "../src/core";
import { requestHandoverReplacement, type HandoverReplacementRequest } from "../src/handover";
import { launchPiRuntime } from "../src/seats";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const extension = join(import.meta.dir, "..", "extensions", "pi", "index.ts");

async function invoke(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

test("RED: CLI advertises the supported Path-A replacement and reconciled RESUMED receipt commands", async () => {
  const { output } = await invoke("--help");
  expect(output).toContain("atdd-flow handover replace <address>");
  expect(output).toContain("atdd-flow handover resumed <address>");
});

test("RED: bundled Pi runtime has a configurable context threshold handover trigger without invoking compaction", async () => {
  const source = await readFile(extension, "utf8");
  expect(source).toContain("getContextUsage()");
  expect(source).toContain("context-handover-replacement");
  expect(source).not.toMatch(/\.compact\s*\(/);
});

test("RED: Path-A request requires validated handover, immutable source authorization, and an exact ready main takeover task", async () => {
  const { output } = await invoke("handover", "replace", "main@demo", "--help");
  expect(output).toContain("--handover");
  expect(output).toContain("--authorization");
  expect(output).toContain("--source-pi-session");
  expect(output).toContain("--source-pi-session-path");
  expect(output).toContain("--source-herdr-session");
  expect(output).toContain("--source-pane");
  expect(output).toContain("--herdr-session");
});

test("GREEN: Path-A writes one create-only request only for the exact ready project main", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-path-a-"));
  const seat = "main@demo";
  const handover = "HANDOVER main@demo | 2026-10-13T04:00:00Z | handover-id H-demo | supersedes none\nRuntime: herdr forge:w1:p2 | pi session 11111111-1111-1111-1111-111111111111 | model test/pi | context 80%\n\n1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS\n- exact\n\n2. OPEN WORK AND IN-FLIGHT OPERATIONS\n- exact\n\n3. DEPENDENCIES (both directions)\n- none\n\n4. RESUME PROCEDURE AND NEXT ACTIONS\n- exact\n";
  try {
    await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr" });
    await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", repository: "/work/demo", roles: {} });
    await atomicYaml(paths(root).seatFile(seat), { schema: "atdd-workflow/seat/v2", address: seat, role: "main", project: "demo", worktree: "/work/demo", branch: "main" });
    await atomicYaml(paths(root).handoverFile(seat), { schema: "atdd-workflow/handover/v1", seat, handover_id: "H-demo", supersedes: "none", recorded_at: "2026-10-13T04:00:00Z", text: handover });
    await atomicYaml(paths(root).taskFile("demo", "takeover"), { schema: "atdd-workflow/task/v1", title: "Take over", status: "todo", coordinator: seat, assignee: seat, done_when: [{ text: "Take over safely." }] });
    const args = ["--handover", "H-demo", "--authorization", "M-owner", "--takeover-task", "takeover", "--source-pi-session", "11111111-1111-1111-1111-111111111111", "--source-pi-session-path", "/sessions/source.jsonl", "--source-herdr-session", "forge", "--source-pane", "w1:p2", "--herdr-session", "forge", "--target-pane", "w1:p2", "--target-cwd", "/work/demo"];
    await expect(launchPiRuntime(root, seat, ["--herdr-session", "forge", "--dry-run"])).rejects.toThrow("validated Path-A replacement request");
    await requestHandoverReplacement(root, seat, args);
    const request = await readYaml<HandoverReplacementRequest>(join(root, ".atdd-flow", "handover-replacements", `${encodeURIComponent(seat)}.yaml`));
    expect(request).toMatchObject({ seat, task: "takeover", handover: { id: "H-demo" }, authorization: "M-owner", source: { pi_session: "11111111-1111-1111-1111-111111111111", pane: "w1:p2" }, target: { herdr_session: "forge", pane: "w1:p2", cwd: "/work/demo" } });
    await expect(requestHandoverReplacement(root, seat, args)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
