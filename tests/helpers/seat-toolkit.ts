// URN: component:flow:e024:seat-toolkit:backend:integration
// Tested-By:
// - test:flow:pinned-atdd-bun-retirement:E024-UNIT-001
// Runtime: bun
// Purpose: Test fixture helper that pins ATDD Bun inside an isolated seat worktree.

// Test helper: gives a linked seat worktree the project-pinned ATDD Bun that Flow's retirement/review paths now require.
// The pin lives in the (gitignored) node_modules of the exact worktree being checked, never the primary checkout.
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const toolkit = join(import.meta.dir, "..", "..", "node_modules", "@afokapu", "atdd-bun");

export async function pinnedVersion() {
  return JSON.parse(await readFile(join(toolkit, "package.json"), "utf8")).version as string;
}

/** Writes the consumer package.json that declares the pin; the caller must commit it before spawning worktrees. */
export async function declarePin(repository: string) {
  await writeFile(join(repository, "package.json"), JSON.stringify({ name: "consumer", devDependencies: { "@afokapu/atdd-bun": await pinnedVersion() } }));
  return "package.json";
}

/** Installs the real toolkit (package + bin) into the worktree's node_modules. */
export async function pinSeatWorktree(worktree: string) {
  const modules = join(worktree, "node_modules");
  await mkdir(join(modules, ".bin"), { recursive: true });
  await mkdir(join(modules, "@afokapu"), { recursive: true });
  await symlink(toolkit, join(modules, "@afokapu", "atdd-bun"));
  await symlink(await realpath(join(toolkit, "..", "..", ".bin", "atdd-bun")), join(modules, ".bin", "atdd-bun"));
}

/** Installs a package-owned bin script (`body` is its shell text) so the resolver's "bin belongs to package" check holds. */
export async function pinWithScript(worktree: string, body: string) {
  const pkg = join(worktree, "node_modules", "@afokapu", "atdd-bun");
  // Replace any earlier pin; removing a symlink never touches its target.
  await rm(pkg, { recursive: true, force: true });
  await rm(join(worktree, "node_modules", ".bin", "atdd-bun"), { force: true });
  await mkdir(join(pkg, "conventions"), { recursive: true });
  await mkdir(join(worktree, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@afokapu/atdd-bun", version: await pinnedVersion() }));
  await writeFile(join(pkg, "conventions", "README.md"), "conventions\n");
  const script = join(pkg, "atdd-bun.sh");
  await writeFile(script, body);
  await chmod(script, 0o755);
  await symlink(script, join(worktree, "node_modules", ".bin", "atdd-bun"));
}

/** A pinned bin that logs `<label> <cwd>` and delegates to the real ATDD Bun. */
export const loggingScript = (label: string, log: string, realBun: string, execPath: string) =>
  `#!/bin/sh\nprintf '%s %s\\n' '${label}' "$(pwd -P)" >> '${log}'\nexec '${execPath}' '${realBun}' "$@"\n`;

/** A pinned bin that refuses `worktree finish` the way the observed post-JJ and squash-merged failures do. */
export const refusingScript = "#!/bin/sh\necho 'atdd-bun: unknown profile delivery; no exported bookmark found 0' >&2\nexit 1\n";
