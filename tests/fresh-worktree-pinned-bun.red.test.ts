// URN: test:atdd-flow:fresh-worktree-pinned-bun
// Acceptance: acc:flow:E039-UNIT-001
// Phase: UNIT
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const reviewsModule = join(import.meta.dir, "..", "src", "reviews.ts");

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

/** A review-ready Desk whose seat worktree is a fresh checkout with no node_modules (no pinned ATDD Bun). */
async function freshWorktreeFixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-fresh-pinned-"));
  const repository = join(root, "repository");
  await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "test@example.test");
  await git(repository, "config", "user.name", "Test");
  await writeFile(join(repository, ".gitignore"), "node_modules/\n");
  await writeFile(join(repository, "atdd-bun.yaml"), "profiles: [workflow]\n");
  await writeFile(join(repository, "delivery.txt"), "reviewed\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "delivery");

  await mkdir(join(root, "work", "demo", "seats", "driver.delivery"), { recursive: true });
  await mkdir(join(root, "work", "demo", "tasks"), { recursive: true });
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await writeFile(join(root, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
repository: ${repository}
roles:
  driver:
    address: driver.{name}@{project}
    branch: delivery/{name}
    base: main
`);
  await writeFile(join(root, "work", "demo", "seats", "driver.delivery", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: driver.delivery@demo
role: driver
project: demo
worktree: ${repository}
branch: main
`);
  const task = {
    schema: "atdd-workflow/task/v1" as const,
    title: "Deliver behavior",
    status: "review" as const,
    coordinator: "coordinator@demo",
    assignee: "driver.delivery@demo",
    done_when: [{ text: "Behavior works", proof: "CI run 42" }],
  };
  await writeFile(join(root, "work", "demo", "tasks", "delivery.yaml"), Bun.YAML.stringify(task));

  // A global ATDD Bun on PATH that records each invocation and succeeds. A fresh worktree must never reach it.
  const globalBin = join(root, "global-bin");
  await mkdir(globalBin, { recursive: true });
  const globalLog = join(root, "global-atdd-bun.log");
  await writeFile(join(globalBin, "atdd-bun"), `#!/bin/sh\necho global >> "${globalLog}"\necho PASS\n`);
  await chmod(join(globalBin, "atdd-bun"), 0o755);
  return { root, repository, globalBin, globalLog };
}

/**
 * Runs the real launchBehavioralReview in a child Bun process whose PATH is fixed at startup, so a bare
 * `atdd-bun` resolves exactly as it would in a driver pane. Driver-pane Desk variables are removed.
 */
async function launchWithPath(root: string, path: string) {
  const script = join(root, "launch-review.ts");
  await writeFile(script, `import { launchBehavioralReview } from ${JSON.stringify(reviewsModule)};
try {
  await launchBehavioralReview(${JSON.stringify(root)}, "demo", "delivery", ["--by", "coordinator@demo"]);
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ error: (error as Error).message }));
}
`);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined) as [string, string][]);
  delete env.ATDD_WORKFLOW_ROOT;
  delete env.ATDD_WORKFLOW_SEAT;
  env.PATH = path;
  const child = Bun.spawn([process.execPath, script], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as { ok?: boolean; error?: string };
}

test("a fresh worktree without a pinned ATDD Bun fails loudly instead of running the global atdd-bun", async () => {
  const fixture = await freshWorktreeFixture();
  try {
    const result = await launchWithPath(fixture.root, `${fixture.globalBin}:${process.env.PATH}`);

    expect(existsSync(fixture.globalLog)).toBe(false);
    expect(result.error).toContain("Pinned ATDD Bun is missing");
    expect(result.error).toContain("bun install --frozen-lockfile");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a worktree with its own pinned node_modules/.bin/atdd-bun runs that pinned binary, not the global one", async () => {
  const fixture = await freshWorktreeFixture();
  try {
    const localBin = join(fixture.repository, "node_modules", ".bin");
    await mkdir(localBin, { recursive: true });
    const localLog = join(fixture.root, "local-atdd-bun.log");
    await writeFile(join(localBin, "atdd-bun"), `#!/bin/sh\necho local >> "${localLog}"\necho PASS\n`);
    await chmod(join(localBin, "atdd-bun"), 0o755);

    await launchWithPath(fixture.root, `${fixture.globalBin}:${process.env.PATH}`);

    expect((await readFile(localLog, "utf8")).trim()).toBe("local");
    expect(existsSync(fixture.globalLog)).toBe(false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
