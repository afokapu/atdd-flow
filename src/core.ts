import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Document, Scalar, parse as parseYaml, stringify as stringifyYaml, visit } from "yaml";

export type Role = { address: string; branch: string; agent?: string; purpose?: string; worktree?: string; base?: string };
export type Group = { role?: string; members?: string[] };
export type Scope = { purpose: string; coordinator: string; umbrella_branch?: string; legacy_aliases?: string[] };
/**
 * The Desk is the durable registry for a workflow: projects, seats, tasks,
 * threads, and their handoff records all resolve from this root.
 */
export type Desk = {
  schema: "atdd-workflow/desk/v1";
  desk: string;
  application: string;
  /** Native Herdr session used for Desk notifications when application is herdr. */
  herdr_session?: string;
  /** Optional multiplexer housekeeping; inactive driver workspaces are closed only when enabled. */
  multiplexer?: { close_inactive?: boolean };
  /** Context percentage at which Pi asks its seat to prepare a durable replacement handover. */
  context_handover?: { threshold_percent?: number };
  /** Named commands that model portfolio entries may resolve through. */
  executables?: Record<string, string>;
  aliases?: Record<string, string>;
  /** Model id used for a role when launch model selection falls back; unlisted roles use the strongest candidate. */
  fallback_model?: Record<string, string>;
};
export type ModelCandidate = {
  id: string;
  executable: string;
  args?: string[];
  description?: string;
  enabled?: boolean;
};
export type ModelPortfolio = {
  schema: "atdd-workflow/models/v1";
  /** Ordered strongest to weakest. Workflow prefers the weakest sufficient enabled candidate. */
  models: ModelCandidate[];
};
type LegacyCoordination = { schema: "atdd-workflow/coordination/v2"; site: string; application: string; aliases?: Record<string, string> };
export type Project = {
  schema: string;
  project: string;
  repository?: string;
  worktree_root?: string;
  roles: Record<string, Role>;
  groups?: Record<string, Group>;
  scopes?: Record<string, Scope>;
};
/**
 * A seat can be reachable through more than one live application. Addresses
 * are opaque application-owned locators: Workflow records and returns them,
 * while the relevant bridge is responsible for using their native format.
 */
/** `native` means the agent runtime wakes itself from the durable Desk. */
export type HerdrLocator = { session: string; pane: string };
/** Strings are legacy native addresses; new Herdr bindings retain their session. */
export type RuntimeAddress = string | HerdrLocator;
export type Runtime = {
  application: string;
  addresses: Record<string, RuntimeAddress>;
  attached_at?: string;
  model?: string;
  wake?: "host" | "native";
  /** Exact Pi session used by the narrow Pi/Herdr launch command. */
  pi_session?: string;
  /** Exact durable JSONL path reported by Herdr for that Pi session. */
  pi_session_path?: string;
  /** Immutable, non-secret receipt for that selected launch. */
  launch_receipt?: string;
};

export function runtimeAddress(application: string, value: RuntimeAddress, legacyHerdrSession?: string) {
  if (application !== "herdr" || typeof value === "string") return { address: value, ...(application === "herdr" && legacyHerdrSession ? { session: legacyHerdrSession } : {}) };
  return { address: value.pane, session: value.session };
}
export type Seat = {
  schema: string;
  address: string;
  role: string;
  project: string;
  worktree: string;
  branch: string;
  /** Legacy pinned launch executable. New seats leave model choice to Jev through models.yaml. */
  agent?: string;
  purpose?: string;
  runtime?: Runtime;
  retired?: { task: string; completed_at: string; summary: string };
};
export type Checkpoint = {
  schema: string;
  seat: string;
  status: "active" | "standby" | "blocked" | "complete" | "unverified";
  updated_at: string;
  summary: string;
  next_action: string;
  references?: string[];
};

export const now = () => new Date().toISOString();

/** Converts human input into the stable, filesystem-safe part of a durable ID. */
export function kebabCase(value: string, fallback: string) {
  const slug = value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function utcSecond(value: Date) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * New thread/message IDs are readable without sacrificing independent-process
 * allocation: UUID entropy keeps simultaneous same-second allocations distinct.
 * Review IDs retain their established format because this migration is T/M-only.
 */
export const id = (prefix: "T" | "M" | "R", label?: string, timestamp = new Date()) => {
  if (prefix === "R") return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const fallback = prefix === "T" ? "thread" : "message";
  return `${prefix}-${utcSecond(timestamp)}-${kebabCase(label ?? fallback, fallback)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
};
export const words = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
export const values = (args: string[], flag: string) => args.flatMap((value, index) => value === flag && args[index + 1] ? [args[index + 1]] : []);
export const has = (args: string[], flag: string) => args.includes(flag);
export const required = <T>(value: T | undefined, label: string) => {
  if (value === undefined || value === "") throw new Error(`Missing ${label}.`);
  return value;
};
const printOptions = { collectionStyle: "flow", flowCollectionPadding: false } as const;

// What a faithful YAML round trip must return: JSON semantics, but never silently lossy.
function expectedRoundTrip(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => {
    if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") throw new Error("Value is not representable in YAML.");
    if (typeof entry === "number" && !Number.isFinite(entry)) throw new Error("Value is not representable in YAML.");
    return entry;
  }));
}

// Tier 2 keeps multi-line text readable as block literals; tier 3 quotes every string.
const printTiers: Array<(expected: unknown) => string> = [
  (expected) => stringifyYaml(expected, printOptions),
  (expected) => {
    const document = new Document(expected, { ...printOptions, lineWidth: 0 });
    visit(document, { Scalar: (_key, node) => { if (typeof node.value === "string" && node.value.includes("\n")) node.type = Scalar.BLOCK_LITERAL; } });
    return document.toString();
  },
  (expected) => stringifyYaml(expected, { ...printOptions, lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }),
];

// A parse error and a value mismatch are equally unsafe to publish, so both count as "does not round-trip".
// Strict deep equality also catches silent coercions such as the string "null" becoming null.
function roundTrips(text: string, expected: unknown) {
  try { return isDeepStrictEqual(parseYaml(text), expected); }
  catch { return false; }
}

/** Serializes and proves the text parses back to the same value; the first tier that does wins, otherwise fail closed. */
function printVerified(value: unknown) {
  const expected = expectedRoundTrip(value);
  for (const tier of printTiers) {
    const text = tier(expected);
    if (roundTrips(text, expected)) return text;
  }
  throw new Error("Refusing to write YAML that does not parse back to the original value.");
}

export const yaml = {
  parse: <T>(text: string) => parseYaml(text) as T,
  print: (value: unknown) => printVerified(value),
};

export function addressParts(address: string) {
  const marker = address.lastIndexOf("@");
  if (marker < 1 || marker === address.length - 1) throw new Error(`Address must use local@project form: ${address}`);
  return { local: address.slice(0, marker), project: address.slice(marker + 1) };
}

export function taskId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`Task id must contain only letters, numbers, dots, underscores, or hyphens: ${value}`);
  return value;
}

export const paths = (root: string) => ({
  desk: join(root, "desk.yaml"),
  models: join(root, "models.yaml"),
  legacyCoordination: join(root, "coordination.yaml"),
  work: join(root, "work"),
  project: (name: string) => join(root, "work", name),
  projectFile: (name: string) => join(root, "work", name, "project.yaml"),
  seats: (name: string) => join(root, "work", name, "seats"),
  seat: (address: string) => {
    const entry = addressParts(address);
    return join(root, "work", entry.project, "seats", entry.local);
  },
  seatFile: (address: string) => join(paths(root).seat(address), "seat.yaml"),
  checkpointFile: (address: string) => join(paths(root).seat(address), "checkpoint.yaml"),
  handoverFile: (address: string) => join(paths(root).seat(address), "handover.yaml"),
  tasks: (project: string) => join(root, "work", project, "tasks"),
  taskFile: (project: string, task: string) => join(root, "work", project, "tasks", `${taskId(task)}.yaml`),
  behavioralReviewFile: (project: string, task: string) => join(root, "work", project, "tasks", `${taskId(task)}.reviews.yaml`),
  threads: join(root, "threads"),
  thread: (threadId: string) => join(root, "threads", threadId),
  threadFile: (threadId: string) => join(root, "threads", threadId, "thread.yaml"),
  message: (threadId: string, messageId: string) => join(root, "threads", threadId, `${messageId}.yaml`),
});

export async function atomicYaml(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  const text = yaml.print(value);
  await writeFile(temp, text, "utf8");
  // yaml.print already proved this text round-trips; compare the bytes on disk to it before the rename publishes them.
  if ((await readFile(temp, "utf8")) !== text) {
    await rm(temp, { force: true });
    throw new Error(`Refusing to publish ${file}: written YAML does not round-trip.`);
  }
  await rename(temp, file);
}

export async function readYaml<T>(file: string): Promise<T> {
  return yaml.parse<T>(await readFile(file, "utf8"));
}

export async function exists(path: string) {
  try { await stat(path); return true; }
  catch { return false; }
}

export async function desk(root: string): Promise<Desk> {
  const files = paths(root);
  if (await exists(files.desk)) {
    const value = await readYaml<Desk>(files.desk);
    if (value.schema !== "atdd-workflow/desk/v1") throw new Error("Unsupported Desk schema.");
    return value;
  }
  if (await exists(files.legacyCoordination)) {
    const legacy = await readYaml<LegacyCoordination>(files.legacyCoordination);
    if (legacy.schema !== "atdd-workflow/coordination/v2") throw new Error("Unsupported legacy coordination schema.");
    return { schema: "atdd-workflow/desk/v1", desk: legacy.site, application: legacy.application, ...(legacy.aliases ? { aliases: legacy.aliases } : {}) };
  }
  throw new Error("Desk registry not found. Expected desk.yaml (or legacy coordination.yaml).");
}

export async function migrateDesk(root: string) {
  const files = paths(root);
  if (await exists(files.desk)) return false;
  const record = await desk(root);
  await atomicYaml(files.desk, record);
  return true;
}

export async function modelPortfolio(root: string): Promise<ModelPortfolio | undefined> {
  const file = paths(root).models;
  if (!await exists(file)) return undefined;
  const value = await readYaml<ModelPortfolio>(file);
  if (value.schema !== "atdd-workflow/models/v1") throw new Error("Unsupported model portfolio schema.");
  if (!Array.isArray(value.models) || !value.models.length) throw new Error("models.yaml must declare at least one model.");
  const ids = new Set<string>();
  for (const model of value.models) {
    if (!model.id?.trim() || !model.executable?.trim()) throw new Error("Every model requires id and executable.");
    if (ids.has(model.id)) throw new Error(`Duplicate model id in models.yaml: ${model.id}`);
    ids.add(model.id);
  }
  return value;
}

export async function project(root: string, name: string) {
  const value = await readYaml<Project>(paths(root).projectFile(name));
  if (value.schema !== "atdd-workflow/project/v1") throw new Error("Unsupported project schema.");
  return value;
}

export async function canonicalAddress(root: string, address: string) {
  const aliases = (await desk(root)).aliases ?? {};
  const visited = new Set<string>();
  let resolved = address;
  while (aliases[resolved]) {
    if (visited.has(resolved)) throw new Error(`Address alias cycle: ${address}`);
    visited.add(resolved);
    resolved = aliases[resolved];
  }
  addressParts(resolved);
  return resolved;
}

export async function seat(root: string, address: string) {
  return readYaml<Seat>(paths(root).seatFile(await canonicalAddress(root, address)));
}

export function fill(template: string, entries: Record<string, string>) {
  return template.replace(/\{(project|name|worktree_root|repository)\}/g, (_, key) => entries[key]);
}

function executable(command: string, cwd?: string) {
  if (!cwd || command.includes("/")) return command;
  const local = join(cwd, "node_modules", ".bin", command);
  return existsSync(local) ? local : command;
}

async function execute(command: string[], cwd?: string) {
  const result = Bun.spawn([executable(command[0]!, cwd), ...command.slice(1)], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${stderr.trim() || stdout.trim()}`);
  return stdout;
}

export async function runOutput(command: string[], cwd?: string) {
  return (await execute(command, cwd)).trim();
}

export async function run(command: string[], quiet = false, cwd?: string) {
  const stdout = await execute(command, cwd);
  if (!quiet && stdout.trim()) process.stdout.write(stdout);
}

export const rootFromCwd = () => resolve(process.cwd());
