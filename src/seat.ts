#!/usr/bin/env bun

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

type Backend = "tmux" | "herdr" | "tuios";
type Role = { address: string; branch: string; agent: string; purpose?: string; worktree?: string; base?: string };
type Group = { role?: string; members?: string[] };
type Site = { schema: string; site: string; backend: Backend };
type Project = {
  schema: string;
  project: string;
  repository?: string;
  worktree_root?: string;
  roles: Record<string, Role>;
  groups?: Record<string, Group>;
};
type Runtime = { pane?: string; backend?: Backend; attached_at?: string };
type Seat = {
  schema: string;
  address: string;
  role: string;
  project: string;
  worktree: string;
  branch: string;
  agent: string;
  purpose?: string;
  runtime?: Runtime;
};
type Checkpoint = {
  schema: string;
  seat: string;
  status: "active" | "standby" | "blocked" | "complete";
  updated_at: string;
  summary: string;
  next_action: string;
  references?: string[];
};
type Thread = { schema: string; id: string; subject: string; participants: string[]; state: "open" | "closed"; summary?: string };
type Kind = "message" | "receipt" | "result";
type Message = {
  schema: string;
  id: string;
  from: string;
  to: "all" | string[];
  kind: Kind;
  in_reply_to?: string;
  expects_result?: boolean;
  created_at: string;
  body: string;
};

const usage = `atdd-seat — filesystem-first agent seats

Run commands from a site directory containing site.yaml.

Usage:
  seat init <site>
  seat project init <project>
  seat spawn <project> <role> <name> [--worktree <path>] [--branch <branch>]
  seat bind <address> --pane <target> [--backend tmux|herdr|tuios]
  seat describe <address> --purpose <one-line responsibility>
  seat checkpoint <address> --summary <text> --next <text> [--status active|standby|blocked|complete] [--references <value,...>]
  seat thread start --with <address,...> --subject <text>
  seat thread add <thread-id> <address>
  seat post <thread-id> --from <address> --to <all|address,...> --body <text> [--expects-result]
  seat receipt <thread-id> <message-id> --from <address> [--body <text>]
  seat result <thread-id> <message-id> --from <address> --body <text>
  seat status
  seat open <address>`;

const now = () => new Date().toISOString();
const id = (prefix: "T" | "M") => `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const words = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const has = (args: string[], flag: string) => args.includes(flag);
const required = <T>(value: T | undefined, label: string) => {
  if (value === undefined || value === "") throw new Error(`Missing ${label}.`);
  return value;
};
const yaml = {
  parse: <T>(text: string) => Bun.YAML.parse(text) as T,
  print: (value: unknown) => Bun.YAML.stringify(value),
};

function addressParts(address: string) {
  const marker = address.lastIndexOf("@");
  if (marker < 1 || marker === address.length - 1) throw new Error(`Address must use local@project form: ${address}`);
  return { local: address.slice(0, marker), project: address.slice(marker + 1) };
}

const paths = (root: string) => ({
  site: join(root, "site.yaml"),
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
  threads: join(root, "threads"),
  thread: (threadId: string) => join(root, "threads", threadId),
  threadFile: (threadId: string) => join(root, "threads", threadId, "thread.yaml"),
  message: (threadId: string, messageId: string) => join(root, "threads", threadId, `${messageId}.yaml`),
});

async function atomicYaml(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  await writeFile(temp, yaml.print(value), "utf8");
  await rename(temp, file);
}

async function readYaml<T>(file: string): Promise<T> {
  return yaml.parse<T>(await readFile(file, "utf8"));
}

async function site(root: string) {
  const value = await readYaml<Site>(paths(root).site);
  if (value.schema !== "atdd-seat/site/v1") throw new Error("Unsupported site schema.");
  return value;
}

async function project(root: string, name: string) {
  const value = await readYaml<Project>(paths(root).projectFile(name));
  if (value.schema !== "atdd-seat/project/v1") throw new Error("Unsupported project schema.");
  return value;
}

async function seat(root: string, address: string) {
  return readYaml<Seat>(paths(root).seatFile(address));
}

async function thread(root: string, threadId: string) {
  return readYaml<Thread>(paths(root).threadFile(threadId));
}

async function messages(root: string, threadId: string) {
  const folder = paths(root).thread(threadId);
  const files = (await readdir(folder)).filter((file) => file.startsWith("M-") && file.endsWith(".yaml")).sort();
  return Promise.all(files.map((file) => readYaml<Message>(join(folder, file))));
}

function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(project|name|worktree_root|repository)\}/g, (_, key) => values[key]);
}

async function seatsByRole(root: string, projectName: string, role: string) {
  const folder = paths(root).seats(projectName);
  const locals = await readdir(folder);
  const all = await Promise.all(locals.map((local) => seat(root, `${local}@${projectName}`)));
  return all.filter((entry) => entry.role === role).map((entry) => entry.address);
}

async function resolveRecipients(root: string, value: string, participants: string[]) {
  if (value === "all") return participants;
  const requested = value.split(",").filter(Boolean);
  const expanded = await Promise.all(requested.map(async (address) => {
    const { project: projectName } = addressParts(address);
    const config = await project(root, projectName);
    const group = config.groups?.[address];
    if (!group) return [address];
    if (group.members) return group.members;
    return seatsByRole(root, projectName, required(group.role, `role for group ${address}`));
  }));
  return [...new Set(expanded.flat())];
}

async function run(command: string[], quiet = false) {
  const result = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${stderr.trim() || stdout.trim()}`);
  if (!quiet && stdout.trim()) process.stdout.write(stdout);
}

async function exists(path: string) {
  try { await stat(path); return true; }
  catch { return false; }
}

async function ensureWorktree(config: Project, role: Role, worktree: string, branch: string) {
  if (!config.repository || worktree === resolve(config.repository) || await exists(worktree)) return;
  await mkdir(dirname(worktree), { recursive: true });
  const ref = `refs/heads/${branch}`;
  const probe = Bun.spawn(["git", "-C", config.repository, "show-ref", "--verify", "--quiet", ref]);
  const branchExists = await probe.exited === 0;
  const command = branchExists
    ? ["git", "-C", config.repository, "worktree", "add", worktree, branch]
    : ["git", "-C", config.repository, "worktree", "add", "-b", branch, worktree, role.base ?? "HEAD"];
  await run(command, true);
}

async function inject(root: string, address: string, message: Message, threadId: string) {
  const target = await seat(root, address);
  const runtime = target.runtime;
  if (!runtime?.pane || !runtime.backend) return;
  const file = paths(root).message(threadId, message.id);
  const notice = `SYSTEM: new thread mail ${message.id} from ${message.from}. Read ${file}`;
  const commands: Record<Backend, string[]> = {
    tmux: ["tmux", "send-keys", "-t", runtime.pane, notice, "Enter"],
    herdr: ["herdr", "agent", "send", runtime.pane, notice],
    tuios: ["tuios", "queue", "-w", runtime.pane, notice],
  };
  try { await run(commands[runtime.backend], true); }
  catch (error) { console.warn(`Notification for ${address} was not delivered: ${(error as Error).message}`); }
}

async function post(root: string, threadId: string, args: string[], overrides: Partial<Message> = {}) {
  const record = await thread(root, threadId);
  const from = required(overrides.from ?? words(args, "--from"), "--from");
  if (!record.participants.includes(from)) throw new Error(`${from} is not a thread participant.`);
  const toValue = overrides.to ?? words(args, "--to") ?? "all";
  const recipients = Array.isArray(toValue) ? toValue : await resolveRecipients(root, toValue, record.participants);
  if (recipients.some((address) => !record.participants.includes(address))) throw new Error("Recipients must be thread participants.");
  const message: Message = {
    schema: "atdd-seat/message/v1", id: id("M"), from, to: toValue === "all" ? "all" : recipients,
    kind: overrides.kind ?? "message",
    ...(overrides.in_reply_to ? { in_reply_to: overrides.in_reply_to } : {}),
    ...(overrides.expects_result || has(args, "--expects-result") ? { expects_result: true } : {}),
    created_at: now(), body: required(overrides.body ?? words(args, "--body"), "--body"),
  };
  await atomicYaml(paths(root).message(threadId, message.id), message);
  await Promise.all(recipients.filter((address) => address !== from).map((address) => inject(root, address, message, threadId)));
  console.log(message.id);
}

const defaultRoles = (): Record<string, Role> => ({
  coordinator: { address: "coordinator@{project}", branch: "main", agent: "claude", worktree: "{repository}" },
  driver: { address: "driver.{name}@{project}", branch: "delivery/{name}", base: "main", agent: "codex", worktree: "{worktree_root}/{name}" },
});

async function init(root: string, name: string) {
  const config: Site = { schema: "atdd-seat/site/v1", site: name, backend: "tmux" };
  await Promise.all([mkdir(paths(root).work, { recursive: true }), mkdir(paths(root).threads, { recursive: true })]);
  await atomicYaml(paths(root).site, config);
  console.log(`Initialized ${root}`);
}

async function initProject(root: string, name: string) {
  await site(root);
  const config: Project = { schema: "atdd-seat/project/v1", project: name, roles: defaultRoles() };
  await mkdir(paths(root).seats(name), { recursive: true });
  await atomicYaml(paths(root).projectFile(name), config);
  console.log(`Initialized project ${name}`);
}

async function spawn(root: string, projectName: string, roleName: string, name: string, args: string[]) {
  const config = await project(root, projectName);
  const role = required(config.roles[roleName], `role ${roleName}`);
  const values = { project: config.project, name, worktree_root: config.worktree_root ?? "" };
  const address = fill(role.address, values);
  const configuredPath = role.worktree ? fill(role.worktree, { ...values, repository: config.repository ?? "" }) : undefined;
  const worktree = resolve(required(words(args, "--worktree") ?? configuredPath, "--worktree or role worktree template"));
  const branch = words(args, "--branch") ?? fill(role.branch, { project: config.project, name });
  await ensureWorktree(config, role, worktree, branch);
  const purpose = words(args, "--purpose") ?? (role.purpose ? fill(role.purpose, values) : undefined);
  const record: Seat = { schema: "atdd-seat/seat/v1", address, role: roleName, project: config.project, worktree, branch, agent: role.agent, ...(purpose ? { purpose } : {}) };
  await atomicYaml(paths(root).seatFile(address), record);
  console.log(address);
}

async function bind(root: string, address: string, args: string[]) {
  const record = await seat(root, address);
  const config = await site(root);
  record.runtime = { pane: required(words(args, "--pane"), "--pane"), backend: (words(args, "--backend") ?? config.backend) as Backend, attached_at: now() };
  await atomicYaml(paths(root).seatFile(address), record);
  console.log(`Bound ${address} to ${record.runtime.backend}:${record.runtime.pane}`);
}

async function describe(root: string, address: string, args: string[]) {
  const record = await seat(root, address);
  record.purpose = required(words(args, "--purpose"), "--purpose");
  await atomicYaml(paths(root).seatFile(address), record);
  console.log(`Described ${address}`);
}

async function checkpoint(root: string, address: string, args: string[]) {
  await seat(root, address);
  const references = words(args, "--references")?.split(",").filter(Boolean);
  const record: Checkpoint = {
    schema: "atdd-seat/checkpoint/v1",
    seat: address,
    status: (words(args, "--status") ?? "active") as Checkpoint["status"],
    updated_at: now(),
    summary: required(words(args, "--summary"), "--summary"),
    next_action: required(words(args, "--next"), "--next"),
    ...(references?.length ? { references } : {}),
  };
  await atomicYaml(paths(root).checkpointFile(address), record);
  console.log(`Checkpointed ${address}`);
}

async function startThread(root: string, args: string[]) {
  const participants = await resolveRecipients(root, required(words(args, "--with"), "--with"), []);
  if (participants.length < 2) throw new Error("A thread needs at least two participants.");
  const record: Thread = { schema: "atdd-seat/thread/v1", id: id("T"), participants, subject: required(words(args, "--subject"), "--subject"), state: "open" };
  await atomicYaml(paths(root).threadFile(record.id), record);
  console.log(record.id);
}

async function addParticipant(root: string, threadId: string, address: string) {
  const record = await thread(root, threadId);
  if (!record.participants.includes(address)) record.participants.push(address);
  await atomicYaml(paths(root).threadFile(threadId), record);
}

async function status(root: string) {
  const threadIds = (await readdir(paths(root).threads)).sort();
  for (const threadId of threadIds) {
    const record = await thread(root, threadId);
    const all = await messages(root, threadId);
    const pending = all.flatMap((message) => {
      if (!message.expects_result) return [];
      const responders = message.to === "all" ? record.participants.filter((address) => address !== message.from) : message.to;
      return responders
        .filter((address) => !all.some((reply) => reply.kind === "result" && reply.in_reply_to === message.id && reply.from === address))
        .map((address) => `${message.id}@${address}`);
    });
    console.log(`${threadId}  ${record.state}  ${record.subject}${pending.length ? `  waiting:${pending.join(",")}` : ""}`);
  }
}

async function openSeat(root: string, address: string) {
  const record = await seat(root, address);
  console.log(yaml.print(record));
  const checkpointFile = paths(root).checkpointFile(address);
  if (await exists(checkpointFile)) console.log(yaml.print(await readYaml<Checkpoint>(checkpointFile)));
  const threadIds = await readdir(paths(root).threads);
  for (const threadId of threadIds) {
    const entry = await thread(root, threadId);
    if (entry.participants.includes(address)) console.log(`${threadId}  ${entry.state}  ${entry.subject}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) return console.log(usage);
  const [command, ...rest] = args;
  const root = resolve(process.cwd());
  const commands: Record<string, () => Promise<void>> = {
    init: () => {
      const folder = resolve(required(rest[0], "site directory"));
      return init(folder, basename(folder));
    },
    project: async () => {
      if (rest[0] === "init") return initProject(root, required(rest[1], "project"));
      throw new Error("Use `seat project init <project>`.");
    },
    spawn: () => spawn(root, required(rest[0], "project"), required(rest[1], "role"), required(rest[2], "name"), rest.slice(3)),
    bind: () => bind(root, required(rest[0], "address"), rest.slice(1)),
    describe: () => describe(root, required(rest[0], "address"), rest.slice(1)),
    checkpoint: () => checkpoint(root, required(rest[0], "address"), rest.slice(1)),
    thread: async () => {
      const [subcommand, ...tail] = rest;
      if (subcommand === "start") return startThread(root, tail);
      if (subcommand === "add") return addParticipant(root, required(tail[0], "thread id"), required(tail[1], "address"));
      throw new Error("Use `seat thread start` or `seat thread add`.");
    },
    post: () => post(root, required(rest[0], "thread id"), rest.slice(1)),
    receipt: () => post(root, required(rest[0], "thread id"), rest.slice(2), { from: required(words(rest.slice(2), "--from"), "--from"), kind: "receipt", in_reply_to: required(rest[1], "message id"), body: words(rest.slice(2), "--body") ?? `Received ${required(rest[1], "message id")}.` }),
    result: () => post(root, required(rest[0], "thread id"), rest.slice(2), { from: required(words(rest.slice(2), "--from"), "--from"), kind: "result", in_reply_to: required(rest[1], "message id"), body: required(words(rest.slice(2), "--body"), "--body") }),
    status: () => status(root),
    open: () => openSeat(root, required(rest[0], "address")),
  };
  const action = commands[command];
  if (!action) throw new Error(`Unknown command: ${command}`);
  await action();
}

main().catch((error) => { console.error(`seat: ${(error as Error).message}`); process.exit(1); });
