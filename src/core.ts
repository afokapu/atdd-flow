import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type Role = { address: string; branch: string; agent: string; purpose?: string; worktree?: string; base?: string };
export type Group = { role?: string; members?: string[] };
export type Scope = { purpose: string; coordinator: string; umbrella_branch?: string; legacy_aliases?: string[] };
export type Site = { schema: string; site: string; application: string; aliases?: Record<string, string> };
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
export type Runtime = { application: string; addresses: Record<string, string>; attached_at?: string };
export type Seat = {
  schema: string;
  address: string;
  role: string;
  project: string;
  worktree: string;
  branch: string;
  agent: string;
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
export const id = (prefix: "T" | "M") => `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
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
export const yaml = {
  parse: <T>(text: string) => Bun.YAML.parse(text) as T,
  print: (value: unknown) => Bun.YAML.stringify(value),
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
  site: join(root, "coordination.yaml"),
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
  tasks: (project: string) => join(root, "work", project, "tasks"),
  taskFile: (project: string, task: string) => join(root, "work", project, "tasks", `${taskId(task)}.yaml`),
  threads: join(root, "threads"),
  thread: (threadId: string) => join(root, "threads", threadId),
  threadFile: (threadId: string) => join(root, "threads", threadId, "thread.yaml"),
  message: (threadId: string, messageId: string) => join(root, "threads", threadId, `${messageId}.yaml`),
});

export async function atomicYaml(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  await writeFile(temp, yaml.print(value), "utf8");
  await rename(temp, file);
}

export async function readYaml<T>(file: string): Promise<T> {
  return yaml.parse<T>(await readFile(file, "utf8"));
}

export async function exists(path: string) {
  try { await stat(path); return true; }
  catch { return false; }
}

export async function site(root: string) {
  const value = await readYaml<Site>(paths(root).site);
  if (value.schema !== "atdd-workflow/coordination/v2") throw new Error("Unsupported coordination schema.");
  return value;
}

export async function project(root: string, name: string) {
  const value = await readYaml<Project>(paths(root).projectFile(name));
  if (value.schema !== "atdd-workflow/project/v1") throw new Error("Unsupported project schema.");
  return value;
}

export async function canonicalAddress(root: string, address: string) {
  const aliases = (await site(root)).aliases ?? {};
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

async function execute(command: string[], cwd?: string) {
  const result = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
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
