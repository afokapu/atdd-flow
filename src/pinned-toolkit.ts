import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const packageName = "@afokapu/atdd-bun";

export interface PinnedToolkit {
  /** `source`: the ATDD Bun checkout itself. `consumer`: a project that depends on the published package. */
  kind: "consumer" | "source";
  root: string;
  /** Absolute command prefix; never a bare PATH lookup. */
  command: string[];
  /** Directory that owns `conventions/` for this toolkit. */
  conventionsRoot: string;
  version: string;
}

export class PinnedToolkitError extends Error {
  override name = "PinnedToolkitError";
  constructor(root: string, reason: string) {
    super(`Pinned ATDD Bun unavailable for ${root}: ${reason}`);
  }
}

interface Manifest {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

async function manifest(root: string, file: string): Promise<Manifest> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { throw new PinnedToolkitError(root, `${file} is missing or not valid JSON (${(error as Error).message}).`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PinnedToolkitError(root, `${file} is not a package.json object.`);
  return parsed as Manifest;
}

function isDirectory(path: string) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function versionOf(root: string, file: string, parsed: Manifest) {
  if (typeof parsed.version !== "string" || !parsed.version) throw new PinnedToolkitError(root, `${file} declares no version.`);
  return parsed.version;
}

function contained(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function resolveSource(root: string, manifestFile: string, project: Manifest): PinnedToolkit {
  const cli = join(root, "src", "cli.ts");
  if (!existsSync(cli)) throw new PinnedToolkitError(root, `ATDD Bun source checkout has no ${cli}.`);
  if (!isDirectory(join(root, "conventions"))) throw new PinnedToolkitError(root, `ATDD Bun source checkout has no conventions/ directory.`);
  return { kind: "source", root, command: [process.execPath, cli], conventionsRoot: root, version: versionOf(root, manifestFile, project) };
}

function realPaths(root: string, bin: string, packageRoot: string) {
  try { return { realBin: realpathSync(bin), realPackage: realpathSync(packageRoot) }; }
  catch (error) { throw new PinnedToolkitError(root, `cannot resolve the installed bin or package (${(error as Error).message}).`); }
}

async function installedVersion(root: string, packageRoot: string, declared: string) {
  const file = join(packageRoot, "package.json");
  if (!existsSync(file)) {
    throw new PinnedToolkitError(root, `${packageRoot} is not installed (node_modules missing); install the pinned toolkit before running Flow checks.`);
  }
  const installed = versionOf(root, file, await manifest(root, file));
  if (!Bun.semver.satisfies(installed, declared)) {
    throw new PinnedToolkitError(root, `declared ${declared} but installed ${installed} does not satisfy it (version/range mismatch); reinstall the pinned toolkit.`);
  }
  return installed;
}

async function resolveConsumer(root: string, manifestFile: string, project: Manifest): Promise<PinnedToolkit> {
  const declared = project.devDependencies?.[packageName] ?? project.dependencies?.[packageName] ?? project.optionalDependencies?.[packageName];
  if (typeof declared !== "string") throw new PinnedToolkitError(root, `${manifestFile} does not declare ${packageName}; pin it in dependencies or devDependencies.`);
  const packageRoot = join(root, "node_modules", "@afokapu", "atdd-bun");
  const bin = join(root, "node_modules", ".bin", "atdd-bun");
  const version = await installedVersion(root, packageRoot, declared);
  if (!existsSync(bin)) throw new PinnedToolkitError(root, `${bin} is missing; install the pinned toolkit (node_modules/.bin/atdd-bun).`);
  const { realBin, realPackage } = realPaths(root, bin, packageRoot);
  if (!contained(realPackage, realBin)) {
    throw new PinnedToolkitError(root, `${bin} resolves outside the installed ${packageName} package (${realBin}); the bin must belong to the package whose conventions are used.`);
  }
  if (!isDirectory(join(packageRoot, "conventions"))) throw new PinnedToolkitError(root, `installed ${packageName} ${version} has no conventions/ directory.`);
  return { kind: "consumer", root, command: [bin], conventionsRoot: packageRoot, version };
}

/**
 * Resolves the ATDD Bun that Flow must invoke for one explicit project worktree.
 *
 * The decision is made only from `root`: PATH, the primary checkout, parent directories and the process
 * environment are never consulted, and nothing is installed, generated or written. Any mismatch throws
 * {@link PinnedToolkitError}; callers must not catch it to fall back to another toolkit.
 */
export async function resolvePinnedToolkit(projectRoot: string): Promise<PinnedToolkit> {
  const root = resolve(projectRoot);
  const manifestFile = join(root, "package.json");
  const project = await manifest(root, manifestFile);
  return project.name === packageName ? resolveSource(root, manifestFile, project) : resolveConsumer(root, manifestFile, project);
}
