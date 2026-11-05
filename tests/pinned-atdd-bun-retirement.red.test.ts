// URN: test:flow:pinned-atdd-bun-retirement:E024-UNIT-001
// Acceptance: acc:flow:E024-UNIT-001
// Phase: UNIT
// Layer: integration
// RED: seat retirement (`task done --retire-assignee`, tasks.ts retirementBun) is a Flow-invoked ATDD Bun call site.
// It must resolve the pinned toolkit from the explicit target worktree being retired -- never the primary checkout,
// never PATH -- and a missing/invalid pin must fail closed instead of degrading to merge proof.
// Plan: plans/pinned-atdd-bun-resolution.md (task flow-invoked-pinned-atdd-bun-resolution-20261104).
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const originalPath = process.env.PATH;
const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function spawn(command: string[], cwd: string, env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

async function git(cwd: string, ...args: string[]) {
  const result = await spawn(["git", ...args], cwd);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

type Layout =
  | { kind: "consumer"; declared?: string; installed?: string; omit?: "node_modules" | "bin" | "bin-escape" | "conventions" | "manifest"; globalExits?: number }
  | { kind: "source"; omit?: "cli" | "conventions" | "manifest"; globalExits?: number };

const pinnedFake = (marker: string, label: string) => `#!/bin/sh\necho "${label} $*" >> "${marker}"\necho "${label} PASS"\n`;

/** Desk + git repository + linked driver worktree, a sentinel global `atdd-bun` on PATH, and a decoy pin in the primary checkout. */
async function fixture(layout: Layout) {
  const base = await mkdtemp(join(tmpdir(), "atdd-flow-retire-pin-"));
  scratch.push(base);
  const repository = join(base, "repository");
  const worktrees = join(base, "worktrees");
  const site = join(base, "site");
  const globalBin = join(base, "global-bin");
  const globalMarker = join(base, "global-ran");
  const primaryMarker = join(base, "primary-ran");
  const installed = layout.kind === "consumer" ? layout.installed ?? "0.10.0" : "0.10.0";
  const environment = { ...process.env, PATH: `${globalBin}:${originalPath}` };

  await mkdir(globalBin, { recursive: true });
  await writeFile(join(globalBin, "atdd-bun"), `#!/bin/sh\necho ran >> "${globalMarker}"\necho "global verdict" >&2\nexit ${layout.globalExits ?? 0}\n`);
  await chmod(join(globalBin, "atdd-bun"), 0o755);

  await git(base, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "test@example.test");
  await git(repository, "config", "user.name", "Test");
  await writeFile(join(repository, ".gitignore"), "node_modules/\n.pinned-ran\n");
  await writeFile(join(repository, "atdd-bun.yaml"), `worktrees:\n  enabled: true\n  root: ../worktrees\n  primary_directory: repository\n  primary_branch: main\n  require_linked_worktree: true\n`);
  if (layout.kind === "source") {
    await writeFile(join(repository, "package.json"), layout.omit === "manifest" ? "{ not json" : JSON.stringify({ name: "@afokapu/atdd-bun", version: installed }));
    if (layout.omit !== "cli") {
      await mkdir(join(repository, "src"), { recursive: true });
      await writeFile(join(repository, "src", "cli.ts"), `import { appendFileSync } from "node:fs";\nappendFileSync(import.meta.dir + "/../.pinned-ran", "source " + process.argv.slice(2).join(" ") + "\\n");\nconsole.log("source PASS");\n`);
    }
    if (layout.omit !== "conventions") {
      await mkdir(join(repository, "conventions"), { recursive: true });
      await writeFile(join(repository, "conventions", "README.md"), "conventions\n");
    }
  } else {
    await writeFile(join(repository, "package.json"), layout.omit === "manifest" ? "{ not json" : JSON.stringify({ name: "consumer", devDependencies: { "@afokapu/atdd-bun": layout.declared ?? "0.10.0" } }));
  }
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "configure");

  // Decoy: a valid-looking pin in the PRIMARY checkout. The target worktree rule means it must never be used.
  await mkdir(join(repository, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(repository, "node_modules", ".bin", "atdd-bun"), pinnedFake(primaryMarker, "primary"));
  await chmod(join(repository, "node_modules", ".bin", "atdd-bun"), 0o755);

  const run = async (cwd: string, ...args: string[]) => spawn([process.execPath, cli, ...args], cwd, environment);
  const ok = async (cwd: string, ...args: string[]) => {
    const result = await run(cwd, ...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")}: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  await ok(base, "init", site);
  await ok(site, "project", "init", "demo", "--vcs", "git");
  await writeFile(join(site, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
vcs: git
repository: ${repository}
worktree_root: ${worktrees}
roles:
  coordinator:
    address: coordinator@{project}
    branch: main
    agent: codex
    worktree: "{repository}"
  driver:
    address: driver.{name}@{project}
    branch: delivery/{name}
    base: main
    agent: codex
    worktree: "{worktree_root}/{name}"
`);
  await ok(site, "spawn", "demo", "coordinator", "main");
  await ok(site, "spawn", "demo", "driver", "runtime");
  const target = join(worktrees, "runtime");
  const pinnedMarker = join(target, ".pinned-ran");

  if (layout.kind === "consumer" && layout.omit !== "node_modules") {
    const pkg = join(target, "node_modules", "@afokapu", "atdd-bun");
    await mkdir(join(target, "node_modules", ".bin"), { recursive: true });
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@afokapu/atdd-bun", version: installed }));
    if (layout.omit !== "conventions") {
      await mkdir(join(pkg, "conventions"), { recursive: true });
      await writeFile(join(pkg, "conventions", "README.md"), "conventions\n");
    }
    const binTarget = layout.omit === "bin-escape" ? join(base, "elsewhere-atdd-bun") : join(pkg, "cli.sh");
    await writeFile(binTarget, pinnedFake(pinnedMarker, "pinned"));
    await chmod(binTarget, 0o755);
    if (layout.omit !== "bin") await symlink(binTarget, join(target, "node_modules", ".bin", "atdd-bun"));
  }

  await ok(site, "task", "add", "demo", "W-runtime", "--title", "Retire runtime", "--coordinator", "coordinator@demo", "--assignee", "driver.runtime@demo", "--done-when", "Delivery branch is merged.");
  await ok(site, "task", "start", "demo", "W-runtime", "--by", "driver.runtime@demo");
  await ok(site, "task", "prove", "demo", "W-runtime", "--by", "driver.runtime@demo", "--item", "1", "--proof", "main already contains delivery/runtime");
  await ok(site, "task", "review", "demo", "W-runtime", "--by", "driver.runtime@demo");
  const retire = () => run(site, "task", "done", "demo", "W-runtime", "--by", "coordinator@demo", "--retire-assignee");
  return { site, repository, target, globalMarker, primaryMarker, pinnedMarker, retire, ok };
}

test("retirement runs the target worktree's pinned consumer bin, not the primary decoy or the global binary", async () => {
  const { target, globalMarker, primaryMarker, pinnedMarker, retire, ok, site } = await fixture({ kind: "consumer" });
  const result = await retire();
  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(globalMarker)).toBe(false);
  expect(existsSync(primaryMarker)).toBe(false);
  expect(await readFile(pinnedMarker, "utf8")).toContain("pinned worktree finish");
  expect(await ok(site, "open", "driver.runtime@demo")).toContain("retired:");
  expect(existsSync(target)).toBe(true);
});

test("retirement of an atdd-bun source checkout runs the target worktree's own bun src/cli.ts", async () => {
  const { globalMarker, primaryMarker, pinnedMarker, retire, ok, site } = await fixture({ kind: "source" });
  const result = await retire();
  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(globalMarker)).toBe(false);
  expect(await readFile(pinnedMarker, "utf8")).toContain("source worktree finish");
  expect(existsSync(primaryMarker)).toBe(false);
  expect(await ok(site, "open", "driver.runtime@demo")).toContain("retired:");
});

test("a global toolkit that rejects cannot judge retirement when the target pin is valid", async () => {
  const { globalMarker, pinnedMarker, retire, ok, site } = await fixture({ kind: "consumer", globalExits: 1 });
  const result = await retire();
  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(globalMarker)).toBe(false);
  expect(await readFile(pinnedMarker, "utf8")).toContain("pinned");
  expect(await ok(site, "open", "driver.runtime@demo")).not.toContain("refused");
});

const failClosed: Array<[string, Layout]> = [
  ["consumer worktree without node_modules (primary decoy present)", { kind: "consumer", omit: "node_modules" }],
  ["consumer worktree without .bin/atdd-bun", { kind: "consumer", omit: "bin" }],
  ["consumer bin escaping the installed package", { kind: "consumer", omit: "bin-escape" }],
  ["consumer without installed conventions", { kind: "consumer", omit: "conventions" }],
  ["consumer installed version differs from the exact pin", { kind: "consumer", declared: "0.10.0", installed: "0.10.1" }],
  ["consumer installed version outside the declared range", { kind: "consumer", declared: "^0.10.0", installed: "0.9.5" }],
  ["consumer with unreadable package.json", { kind: "consumer", omit: "manifest" }],
  ["source worktree without src/cli.ts", { kind: "source", omit: "cli" }],
  ["source worktree without conventions", { kind: "source", omit: "conventions" }],
  ["source worktree with unreadable package.json", { kind: "source", omit: "manifest" }],
];

for (const [name, layout] of failClosed) {
  test(`retirement fails closed without mutation, global fallback, or merge-proof degradation: ${name}`, async () => {
    const { target, repository, globalMarker, primaryMarker, pinnedMarker, retire, ok, site } = await fixture(layout);
    const branchesBefore = await git(repository, "branch", "--list", "delivery/runtime");
    const headBefore = await git(target, "rev-parse", "HEAD");
    const result = await retire();
    expect(existsSync(globalMarker)).toBe(false);
    expect(existsSync(primaryMarker)).toBe(false);
    expect(existsSync(pinnedMarker)).toBe(false);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/pinned ATDD Bun/i);
    expect(await ok(site, "open", "driver.runtime@demo")).not.toContain("retired:");
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await git(repository, "branch", "--list", "delivery/runtime")).toBe(branchesBefore);
    expect(await git(target, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(target, "status", "--porcelain")).toBe("");
  });
}
