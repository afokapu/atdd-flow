// URN: test:flow:jj-vcs-migration:E023-UNIT-001
// Acceptance: acc:flow:E023-UNIT-001
// Phase: UNIT
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Public-command contract for `project migrate-vcs <project> --to jj --dry-run`.
 * The topology preflight (primary count, distinct worktree paths, dirty state, registry ownership)
 * is computed from non-retired seats only. A retired seat that still carries a runtime locator and
 * shares a recorded worktree path with another retired seat must not block migration; the same
 * shared path between two ACTIVE seats must still fail closed. Every fixture is a mkdtemp-isolated
 * Desk and repository; the live Desk (and any live Resolver Desk record) is never referenced.
 */
const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
// Isolation: seats export ATDD_WORKFLOW_ROOT (the live Desk); spawned CLIs must never inherit any ATDD_* variable.
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ATDD_")));

async function exec(cwd: string, command: string, ...args: string[]) {
  const child = Bun.spawn([command, ...args], { cwd, env: isolatedEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
  return stdout.trim();
}
const flow = (cwd: string, ...args: string[]) => exec(cwd, process.execPath, cli, ...args);

async function failFlow(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: isolatedEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).not.toBe(0);
  return `${stdout}${stderr}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** Desk with a primary `main`, one healthy driver, and two drivers recorded at one shared worktree path. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-jj-retired-seats-"));
  roots.push(root);
  const desk = join(root, "desk"), repository = join(root, "repository"), worktrees = join(root, "worktrees");
  await mkdir(repository);
  await exec(repository, "git", "init", "--initial-branch=main");
  await exec(repository, "git", "config", "user.email", "fixture@example.test");
  await exec(repository, "git", "config", "user.name", "Fixture");
  await writeFile(join(repository, "README.md"), "initial\n");
  await exec(repository, "git", "add", "README.md");
  await exec(repository, "git", "commit", "-m", "initial");
  await flow(root, "init", desk);
  await flow(desk, "project", "init", "demo");
  await flow(desk, "project", "configure", "demo", "--repository", repository, "--worktree-root", worktrees);
  await flow(desk, "spawn", "demo", "main", "primary");
  await flow(desk, "spawn", "demo", "driver", "healthy");
  await flow(desk, "spawn", "demo", "driver", "first");
  const shared = join(worktrees, "first");
  await flow(desk, "spawn", "demo", "driver", "second", "--worktree", shared, "--branch", "delivery/first");
  return { desk, repository, shared };
}

const seatFile = (desk: string, address: string) => join(desk, "work", "demo", "seats", address, "seat.yaml");

/** Record the exact retirement shape `seat retire` writes (see src/tasks.ts retireDriver). */
async function markRetired(desk: string, address: string) {
  const file = seatFile(desk, address);
  const record = Bun.YAML.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  record.retired = { task: "demo/finished", completed_at: "2026-10-31T00:00:00.000Z", summary: "fixture: removed merged worktree" };
  await writeFile(file, Bun.YAML.stringify(record, null, 2));
}

test("two retired seats sharing a worktree path and a runtime locator do not block the JJ dry-run", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository, shared } = await fixture();
  // The retired seat still carries a runtime locator: Flow has no unbind command.
  await flow(desk, "bind", "driver.first@demo", "--application", "herdr", "--address", "w1:p1", "--session", "fixture");
  await markRetired(desk, "driver.first");
  await markRetired(desk, "driver.second");
  // Retirement finished the shared worktree, so Git no longer registers it.
  await exec(repository, "git", "worktree", "remove", shared);

  const plan = await flow(desk, "project", "migrate-vcs", "demo", "--to", "jj", "--dry-run");
  expect(plan).toContain("atdd-flow/vcs-migration-plan/v1");
  expect(plan).toContain("driver.healthy@demo");
  expect(plan).not.toContain("driver.first@demo");
  expect(plan).not.toContain("driver.second@demo");
  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);
  expect(await readFile(join(desk, "work", "demo", "project.yaml"), "utf8")).not.toContain("vcs: jj");
});

test("two ACTIVE seats sharing a worktree path still refuse the JJ dry-run", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository } = await fixture();

  const error = await failFlow(desk, "project", "migrate-vcs", "demo", "--to", "jj", "--dry-run");
  expect(error).toContain("Active Flow seats must have distinct worktree paths before migration.");
  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);
});

test("one retired seat does not excuse its still-active twin on the shared path", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository } = await fixture();
  await markRetired(desk, "driver.second");

  // driver.first remains active on the shared path and still owns its registered worktree, so this passes,
  // proving the filter drops only the retired records rather than the path.
  const plan = await flow(desk, "project", "migrate-vcs", "demo", "--to", "jj", "--dry-run");
  expect(plan).toContain("driver.first@demo");
  expect(plan).not.toContain("driver.second@demo");
  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);
});
