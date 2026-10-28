import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrPolicy, projectHerdrSeat } from "../src/multiplexer";

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
  // Canonical path: the process cwd of a child spawned here is reported without symlinks.
  const root = await realpath(await mkdtemp(join(tmpdir(), "atdd-multiplexer-")));
  roots.push(root);
  const site = join(root, "desk");
  const repository = join(root, "repo");
  const integration = join(root, "integration");
  const driver = join(root, "driver");
  const seats = join(site, "work", "demo", "seats");
  const tasks = join(site, "work", "demo", "tasks");
  await Promise.all([
    mkdir(repository), mkdir(integration), mkdir(driver), mkdir(tasks, { recursive: true }),
    ...["main", "coordinator.primary", "coordinator.integration", "driver.active"].map((name) => mkdir(join(seats, name), { recursive: true })),
  ]);
  await writeFile(join(site, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: demo\napplication: herdr\n");
  await writeFile(join(site, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
repository: ${repository}
roles:
  main: { address: "main@{project}", branch: main, worktree: "{repository}" }
  coordinator: { address: "coordinator.{name}@{project}", branch: main, worktree: "{repository}" }
  driver: { address: "driver.{name}@{project}", branch: "delivery/{name}", worktree: "${driver}" }
`);
  await Promise.all([
    writeFile(join(seats, "main", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: main@demo
role: main
project: demo
worktree: ${repository}
branch: main
`),
    writeFile(join(seats, "coordinator.primary", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: coordinator.primary@demo
role: coordinator
project: demo
worktree: ${repository}
branch: main
`),
    writeFile(join(seats, "coordinator.integration", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: coordinator.integration@demo
role: coordinator
project: demo
worktree: ${integration}
branch: main
`),
    writeFile(join(seats, "driver.active", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: driver.active@demo
role: driver
project: demo
worktree: ${driver}
branch: delivery/active
`),
    writeFile(join(tasks, "W-active.yaml"), "schema: atdd-workflow/task/v1\ntitle: Active\nstatus: in_progress\ncoordinator: coordinator.primary@demo\nassignee: driver.active@demo\ndone_when: [{ text: Delivered }]\n"),
  ]);
  return { root, site, repository, integration, driver };
}

async function fakeHerdr(root: string, liveWorkspaces = "[]") {
  const bin = join(root, "bin");
  const log = join(root, "herdr.log");
  await mkdir(bin);
  await writeFile(join(bin, "herdr"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$3:$4" in
  workspace:list) printf '%s' '{"result":{"workspaces":${liveWorkspaces}}}' ;;
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

test("RED: Herdr 0.9.3 linked opens use one primary anchor plus an explicit worktree selector and reuse each returned root tab/pane", async () => {
  const fixture = await desk();
  const fake = await fakeHerdr(fixture.root);
  await invoke(fixture.site, fake.environment, "multiplexer", "apply", "herdr", "--session", "chosen");
  const calls = await readFile(fake.log, "utf8");
  expect(calls).toContain("--session chosen workspace create --cwd " + fixture.repository + " --label demo --no-focus");
  // Herdr 0.9.3 requires an explicit path-or-branch selector. Its linked
  // worktree open may use exactly one primary anchor; do not combine --cwd
  // with the primary workspace selector (real dry-runs rejected it).
  expect(calls).toContain("--session chosen worktree open --workspace w1 --path " + fixture.integration + " --label coordinator.integration@demo --no-focus");
  expect(calls).toContain("--session chosen worktree open --workspace w1 --path " + fixture.driver + " --label driver.active@demo --no-focus");
  expect(calls).not.toContain("worktree open --workspace w1 --cwd");
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

test("RED: an operator seat at the primary worktree is projected alongside main and coordinator without admitting unrelated roles", async () => {
  const fixture = await desk();
  const seats = join(fixture.site, "work", "demo", "seats");
  await Promise.all(["operator", "reviewer.primary"].map((name) => mkdir(join(seats, name), { recursive: true })));
  await writeFile(join(seats, "operator", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: operator@demo
role: operator
project: demo
worktree: ${fixture.repository}
branch: main
`);
  await writeFile(join(seats, "reviewer.primary", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: reviewer.primary@demo
role: reviewer
project: demo
worktree: ${fixture.repository}
branch: main
`);
  const fake = await fakeHerdr(fixture.root);
  const bin = join(fixture.root, "bin", "herdr");
  const command = async (args: string[]) => {
    const child = Bun.spawn([bin, ...args.slice(1)], { env: fake.environment, stdout: "pipe", stderr: "pipe" });
    return new Response(child.stdout).text();
  };
  expect(await projectHerdrSeat(fixture.site, "main@demo", "chosen", command)).toMatchObject({ label: "main@demo" });
  expect(await projectHerdrSeat(fixture.site, "coordinator.primary@demo", "chosen", command)).toMatchObject({ label: "coordinator.primary@demo" });
  expect(await projectHerdrSeat(fixture.site, "operator@demo", "chosen", command)).toMatchObject({ label: "operator@demo" });
  await expect(projectHerdrSeat(fixture.site, "reviewer.primary@demo", "chosen", command)).rejects.toThrow("No active Desk projection target");
});

async function misplace(site: string, stale: string) {
  // A seat recorded before the topology existed: role main, but not the primary main identity/worktree.
  await mkdir(stale);
  await mkdir(join(site, "work", "demo", "seats", "main.legacy"), { recursive: true });
  await writeFile(join(site, "work", "demo", "seats", "main.legacy", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: main.legacy@demo
role: main
project: demo
worktree: ${stale}
branch: main
`);
}

test("RED: multiplexer status reports a misplaced seat as unprojected instead of aborting every projection", async () => {
  const fixture = await desk();
  const fake = await fakeHerdr(fixture.root);
  await misplace(fixture.site, join(fixture.root, "stale"));
  const output = await invoke(fixture.site, fake.environment, "multiplexer", "status", "herdr", "--session", "chosen");
  const status = JSON.parse(output);
  expect(status).toMatchObject({ schema: "atdd-workflow/multiplexer-status/v1", desired: 5 });
  expect(status.unprojected).toEqual([expect.objectContaining({ address: "main.legacy@demo" })]);
});

test("RED: multiplexer apply projects every other seat and reports the misplaced seat", async () => {
  const fixture = await desk();
  const fake = await fakeHerdr(fixture.root);
  await misplace(fixture.site, join(fixture.root, "stale"));
  const output = await invoke(fixture.site, fake.environment, "multiplexer", "apply", "herdr", "--session", "chosen");
  expect(output).toContain("unprojected  main.legacy@demo");
  const calls = await readFile(fake.log, "utf8");
  expect(calls).toContain("--label driver.active@demo");
  expect(calls).toContain("--label coordinator.integration@demo");
  expect(calls).not.toContain("main.legacy@demo");
});

test("RED: a live workspace without a checkout path never matches a projection target", async () => {
  const fixture = await desk();
  const fake = await fakeHerdr(fixture.root, '[{"workspace_id":"wx","label":"scratch"}]');
  // resolve("") is the process cwd; running from the primary checkout must not adopt the unrelated workspace.
  const status = JSON.parse(await invoke(fixture.repository, fake.environment, "--root", fixture.site, "multiplexer", "status", "herdr", "--session", "chosen"));
  expect(status).toMatchObject({ present: 0, topology_compliant: 0 });
  await invoke(fixture.repository, fake.environment, "--root", fixture.site, "multiplexer", "apply", "herdr", "--session", "chosen");
  const calls = await readFile(fake.log, "utf8");
  expect(calls).toContain("--session chosen workspace create --cwd " + fixture.repository + " --label demo --no-focus");
  expect(calls).not.toContain("workspace rename wx");
  expect(calls).not.toContain("--workspace wx");
});

/** In-process Herdr stub whose workspace list reflects earlier creates; created primaries report no checkout path. */
function statefulHerdr(initial: Array<Record<string, unknown>>) {
  const workspaces = [...initial];
  const tabs: Array<{ tab_id: string; workspace_id: string; label?: string }> = [];
  const panes: Array<{ pane_id: string; tab_id: string; label?: string }> = [];
  const calls: string[] = [];
  let next = 0;
  const command = async (args: string[]) => {
    const rest = args.slice(3);
    calls.push(rest.join(" "));
    const flag = (name: string) => rest[rest.indexOf(name) + 1];
    const reply = (result: unknown) => JSON.stringify({ result });
    switch (`${rest[0]}:${rest[1]}`) {
      case "workspace:list": return reply({ workspaces });
      case "workspace:create":
      case "worktree:open": {
        const id = `w${++next}`;
        // Observed Herdr behavior for a non-code primary checkout: the listed workspace has worktree=null.
        workspaces.push({ workspace_id: id, label: flag("--label"), worktree: rest[0] === "worktree" ? { checkout_path: flag("--path") } : null });
        tabs.push({ tab_id: `${id}:t1`, workspace_id: id }); panes.push({ pane_id: `${id}:p1`, tab_id: `${id}:t1` });
        return reply({ workspace: { workspace_id: id }, root_tab: { tab_id: `${id}:t1` }, root_pane: { pane_id: `${id}:p1` } });
      }
      case "tab:list": return reply({ tabs: tabs.filter((tab) => tab.workspace_id === flag("--workspace")) });
      case "tab:create": {
        const id = `${flag("--workspace")}:t${tabs.length + 1}`;
        tabs.push({ tab_id: id, workspace_id: flag("--workspace"), label: flag("--label") }); panes.push({ pane_id: `${id}:p`, tab_id: id });
        return reply({ tab: { tab_id: id }, root_pane: { pane_id: `${id}:p` } });
      }
      case "tab:rename": { const tab = tabs.find((entry) => entry.tab_id === rest[2]); if (tab) tab.label = rest[3]; return reply({}); }
      case "pane:list": { const ids = new Set(tabs.filter((tab) => tab.workspace_id === flag("--workspace")).map((tab) => tab.tab_id)); return reply({ panes: panes.filter((pane) => ids.has(pane.tab_id)) }); }
      case "pane:rename": { const pane = panes.find((entry) => entry.pane_id === rest[2]); if (pane) pane.label = rest[3]; return reply({}); }
      default: return reply({});
    }
  };
  return { command, calls };
}

test("RED: a primary workspace listed without a checkout path is reused by its exact project label on every projection", async () => {
  const fixture = await desk();
  const herdr = statefulHerdr([]);
  const first = await projectHerdrSeat(fixture.site, "main@demo", "chosen", herdr.command);
  const second = await projectHerdrSeat(fixture.site, "main@demo", "chosen", herdr.command);
  expect(second.workspace).toBe(first.workspace);
  expect(herdr.calls.filter((call) => call.startsWith("workspace create")).length).toBe(1);
  expect(herdr.calls.some((call) => call.startsWith("workspace rename"))).toBe(false);
});

test("a no-checkout workspace with a different label is never adopted or renamed as the primary", async () => {
  const fixture = await desk();
  const herdr = statefulHerdr([{ workspace_id: "wx", label: "scratch", worktree: null }]);
  const projected = await projectHerdrSeat(fixture.site, "main@demo", "chosen", herdr.command);
  expect(projected.workspace).not.toBe("wx");
  expect(herdr.calls).toContain(`workspace create --cwd ${fixture.repository} --label demo --no-focus`);
  expect(herdr.calls.some((call) => call.includes("wx"))).toBe(false);
});

test("a linked seat target still requires a checkout path even when a no-checkout workspace carries its label", async () => {
  const fixture = await desk();
  const herdr = statefulHerdr([{ workspace_id: "wl", label: "coordinator.integration@demo", worktree: null }]);
  const projected = await projectHerdrSeat(fixture.site, "coordinator.integration@demo", "chosen", herdr.command);
  expect(projected.workspace).not.toBe("wl");
  expect(herdr.calls.some((call) => call.startsWith(`worktree open --workspace w1 --path ${fixture.integration}`))).toBe(true);
});

test("RED: legacy generic coordinator@project sharing the primary main worktree is not bulk-projected, while main, operator, and named coordinators are", async () => {
  const fixture = await desk();
  const seats = join(fixture.site, "work", "demo", "seats");
  await Promise.all(["coordinator", "operator"].map((name) => mkdir(join(seats, name), { recursive: true })));
  await Promise.all([
    writeFile(join(seats, "coordinator", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: coordinator@demo
role: coordinator
project: demo
worktree: ${fixture.repository}
branch: main
`),
    writeFile(join(seats, "operator", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: operator@demo
role: operator
project: demo
worktree: ${fixture.repository}
branch: main
`),
  ]);
  const fake = await fakeHerdr(fixture.root);
  await invoke(fixture.site, fake.environment, "multiplexer", "apply", "herdr", "--session", "chosen");
  const calls = await readFile(fake.log, "utf8");
  for (const projected of ["main@demo", "operator@demo", "coordinator.primary@demo", "coordinator.integration@demo"]) expect(calls).toContain(projected);
  expect(calls).not.toContain("coordinator@demo");
  const status = JSON.parse(await invoke(fixture.site, fake.environment, "multiplexer", "status", "herdr", "--session", "chosen"));
  expect(status.unprojected.map((entry: { address: string }) => entry.address)).not.toContain("coordinator@demo");
  // Option A: an explicit per-seat projection still projects the legacy seat.
  const command = async (args: string[]) => {
    const child = Bun.spawn([join(fixture.root, "bin", "herdr"), ...args.slice(1)], { env: fake.environment, stdout: "pipe", stderr: "pipe" });
    return new Response(child.stdout).text();
  };
  expect(await projectHerdrSeat(fixture.site, "coordinator@demo", "chosen", command)).toMatchObject({ label: "coordinator@demo" });
});

test("a project whose only primary coordinator is the legacy generic one keeps its primary tab", async () => {
  const fixture = await desk();
  const seats = join(fixture.site, "work", "demo", "seats");
  await rm(join(seats, "main"), { recursive: true });
  await mkdir(join(seats, "coordinator"), { recursive: true });
  await writeFile(join(seats, "coordinator", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: coordinator@demo
role: coordinator
project: demo
worktree: ${fixture.repository}
branch: main
`);
  const fake = await fakeHerdr(fixture.root);
  await invoke(fixture.site, fake.environment, "multiplexer", "apply", "herdr", "--session", "chosen");
  expect(await readFile(fake.log, "utf8")).toContain("coordinator@demo");
});
