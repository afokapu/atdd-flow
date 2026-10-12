// URN: test:flow:named-coordinator-topology-migration:E001-RED-001
// Acceptance: acc:flow:E001-RED-001
// Phase: RED
// Layer: integration
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const baseline = "dc098fd9f82d69cfc642c004e77c5bf7f4f04074";

type Invocation = { stdout: string; stderr: string; code: number };
type Fixture = {
  root: string;
  site: string;
  projectFile: string;
  seats: string;
  repository: string;
  worktrees: string;
  remote: string;
  baseline: string;
  genericFile: string;
};

async function invoke(cwd: string, ...args: string[]): Promise<Invocation> {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

async function run(cwd: string, ...args: string[]) {
  const result = await invoke(cwd, ...args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}

function coordinator(address: string, branch: string, worktree: string) {
  return {
    schema: "atdd-workflow/seat/v2",
    address,
    role: "coordinator",
    project: "demo",
    worktree,
    branch,
    runtime: {
      application: "herdr",
      addresses: { herdr: { session: "fixture", pane: "w1:p1" } },
      attached_at: "2026-10-12T00:00:00.000Z",
    },
  };
}

async function writeSeat(fixture: Fixture, folder: string, record: Record<string, unknown>) {
  const file = join(fixture.seats, folder, "seat.yaml");
  await mkdir(join(fixture.seats, folder), { recursive: true });
  await Bun.write(file, Bun.YAML.stringify(record));
  return file;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "atdd-named-topology-migration-"));
  roots.push(root);
  const site = join(root, "desk");
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  const worktrees = join(root, "worktrees");
  await mkdir(repository);
  await mkdir(worktrees);
  await git(root, "init", "--bare", remote);
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.email", "fixture@example.test");
  await git(repository, "config", "user.name", "Fixture");
  await writeFile(join(repository, "README.md"), "fixture\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "initial");
  await git(repository, "remote", "add", "origin", remote);
  await git(repository, "push", "-u", "origin", "main");
  const remoteBaseline = await git(repository, "rev-parse", "HEAD");

  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  const projectFile = join(site, "work", "demo", "project.yaml");
  const project = Bun.YAML.parse(await Bun.file(projectFile).text()) as Record<string, unknown>;
  project.repository = repository;
  project.worktree_root = worktrees;
  project.roles = {
    main: { address: "main@{project}", branch: "main", worktree: "{repository}" },
    coordinator: {
      address: "coordinator@{project}", branch: "main", worktree: "{repository}", agent: "pi", purpose: "Preserved legacy coordinator policy.",
    },
    driver: { address: "driver.{name}@{project}", branch: "delivery/{name}", base: "main", worktree: "{worktree_root}/{name}" },
  };
  await Bun.write(projectFile, Bun.YAML.stringify(project));

  const seats = join(site, "work", "demo", "seats");
  const genericFile = await writeSeat({ root, site, projectFile, seats, repository, worktrees, remote, baseline: remoteBaseline, genericFile: "" }, "coordinator", coordinator("coordinator@demo", "main", repository));
  // Resolver's primary checkout is preservation-only and can be dirty; migration must leave it byte-identical.
  await writeFile(join(repository, ".README.md.swp"), "preserve this dirty primary artifact\n");
  return { root, site, projectFile, seats, repository, worktrees, remote, baseline: remoteBaseline, genericFile };
}

async function files(root: string, folder: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(found, await files(root, full));
    else found[relative(root, full)] = await readFile(full, "utf8");
  }
  return found;
}

async function snapshot(fixture: Fixture) {
  return {
    project: await readFile(fixture.projectFile, "utf8"),
    seats: await files(fixture.site, fixture.seats),
    repository: {
      status: await git(fixture.repository, "status", "--porcelain=v1"),
      head: await git(fixture.repository, "rev-parse", "HEAD"),
      refs: await git(fixture.repository, "for-each-ref", "--format=%(refname) %(objectname)"),
      worktrees: await git(fixture.repository, "worktree", "list", "--porcelain"),
    },
  };
}

async function expectRefusal(fixture: Fixture, args: string[], expected: string) {
  const before = await snapshot(fixture);
  const result = await invoke(fixture.site, "project", "migrate-named-coordinator-topology", ...args);
  expect(result.code).not.toBe(0);
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output).toContain(expected);
  expect(await snapshot(fixture)).toEqual(before);
  return output;
}

function migrationArgs(fixture: Fixture, baseline = fixture.baseline) {
  return ["demo", "--baseline", baseline];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("RED: migrates only policy after an exact remote-main baseline and preserves generic history/resources", async () => {
  const subject = await fixture();
  const before = await snapshot(subject);

  const migration = await invoke(subject.site, "project", "migrate-named-coordinator-topology", ...migrationArgs(subject));
  expect(migration.code, migration.stderr).toBe(0);
  // RED sentinel: reaching this point means the absent command has appeared and RED must be replaced by GREEN.
  expect.fail("RED: named-coordinator topology migration is not implemented");
  expect(migration.stdout).toBe("demo  named coordinator topology migrated");

  const migrated = Bun.YAML.parse(await Bun.file(subject.projectFile).text()) as { roles: Record<string, Record<string, string>> };
  expect(migrated.roles.coordinator).toEqual({
    address: "coordinator.{name}@{project}",
    branch: "integration/{name}",
    base: "main",
    worktree: "{worktree_root}/{name}",
    agent: "pi",
    purpose: "Preserved legacy coordinator policy.",
  });
  expect(await Bun.file(subject.genericFile).text()).toBe(before.seats[relative(subject.site, subject.genericFile)]);
  const after = await snapshot(subject);
  expect(after.seats).toEqual(before.seats);
  expect(after.repository).toEqual(before.repository);
  expect(after.project).not.toBe(before.project);
});

test("RED: rejects malformed, missing, wrong, non-remote, and remote-only baselines without side effects", async () => {
  const subject = await fixture();
  const missingBaseline = await expectRefusal(subject, ["demo"], "Missing --baseline.");
  expect(missingBaseline).toContain("Missing --baseline.");
  await expectRefusal(subject, migrationArgs(subject, "not-a-sha"), "--baseline must be a full lowercase SHA-1.");
  await expectRefusal(subject, migrationArgs(subject, "0000000000000000000000000000000000000000"), "does not equal origin/main");

  await writeFile(join(subject.repository, "LOCAL_ONLY"), "local only\n");
  await git(subject.repository, "add", "LOCAL_ONLY");
  await git(subject.repository, "commit", "-m", "local only");
  const localOnly = await git(subject.repository, "rev-parse", "HEAD");
  await expectRefusal(subject, migrationArgs(subject, localOnly), "does not equal origin/main");

  const publisher = join(subject.root, "publisher");
  await git(subject.root, "clone", "--branch", "main", subject.remote, publisher);
  await git(publisher, "config", "user.email", "publisher@example.test");
  await git(publisher, "config", "user.name", "Publisher");
  await writeFile(join(publisher, "REMOTE_ONLY"), "remote only\n");
  await git(publisher, "add", "REMOTE_ONLY");
  await git(publisher, "commit", "-m", "remote only");
  await git(publisher, "push", "origin", "main");
  const remoteOnly = await git(publisher, "rev-parse", "HEAD");
  await expectRefusal(subject, migrationArgs(subject, remoteOnly), "is not available locally");
});

test("RED: rejects missing project, repository, or worktree root without writing policy", async () => {
  const subject = await fixture();
  const missingProject = await expectRefusal(subject, ["missing", "--baseline", subject.baseline], "Project missing does not exist.");
  expect(missingProject).toContain("Project missing does not exist.");

  const withoutRepository = await fixture();
  const repositoryProject = Bun.YAML.parse(await Bun.file(withoutRepository.projectFile).text()) as Record<string, unknown>;
  delete repositoryProject.repository;
  await Bun.write(withoutRepository.projectFile, Bun.YAML.stringify(repositoryProject));
  await expectRefusal(withoutRepository, migrationArgs(withoutRepository), "Project demo has no repository.");

  const withoutRoot = await fixture();
  const rootProject = Bun.YAML.parse(await Bun.file(withoutRoot.projectFile).text()) as Record<string, unknown>;
  delete rootProject.worktree_root;
  await Bun.write(withoutRoot.projectFile, Bun.YAML.stringify(rootProject));
  await expectRefusal(withoutRoot, migrationArgs(withoutRoot), "Project demo has no worktree_root.");
});

test("RED: rejects named seat, branch, worktree, and legacy-generic collisions atomically", async () => {
  const subject = await fixture();
  await writeSeat(subject, "coordinator.alpha", coordinator("coordinator.alpha@demo", "integration/alpha", join(subject.worktrees, "alpha")));
  await writeSeat(subject, "coordinator.duplicate", coordinator("coordinator.alpha@demo", "integration/duplicate", join(subject.worktrees, "duplicate")));
  const seatCollision = await expectRefusal(subject, migrationArgs(subject), "Named coordinator seat collision");
  expect(seatCollision).toContain("Named coordinator seat collision");

  const branch = await fixture();
  await writeSeat(branch, "coordinator.alpha", coordinator("coordinator.alpha@demo", "integration/alpha", join(branch.worktrees, "alpha")));
  await writeSeat(branch, "coordinator.beta", coordinator("coordinator.beta@demo", "integration/alpha", join(branch.worktrees, "beta")));
  await expectRefusal(branch, migrationArgs(branch), "Named coordinator branch collision");

  const worktree = await fixture();
  await writeSeat(worktree, "coordinator.alpha", coordinator("coordinator.alpha@demo", "integration/alpha", join(worktree.worktrees, "alpha")));
  await writeSeat(worktree, "coordinator.beta", coordinator("coordinator.beta@demo", "integration/beta", join(worktree.worktrees, "alpha")));
  await expectRefusal(worktree, migrationArgs(worktree), "Named coordinator worktree collision");

  const generic = await fixture();
  await Bun.write(generic.genericFile, Bun.YAML.stringify(coordinator("coordinator@demo", "integration/alpha", join(generic.worktrees, "alpha"))));
  await writeSeat(generic, "coordinator.alpha", coordinator("coordinator.alpha@demo", "integration/alpha", join(generic.worktrees, "alpha")));
  await expectRefusal(generic, migrationArgs(generic), "Legacy generic coordinator collides");
});

test("RED: refuses an atomic publish failure without partial Desk policy or resource mutation", async () => {
  const subject = await fixture();
  const before = await snapshot(subject);
  await chmod(join(subject.site, "work", "demo"), 0o555);
  try {
    const result = await invoke(subject.site, "project", "migrate-named-coordinator-topology", ...migrationArgs(subject));
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Unable to atomically write migration policy.");
  } finally {
    await chmod(join(subject.site, "work", "demo"), 0o755);
  }
  expect(await snapshot(subject)).toEqual(before);
});
