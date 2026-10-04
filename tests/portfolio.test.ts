import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");

async function exec(cwd: string, command: string[], expected = 0) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(expected);
  return stdout.trim();
}

const seat = (cwd: string, ...args: string[]) => exec(cwd, [process.execPath, cli, ...args]);
const git = (cwd: string, ...args: string[]) => exec(cwd, ["git", ...args]);

test("four repository lanes complete local and cross-coordinator threads", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-workflow-portfolio-"));
  try {
    const site = join(root, "site");
    const names = ["alpha", "bravo", "charlie", "delta"];
    const repositories = await Promise.all(names.map(async (name) => {
      const repository = join(root, "repos", name);
      await git(root, "init", "-b", "main", repository);
      await git(repository, "config", "user.email", "test@example.test");
      await git(repository, "config", "user.name", "Test");
      await git(repository, "commit", "--allow-empty", "-m", "initial");
      return { name, repository };
    }));

    await seat(root, "init", site);
    await Promise.all(repositories.map(({ name }) => seat(site, "project", "init", name)));

    for (const { name, repository } of repositories) {
      const roles = {
        coordinator: { address: `coordinator@${name}`, branch: "main", agent: "simulated" },
        driver: { address: `driver.{name}@${name}`, branch: "delivery/{name}", agent: "simulated" },
      };
      await writeFile(join(site, "work", name, "project.yaml"), Bun.YAML.stringify({ schema: "atdd-workflow/project/v1", project: name, roles }));
      await seat(site, "spawn", name, "coordinator", "main", "--worktree", repository);
      for (const driver of ["one", "two", "three", "four"]) {
        const worktree = join(root, "worktrees", name, driver);
        await git(repository, "worktree", "add", "-b", `delivery/${driver}`, worktree, "main");
        await seat(site, "spawn", name, "driver", driver, "--worktree", worktree);
      }
    }

    await Promise.all(repositories.map(async ({ name }) => {
      const coordinator = `coordinator@${name}`;
      const drivers = ["one", "two", "three", "four"].map((driver) => `driver.${driver}@${name}`);
      const thread = await seat(site, "thread", "start", "--with", [coordinator, ...drivers].join(","), "--subject", `${name} rollout`);
      const request = await seat(site, "post", thread, "--from", coordinator, "--to", "all", "--expects-result", "--body", "Run the smoke test.");
      await Promise.all(drivers.map((driver) => seat(site, "result", thread, request, "--from", driver, "--body", "Smoke test passed.")));
    }));

    const coordinators = repositories.map(({ name }) => `coordinator@${name}`);
    const crossThread = await seat(site, "thread", "start", "--with", coordinators.join(","), "--subject", "Cross-project release check");
    const crossRequest = await seat(site, "post", crossThread, "--from", coordinators[0], "--to", "all", "--expects-result", "--body", "Confirm your lane status.");
    await Promise.all(coordinators.slice(1).map((coordinator) => seat(site, "result", crossThread, crossRequest, "--from", coordinator, "--body", "Lane ready.")));

    const status = await seat(site, "status");
    expect(status).not.toContain("waiting:");
    expect(status.split("\n")).toHaveLength(5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
