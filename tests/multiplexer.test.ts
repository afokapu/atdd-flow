import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrPolicy } from "../src/multiplexer";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

async function invoke(cwd: string, environment: Record<string, string | undefined>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}

async function run(cwd: string, ...args: string[]) {
  return invoke(cwd, { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined }, ...args);
}

async function desk() {
  const root = await mkdtemp(join(tmpdir(), "atdd-multiplexer-"));
  roots.push(root);
  const site = join(root, "desk");
  const repository = join(root, "repo");
  const integration = join(root, "integration");
  const driver = join(root, "driver");
  await Promise.all([mkdir(repository), mkdir(integration), mkdir(driver)]);
  await run(root, "init", site);
  await run(site, "project", "init", "demo");
  await writeFile(join(site, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
repository: ${repository}
roles:
  main: { address: "main@{project}", branch: main, worktree: "{repository}" }
  coordinator: { address: "coordinator.{name}@{project}", branch: main, worktree: "{repository}" }
  driver: { address: "driver.{name}@{project}", branch: "delivery/{name}", worktree: "${driver}" }
`);
  await run(site, "spawn", "demo", "main", "primary", "--worktree", repository);
  await run(site, "spawn", "demo", "coordinator", "primary", "--worktree", repository);
  await run(site, "spawn", "demo", "coordinator", "integration", "--worktree", integration);
  await run(site, "spawn", "demo", "driver", "active", "--worktree", driver);
  await run(site, "task", "add", "demo", "W-active", "--title", "Active", "--coordinator", "coordinator.primary@demo", "--assignee", "driver.active@demo", "--done-when", "Delivered");
  return { root, site, repository, integration, driver };
}

async function fakeHerdr(root: string) {
  const bin = join(root, "bin");
  const log = join(root, "herdr.log");
  await mkdir(bin);
  await writeFile(join(bin, "herdr"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$3:$4" in
  workspace:list) printf '%s' '{"result":{"workspaces":[]}}' ;;
  workspace:create) printf '%s' '{"result":{"workspace":{"workspace_id":"w1"}}}' ;;
  worktree:open) printf '%s' '{"result":{"workspace":{"workspace_id":"w2"},"root_tab":{"tab_id":"w2:t1"},"root_pane":{"pane_id":"w2:p1"}}}' ;;
  tab:list) printf '%s' '{"result":{"tabs":[]}}' ;;
  tab:create) printf '%s' '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}' ;;
  pane:list) printf '%s' '{"result":{"panes":[]}}' ;;
  pane:rename|tab:rename|workspace:rename) printf '%s' '{"result":{}}' ;;
  *) printf '%s' '{"result":{}}' ;;
esac
`);
  await chmod(join(bin, "herdr"), 0o755);
  return { log, environment: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, HERDR_SESSION: undefined, PATH: `${bin}:${process.env.PATH ?? ""}` } };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("the bundled Herdr policy is compact, generic, and validated", async () => {
  const policy = await herdrPolicy();
  expect(policy.projection.primary.workspace_label).toBe("{project}");
  const text = await readFile(join(import.meta.dir, "..", "multiplexer", "herdr.yaml"), "utf8");
  expect(text).not.toMatch(/session:|branch:|repository:|\/Users\/|@[a-z]/);
});

test("projection requires an explicit or inherited session and never changes Desk records", async () => {
  const fixture = await desk();
  const fake = await fakeHerdr(fixture.root);
  const before = await readFile(join(fixture.site, "work", "demo", "seats", "driver.active", "seat.yaml"), "utf8");
  expect(await invoke(fixture.site, fake.environment, "multiplexer", "apply", "herdr")).toContain("No Herdr session selected");
  expect(await Bun.file(fake.log).exists()).toBe(false);
  expect(await invoke(fixture.site, fake.environment, "multiplexer", "status", "herdr", "--session", "chosen")).toContain('"session": "chosen"');
  expect(await invoke(fixture.site, { ...fake.environment, HERDR_SESSION: "inherited" }, "multiplexer", "status", "herdr")).toContain('"session": "inherited"');
  await invoke(fixture.site, fake.environment, "multiplexer", "apply", "herdr", "--session", "chosen");
  expect(await readFile(join(fixture.site, "work", "demo", "seats", "driver.active", "seat.yaml"), "utf8")).toBe(before);
});

test("RED: apply anchors linked worktree opens in the primary workspace and reuses each returned root tab/pane", async () => {
  const fixture = await desk();
  const fake = await fakeHerdr(fixture.root);
  await invoke(fixture.site, fake.environment, "multiplexer", "apply", "herdr", "--session", "chosen");
  const calls = await readFile(fake.log, "utf8");
  expect(calls).toContain("--session chosen workspace create --cwd " + fixture.repository + " --label demo --no-focus");
  expect(calls).toContain("--session chosen worktree open --workspace w1 --cwd " + fixture.repository + " --path " + fixture.integration + " --label coordinator.integration@demo --no-focus");
  expect(calls).toContain("--session chosen worktree open --workspace w1 --cwd " + fixture.repository + " --path " + fixture.driver + " --label driver.active@demo --no-focus");
  // The linked-worktree root tab/pane is the seat tab/pane: no second tab may be created.
  expect(calls.match(/tab create/g)?.length).toBe(2);
  expect(calls).toContain("pane rename w1:p1 main@demo");
  expect(calls).not.toContain(" focus");
  expect(calls).not.toContain(" close");
});

test("RED: status reports topology compliance separately from a merely present worktree", async () => {
  const fixture = await desk();
  const fake = await fakeHerdr(fixture.root);
  const output = await invoke(fixture.site, fake.environment, "multiplexer", "status", "herdr", "--session", "chosen");
  expect(JSON.parse(output)).toMatchObject({
    schema: "atdd-workflow/multiplexer-status/v1",
    present: 0,
    topology_compliant: 0,
  });
});

test("Herdr attachment qualifies identical pane ids by their inherited session", async () => {
  const fixture = await desk();
  const first = { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, HERDR_PANE_ID: "w1:p1", HERDR_SESSION: "one" };
  const second = { ...first, HERDR_SESSION: "two" };
  await invoke(fixture.site, first, "attach", "driver.active@demo", "--application", "herdr");
  const firstSeat = await readFile(join(fixture.site, "work", "demo", "seats", "driver.active", "seat.yaml"), "utf8");
  expect(firstSeat).toContain("session: one");
  await invoke(fixture.site, second, "attach", "driver.active@demo", "--application", "herdr");
  const secondSeat = await readFile(join(fixture.site, "work", "demo", "seats", "driver.active", "seat.yaml"), "utf8");
  expect(secondSeat).toContain("session: two");
  expect(secondSeat).toContain("pane: w1:p1");
});
