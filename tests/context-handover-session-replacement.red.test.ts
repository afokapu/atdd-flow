import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
