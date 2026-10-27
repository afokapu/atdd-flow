// URN: test:atdd-flow:logging-console-cli-output
// Acceptance: acc:flow:E015-UNIT-001
// Phase: UNIT
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressBook } from "../src/address-book";
import { createExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";

// Both commands print their result as the CLI's user interface. The coder.bun.logging-console convention
// directs such output to process.stdout.write; the bytes a caller sees must stay exactly the same.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function desk() {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-logging-console-"));
  roots.push(root);
  return root;
}

/** Runs `action` and returns what it wrote through process.stdout.write and through console.log. */
async function capture(action: () => Promise<void>) {
  const written: string[] = [];
  const logged: string[] = [];
  const write = process.stdout.write;
  const log = console.log;
  process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };
  try { await action(); }
  finally { process.stdout.write = write; console.log = log; }
  return { stdout: written.join(""), console: logged };
}

test("address book prints the exact table through process.stdout.write and never console.log", async () => {
  const root = await desk();
  await mkdir(join(root, "work", "demo", "seats", "coordinator"), { recursive: true });
  await mkdir(join(root, "work", "demo", "seats", "driver.delivery"), { recursive: true });
  await writeFile(join(root, "work", "demo", "seats", "coordinator", "seat.yaml"),
    "schema: atdd-workflow/seat/v1\naddress: coordinator@demo\nrole: coordinator\nproject: demo\nworktree: /w\nbranch: main\npurpose: Plans | routes\n");
  await writeFile(join(root, "work", "demo", "seats", "driver.delivery", "seat.yaml"),
    "schema: atdd-workflow/seat/v1\naddress: driver.delivery@demo\nrole: driver\nproject: demo\nworktree: /w\nbranch: delivery\n");

  const output = await capture(() => addressBook(root));

  expect(output.console).toEqual([]);
  expect(output.stdout).toBe([
    "# Desk address book\n",
    "`operator@desk` is the human authority. Drivers route normal work through coordinators; main seats are the normal technical gateway to the operator.\n",
    "| Address | Identity | Purpose / authority |\n| --- | --- | --- |",
    "| coordinator@demo | agent | Plans \\| routes |",
    "| driver.delivery@demo | agent | Delivers assigned work; routes normal communication through its coordinator. |",
    "",
  ].join("\n"));
});

test("adoption authorization prints exactly its id and a newline through process.stdout.write and never console.log", async () => {
  const root = await desk();

  const output = await capture(() => createExactSessionAdoptionAuthorization(root, "A-logging-console-1", [
    "--by", "operator@desk", "--seat", "driver.demo@demo", "--pi-session", "session-1", "--pi-session-path", "/tmp/session-1.jsonl",
    "--source-herdr-session", "legacy", "--source-pane", "w1:p2", "--target-herdr-session", "forge", "--target-pane", "w1:p2", "--target-cwd", "/work/demo",
  ]));

  expect(output.console).toEqual([]);
  expect(output.stdout).toBe("A-logging-console-1\n");
});
