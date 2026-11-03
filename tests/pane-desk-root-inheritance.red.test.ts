// URN: test:atdd-flow:pane-desk-root-inheritance
// Acceptance: acc:flow:E027-UNIT-001
// Phase: UNIT
// Layer: integration
// Purpose: Panes that Flow creates inherit the Desk root so spawned seats resolve the Desk without a manual export.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atdd-pane-env-")));
  roots.push(root);
  const site = join(root, "desk"), repository = join(root, "repo"), driver = join(root, "driver"), bin = join(root, "bin"), log = join(root, "herdr.log");
  const seats = join(site, "work", "demo", "seats");
  await Promise.all([mkdir(repository), mkdir(driver), mkdir(bin), ...["main", "driver.active"].map((name) => mkdir(join(seats, name), { recursive: true })), mkdir(join(site, "work", "demo", "tasks"), { recursive: true })]);
  await writeFile(join(site, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: demo\napplication: herdr\n");
  await writeFile(join(site, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
repository: ${repository}
roles:
  main: { address: "main@{project}", branch: main, worktree: "{repository}" }
  driver: { address: "driver.{name}@{project}", branch: "delivery/{name}", worktree: "${driver}" }
`);
  await writeFile(join(seats, "main", "seat.yaml"), `schema: atdd-workflow/seat/v2\naddress: main@demo\nrole: main\nproject: demo\nworktree: ${repository}\nbranch: main\n`);
  await writeFile(join(seats, "driver.active", "seat.yaml"), `schema: atdd-workflow/seat/v2\naddress: driver.active@demo\nrole: driver\nproject: demo\nworktree: ${driver}\nbranch: delivery/active\n`);
  await writeFile(join(site, "work", "demo", "tasks", "W-active.yaml"), "schema: atdd-workflow/task/v1\ntitle: Active\nstatus: in_progress\ncoordinator: main@demo\nassignee: driver.active@demo\ndone_when: [{ text: Delivered }]\n");
  await writeFile(join(bin, "herdr"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$3:$4" in
  workspace:list) printf '%s' '{"result":{"workspaces":[]}}' ;;
  workspace:create) printf '%s' '{"result":{"workspace":{"workspace_id":"w1"}}}' ;;
  worktree:open) case "$*" in *--env*) printf '%s\\n' 'unknown option: --env' >&2; exit 2 ;; esac
    printf '%s' '{"result":{"workspace":{"workspace_id":"w2"},"root_tab":{"tab_id":"w2:t1"},"root_pane":{"pane_id":"w2:p1"}}}' ;;
  tab:list) printf '%s' '{"result":{"tabs":[]}}' ;;
  tab:create) printf '%s' '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}' ;;
  pane:list) printf '%s' '{"result":{"panes":[]}}' ;;
  *) printf '%s' '{"result":{}}' ;;
esac
`);
  await chmod(join(bin, "herdr"), 0o755);
  return { site, log, environment: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, HERDR_SESSION: undefined, PATH: `${bin}:${process.env.PATH ?? ""}` } };
}

test("RED: workspace and tab creation carry the Desk root; Herdr 0.9.3 worktree open has no --env so none is passed", async () => {
  const { site, log, environment } = await fixture();
  const child = Bun.spawn([process.execPath, cli, "multiplexer", "apply", "herdr", "--session", "chosen"], { cwd: site, env: environment, stdout: "pipe", stderr: "pipe" });
  const [, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  const lines = (await readFile(log, "utf8")).split("\n");
  const creates = lines.filter((line) => /(workspace|tab) create/.test(line));
  expect(creates.length).toBeGreaterThanOrEqual(2);
  for (const line of creates) expect(line, line).toContain(`--env ATDD_WORKFLOW_ROOT=${site}`);
  // Installed Herdr 0.9.3 rejects `worktree open --env` ("unknown option"); the real CLI lists no such flag.
  const opens = lines.filter((line) => /worktree open/.test(line));
  expect(opens.length).toBeGreaterThanOrEqual(1);
  for (const line of opens) expect(line, line).not.toContain("--env");
  // The environment is appended: the established argument order is unchanged.
  expect(creates.find((line) => line.includes("workspace create"))).toContain("--label demo --no-focus --env");
});
