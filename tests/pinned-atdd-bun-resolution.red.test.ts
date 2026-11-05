// URN: test:flow:pinned-atdd-bun-resolution:E024-UNIT-001
// Acceptance: acc:flow:E024-UNIT-001
// Phase: UNIT
// Layer: integration
// RED: Flow-invoked ATDD Bun checks must use the toolkit pinned by the explicit target worktree,
// never the global PATH binary, and must fail closed without mutation when the pin cannot be established.
// Plan: plans/pinned-atdd-bun-resolution.md (task flow-invoked-pinned-atdd-bun-resolution-20261104).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const conventionPath = "conventions/atdd-bun.review/atdd-bun.review.behavioral-reconciliation.convention.yaml";
const originalPath = process.env.PATH;
const scratch: string[] = [];

beforeEach(() => { scratch.length = 0; });
afterEach(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

type Kind = "consumer" | "source";
interface Options {
  kind: Kind;
  declared?: string;
  installed?: string;
  omit?: "node_modules" | "bin" | "conventions" | "cli" | "manifest" | "bin-escape";
}

/** A tmp Desk plus a committed, clean delivery worktree and a sentinel global `atdd-bun` first on PATH. */
async function fixture(options: Options) {
  const base = await mkdtemp(join(tmpdir(), "atdd-flow-pinned-"));
  scratch.push(base);
  const desk = join(base, "desk");
  const worktree = join(base, "delivery");
  const globalBin = join(base, "global-bin");
  const globalMarker = join(base, "global-ran");
  await mkdir(globalBin, { recursive: true });
  await writeFile(join(globalBin, "atdd-bun"), `#!/bin/sh\necho ran >> "${globalMarker}"\necho "global 0.99.0 verdict"\n`);
  await chmod(join(globalBin, "atdd-bun"), 0o755);

  await git(base, "init", "-b", "main", worktree);
  await git(worktree, "config", "user.email", "test@example.test");
  await git(worktree, "config", "user.name", "Test");
  await writeFile(join(worktree, ".gitignore"), "node_modules\n.pinned-ran\n");
  await writeFile(join(worktree, "atdd-bun.yaml"), "profiles: [workflow]\n");
  const installed = options.installed ?? "0.10.0";
  const pinnedMarker = join(worktree, ".pinned-ran");
  const conventionBody = "rule: atdd-bun.review.behavioral-reconciliation\n";

  if (options.kind === "source") {
    if (options.omit !== "manifest") {
      await writeFile(join(worktree, "package.json"), JSON.stringify({ name: "@afokapu/atdd-bun", version: installed }));
    } else {
      await writeFile(join(worktree, "package.json"), "{ not json");
    }
    if (options.omit !== "cli") {
      await mkdir(join(worktree, "src"), { recursive: true });
      await writeFile(join(worktree, "src", "cli.ts"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(pinnedMarker)}, "source\\n");\nconsole.log("source ${installed} PASS");\n`);
    }
    if (options.omit !== "conventions") {
      await mkdir(join(worktree, "conventions", "atdd-bun.review"), { recursive: true });
      await writeFile(join(worktree, conventionPath), conventionBody);
    }
  } else {
    const manifest = options.omit === "manifest"
      ? "{ not json"
      : JSON.stringify({ name: "consumer", devDependencies: { "@afokapu/atdd-bun": options.declared ?? "0.10.0" } });
    await writeFile(join(worktree, "package.json"), manifest);
    if (options.omit !== "node_modules") {
      const pkg = join(worktree, "node_modules", "@afokapu", "atdd-bun");
      await mkdir(join(worktree, "node_modules", ".bin"), { recursive: true });
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@afokapu/atdd-bun", version: installed }));
      if (options.omit !== "conventions") {
        await mkdir(join(pkg, "conventions", "atdd-bun.review"), { recursive: true });
        await writeFile(join(pkg, conventionPath), conventionBody);
      }
      const binTarget = options.omit === "bin-escape" ? join(base, "elsewhere-atdd-bun") : join(pkg, "cli.sh");
      await writeFile(binTarget, `#!/bin/sh\necho pinned >> "${pinnedMarker}"\necho "pinned ${installed} PASS"\n`);
      await chmod(binTarget, 0o755);
      if (options.omit !== "bin") await symlink(binTarget, join(worktree, "node_modules", ".bin", "atdd-bun"));
    }
  }
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-m", "delivery");

  await mkdir(join(desk, "work", "demo", "seats", "driver.delivery"), { recursive: true });
  await mkdir(join(desk, "work", "demo", "tasks"), { recursive: true });
  await writeFile(join(desk, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await writeFile(join(desk, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
repository: ${worktree}
roles:
  driver:
    address: driver.{name}@{project}
    branch: delivery/{name}
    base: main
`);
  await writeFile(join(desk, "work", "demo", "seats", "driver.delivery", "seat.yaml"), `schema: atdd-workflow/seat/v2
address: driver.delivery@demo
role: driver
project: demo
worktree: ${worktree}
branch: main
`);
  await writeFile(join(desk, "work", "demo", "tasks", "delivery.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/task/v1",
    title: "Deliver behavior",
    status: "review",
    coordinator: "coordinator@demo",
    assignee: "driver.delivery@demo",
    done_when: [{ text: "Behavior works", proof: "CI run 42" }],
  }));
  return { base, desk, worktree, globalMarker, pinnedMarker, globalBin };
}

/** Relative path -> kind/size/content for every entry, excluding .git and the marker the pinned fake writes. */
async function snapshot(directory: string, ignore: string[] = [".git", ".pinned-ran"]) {
  const out: Record<string, string> = {};
  async function walk(current: string, prefix: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (ignore.includes(entry.name)) continue;
      const full = join(current, entry.name);
      const key = join(prefix, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) out[key] = `link:${await readFile(full, "utf8").catch(() => "dangling")}`;
      else if (info.isDirectory()) { out[key] = "dir"; await walk(full, key); }
      else out[key] = `file:${await readFile(full, "utf8")}`;
    }
  }
  await walk(directory, "");
  return out;
}

/** Bun resolves child executables against its start-up PATH, so the sentinel shim is installed via the child's env. */
async function launch(desk: string): Promise<{ name: string; message: string } | undefined> {
  const globalBin = join(desk, "..", "global-bin");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "launch-review.child.ts"), desk], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, PATH: `${globalBin}:${originalPath}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let result: { ok: boolean; name?: string; message?: string };
  try { result = JSON.parse(line); } catch { throw new Error(`launcher child produced no result: ${stdout} ${stderr}`); }
  return result.ok ? undefined : { name: result.name!, message: result.message! };
}

test("consumer launch runs the target worktree's pinned bin and never the global PATH binary", async () => {
  const { desk, globalMarker, pinnedMarker } = await fixture({ kind: "consumer" });
  const error = await launch(desk);
  expect(existsSync(globalMarker)).toBe(false);
  expect(await readFile(pinnedMarker, "utf8")).toContain("pinned");
  expect(error?.message ?? "").not.toContain("Deterministic ATDD Bun gates are red");
  expect(error?.message ?? "").not.toContain("Installed ATDD Bun does not provide");
});

test("atdd-bun source checkout runs its own bun src/cli.ts and reads its own conventions without a self-dependency", async () => {
  const { desk, worktree, globalMarker, pinnedMarker } = await fixture({ kind: "source" });
  expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  const error = await launch(desk);
  expect(existsSync(globalMarker)).toBe(false);
  expect(await readFile(pinnedMarker, "utf8")).toContain("source");
  expect(error?.message ?? "").not.toContain("Installed ATDD Bun does not provide");
});

test("a global toolkit that disagrees with the pin cannot judge the project", async () => {
  const { desk, base, globalMarker } = await fixture({ kind: "consumer" });
  await writeFile(join(base, "global-bin", "atdd-bun"), `#!/bin/sh\necho ran >> "${globalMarker}"\necho "global rejects generated surface" >&2\nexit 1\n`);
  const error = await launch(desk);
  expect(existsSync(globalMarker)).toBe(false);
  expect(error?.message ?? "").not.toContain("global rejects generated surface");
});

const failClosed: Array<[string, Options, RegExp]> = [
  ["consumer without node_modules", { kind: "consumer", omit: "node_modules" }, /pinned.*(install|toolkit)|node_modules/i],
  ["consumer without .bin/atdd-bun", { kind: "consumer", omit: "bin" }, /\.bin|atdd-bun/i],
  ["consumer whose bin escapes the installed package", { kind: "consumer", omit: "bin-escape" }, /escape|outside|belong|package/i],
  ["consumer without installed conventions", { kind: "consumer", omit: "conventions" }, /convention/i],
  ["consumer installed version differs from the exact pin", { kind: "consumer", declared: "0.10.0", installed: "0.10.1" }, /0\.10\.0.*0\.10\.1|pin|version/i],
  ["consumer installed version outside the declared range", { kind: "consumer", declared: "^0.10.0", installed: "0.9.5" }, /range|satisf|version/i],
  ["consumer with unreadable package.json", { kind: "consumer", omit: "manifest" }, /package\.json/i],
  ["source checkout without src/cli.ts", { kind: "source", omit: "cli" }, /cli\.ts/i],
  ["source checkout without conventions", { kind: "source", omit: "conventions" }, /convention/i],
  ["source checkout with unreadable package.json", { kind: "source", omit: "manifest" }, /package\.json/i],
];

for (const [name, options, message] of failClosed) {
  test(`fails closed without mutation or global fallback: ${name}`, async () => {
    const { desk, worktree, globalMarker, pinnedMarker } = await fixture(options);
    const before = await snapshot(worktree);
    const error = await launch(desk);
    expect(existsSync(globalMarker)).toBe(false);
    expect(existsSync(pinnedMarker)).toBe(false);
    expect(await snapshot(worktree)).toEqual(before);
    expect(error).toBeDefined();
    expect(error!.name).toBe("PinnedToolkitError");
    expect(error!.message).toMatch(message);
  });
}

test("a consumer declaring a satisfied range resolves without literal version equality", async () => {
  const { desk, globalMarker, pinnedMarker } = await fixture({ kind: "consumer", declared: "^0.10.0", installed: "0.10.7" });
  const error = await launch(desk);
  expect(existsSync(globalMarker)).toBe(false);
  expect(await readFile(pinnedMarker, "utf8")).toContain("pinned");
  expect(error?.name).not.toBe("PinnedToolkitError");
});

test("the resolver is explicit-root only: no parent or primary-checkout fallback", async () => {
  const { resolvePinnedToolkit } = await import("../src/pinned-toolkit");
  const { worktree } = await fixture({ kind: "consumer" });
  const nested = join(worktree, "packages", "inner");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "package.json"), JSON.stringify({ name: "inner" }));
  await expect(resolvePinnedToolkit(nested)).rejects.toMatchObject({ name: "PinnedToolkitError" });
  const resolved = await resolvePinnedToolkit(worktree);
  expect(resolved.kind).toBe("consumer");
  expect(resolved.command[0]!.startsWith(join(worktree, "node_modules"))).toBe(true);
  expect(resolved.conventionsRoot.startsWith(worktree)).toBe(true);
});

test("source resolution is explicit and PATH-free", async () => {
  const { resolvePinnedToolkit } = await import("../src/pinned-toolkit");
  const { worktree } = await fixture({ kind: "source" });
  const resolved = await resolvePinnedToolkit(worktree);
  expect(resolved.kind).toBe("source");
  expect(resolved.command).toEqual([process.execPath, join(worktree, "src", "cli.ts")]);
  expect(resolved.conventionsRoot).toBe(worktree);
});

test("no Flow source launches ATDD Bun through PATH", async () => {
  const hits: string[] = [];
  for (const file of new Bun.Glob("src/**/*.ts").scanSync(".")) {
    const text = await readFile(file, "utf8");
    if (file.endsWith("pinned-toolkit.ts")) continue;
    if (/Bun\.which\(\s*["']atdd-bun["']/.test(text) || /runOutput\(\s*\[\s*["']atdd-bun["']/.test(text)) hits.push(file);
  }
  expect(hits).toEqual([]);
});
