// URN: test:flow:jj-vcs-migration:E013-UNIT-001
// Acceptance: acc:flow:E013-UNIT-001
// Phase: UNIT
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function flow(cwd: string, ...args: string[]) {
  return exec(cwd, process.execPath, cli, ...args);
}

async function failFlow(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: isolatedEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).not.toBe(0);
  return `${stdout}${stderr}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-jj-migrate-"));
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
  await flow(desk, "spawn", "demo", "coordinator", "payments");
  await flow(desk, "task", "add", "demo", "delivery", "--title", "Legacy delivery", "--coordinator", "main@demo", "--done-when", "Preserve lineage.");
  await flow(desk, "spawn", "demo", "driver", "feature", "--task", "delivery");
  return { root, desk, repository, worktrees };
}

test("legacy Git project migrates to JJ preserving paths, history, ancestry, and task lineage", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository, worktrees } = await fixture();
  const coordinator = join(worktrees, "payments"), driver = join(worktrees, "feature");
  const taskFile = join(desk, "work", "demo", "tasks", "delivery.yaml");
  const taskBefore = await readFile(taskFile, "utf8");
  const commits = {
    main: await exec(repository, "git", "rev-parse", "main"),
    coordinator: await exec(coordinator, "git", "rev-parse", "integration/payments"),
    driver: await exec(driver, "git", "rev-parse", "delivery/feature"),
  };

  const dryRun = await flow(desk, "project", "migrate-vcs", "demo", "--to", "jj", "--dry-run");
  expect(dryRun).toContain("atdd-flow/vcs-migration-plan/v1");
  expect(dryRun).toContain("driver.feature@demo");
  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);

  expect(await flow(desk, "project", "migrate-vcs", "demo", "--to", "jj")).toContain("migrated git -> jj");
  expect(await readFile(join(desk, "work", "demo", "project.yaml"), "utf8")).toContain("vcs: jj");
  expect(await readFile(taskFile, "utf8")).toBe(taskBefore);

  for (const path of [repository, coordinator, driver]) {
    expect(await realpath(await exec(path, "jj", "workspace", "root"))).toBe(await realpath(path));
  }
  expect(await exec(repository, "git", "rev-parse", "refs/heads/main")).toBe(commits.main);
  expect(await exec(coordinator, "jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id")).toBe(commits.coordinator);
  expect(await exec(driver, "jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id")).toBe(commits.driver);
  expect(await exec(coordinator, "git", "rev-parse", "refs/heads/integration/payments"))
    .toBe(await exec(coordinator, "jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"));
  expect(await exec(driver, "git", "rev-parse", "refs/heads/delivery/feature"))
    .toBe(await exec(driver, "jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"));

  await writeFile(join(driver, "feature.txt"), "post-migration rewrite\n");
  await exec(driver, "jj", "status");
  const rewritten = await exec(driver, "jj", "log", "-r", "@", "--no-graph", "-T", "commit_id");
  expect(await exec(driver, "jj", "log", "-r", "delivery/feature", "--no-graph", "-T", "commit_id")).toBe(rewritten);
  expect(await exec(driver, "git", "rev-parse", "refs/heads/delivery/feature")).toBe(rewritten);
  const task = Bun.YAML.parse(await readFile(taskFile, "utf8")) as { governed_base?: { commit?: string } };
  const base = task.governed_base?.commit;
  expect(base).toBeTruthy();
  await exec(driver, "git", "merge-base", "--is-ancestor", base!, rewritten);
});

test("migration refuses dirty legacy worktrees before creating JJ metadata", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository, worktrees } = await fixture();
  await writeFile(join(worktrees, "feature", "dirty.txt"), "uncommitted\n");
  const error = await failFlow(desk, "project", "migrate-vcs", "demo", "--to", "jj");
  expect(error).toContain("worktree is dirty");
  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);
  expect(await readFile(join(desk, "work", "demo", "project.yaml"), "utf8")).not.toContain("vcs: jj");
});

test("migration refuses a task in review before changing repository topology", async () => {
  if (!Bun.which("jj")) return;
  const { desk, repository } = await fixture();
  await flow(desk, "task", "start", "demo", "delivery", "--by", "driver.feature@demo");
  await flow(desk, "task", "prove", "demo", "delivery", "--by", "driver.feature@demo", "--item", "1", "--proof", "fixture proof");
  await flow(desk, "task", "review", "demo", "delivery", "--by", "driver.feature@demo");

  const error = await failFlow(desk, "project", "migrate-vcs", "demo", "--to", "jj");
  expect(error).toContain("is in review");
  expect(await Bun.file(join(repository, ".jj")).exists()).toBe(false);
  expect(await readFile(join(desk, "work", "demo", "project.yaml"), "utf8")).not.toContain("vcs: jj");
});
