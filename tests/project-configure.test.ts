import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vcsMode } from "../src/vcs";
import { parse, stringify } from "yaml";
import { projectHerdrSeat } from "../src/multiplexer";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

async function exec(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd, env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: `${stdout}${stderr}`.trim() };
}
const run = async (cwd: string, ...args: string[]) => { const r = await exec(cwd, args); expect(r.code, r.out).toBe(0); return r.out; };
const fail = async (cwd: string, ...args: string[]) => { const r = await exec(cwd, args); expect(r.code, r.out).not.toBe(0); return r.out; };
async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atdd-project-configure-")));
  roots.push(root);
  const site = join(root, "desk"), repository = join(root, "repo"), worktrees = join(root, "worktrees");
  await mkdir(join(repository, "nested"), { recursive: true });
  await git(repository, "init", "--initial-branch=main");
  await writeFile(join(repository, "README.md"), "fixture\n");
  await writeFile(join(repository, "nested", "file.txt"), "nested\n");
  await git(repository, "add", ".");
  await git(repository, "-c", "user.email=f@example.test", "-c", "user.name=F", "commit", "-m", "initial");
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  return { root, site, repository, worktrees, projectFile: join(site, "work", "demo", "project.yaml") };
}

test("RED: project configure sets repository and worktree root so named coordinators spawn without manual YAML", async () => {
  const { site, repository, worktrees, projectFile } = await fixture();
  expect(await fail(site, "spawn", "demo", "coordinator", "payments", "--worktree", join(worktrees, "payments"))).toContain("must use its declared integration/payments branch");
  expect(await run(site, "project", "configure", "demo", "--repository", repository, "--worktree-root", worktrees)).toContain("demo  configured");
  const config = await readFile(projectFile, "utf8");
  expect(config).toContain(`repository: ${repository}`);
  expect(config).toContain(`worktree_root: ${worktrees}`);
  expect(await run(site, "spawn", "demo", "coordinator", "payments")).toBe("coordinator.payments@demo");
});

test("persisted project VCS fails closed on unsupported values", () => {
  expect(vcsMode({ vcs: undefined })).toBe("git");
  expect(() => vcsMode({ vcs: "fossil" as never })).toThrow("Unsupported project VCS: fossil");
});

test("RED: project configure fails closed for non-repository paths and malformed flags without changing the project", async () => {
  const { root, site, repository, worktrees, projectFile } = await fixture();
  const before = await readFile(projectFile, "utf8");
  const plain = join(root, "plain");
  await mkdir(plain);
  const usage = "Use `atdd-flow project configure";
  expect(await fail(site, "project", "configure", "demo", "--repository", plain)).toContain("is not the top level of a Git repository");
  expect(await fail(site, "project", "configure", "demo", "--repository", join(repository, "nested"))).toContain("is not the top level of a Git repository");
  expect(await fail(site, "project", "configure", "demo", "--repository", join(root, "missing"))).toContain("is not the top level of a Git repository");
  expect(await fail(site, "project", "configure", "demo", "--repo", repository)).toContain(usage);
  expect(await fail(site, "project", "configure", "demo", "--vcs", "fossil")).toContain(usage);
  expect(await fail(site, "project", "configure", "demo", "--vcs", "jj")).toContain("Project repository is required before selecting a VCS.");
  expect(await fail(site, "project", "configure", "demo", "--repository", repository, "--worktree-root", worktrees, "--force")).toContain(usage);
  expect(await fail(site, "project", "configure", "demo", "--repository")).toContain(usage);
  expect(await fail(site, "project", "configure", "demo", "--repository", repository, "--repository", repository)).toContain(usage);
  expect(await fail(site, "project", "configure", "demo")).toContain(usage);
  // A valid repository combined with an invalid flag must not partially apply.
  expect(await fail(site, "project", "configure", "demo", "--repository", repository, "--worktree-root")).toContain(usage);
  expect(await readFile(projectFile, "utf8")).toBe(before);
});

test("RED: one misplaced seat is left unprojected without aborting projection of other seats; explicitly projecting it still rejects", async () => {
  const { root, site, repository, worktrees, projectFile } = await fixture();
  // Recorded before the project declared its repository, so its placement predates the topology.
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", join(root, "stale-main-copy"));
  await writeFile(projectFile, stringify({ ...parse(await readFile(projectFile, "utf8")), repository, worktree_root: worktrees }));
  await run(site, "spawn", "demo", "coordinator", "payments");
  const reachedHerdr = async (): Promise<string> => { throw new Error("reached herdr"); };
  await expect(projectHerdrSeat(site, "coordinator.payments@demo", "fake", reachedHerdr)).rejects.toThrow("reached herdr");
  await expect(projectHerdrSeat(site, "coordinator@demo", "fake", reachedHerdr)).rejects.toThrow("mismatched placement");
});

test("RED: project configure reports seats whose recorded placement violates the configured topology", async () => {
  const { root, site, repository, worktrees } = await fixture();
  await run(site, "spawn", "demo", "coordinator", "main", "--worktree", join(root, "stale-main-copy"));
  const configured = await run(site, "project", "configure", "demo", "--repository", repository, "--worktree-root", worktrees);
  expect(configured).toContain("unprojected  coordinator@demo");
  expect(configured).toContain("demo  configured");
});
