import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "seat.ts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim();
}

test("a request remains outstanding until its linked result exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-seat-"));
  roots.push(root);
  const project = join(root, "demo");

  await run(root, "init", project);
  await run(project, "spawn", "coordinator", "main", "--worktree", "/tmp/demo-main");
  await run(project, "spawn", "driver", "runtime", "--worktree", "/tmp/demo-runtime");
  const thread = await run(project, "thread", "start", "--with", "coordinator@demo,driver.runtime@demo", "--subject", "Runtime rollout");
  const request = await run(project, "post", thread, "--from", "coordinator@demo", "--to", "driver.runtime@demo", "--expects-result", "--body", "Run checks");

  await run(project, "receipt", thread, request, "--from", "driver.runtime@demo");
  expect(await run(project, "status")).toContain(`waiting:${request}`);

  await run(project, "result", thread, request, "--from", "driver.runtime@demo", "--body", "Checks pass");
  expect(await run(project, "status")).not.toContain("waiting:");
});
