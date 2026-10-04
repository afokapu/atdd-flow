import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type Backend, type Checkpoint, type Project, type Role, type Seat, atomicYaml, canonicalAddress,
  exists, fill, now, paths, project, readYaml, required, run, seat, site, words, yaml,
} from "./core";

const defaultRoles = (): Record<string, Role> => ({
  coordinator: { address: "coordinator@{project}", branch: "main", agent: "claude", worktree: "{repository}" },
  driver: { address: "driver.{name}@{project}", branch: "delivery/{name}", base: "main", agent: "codex", worktree: "{worktree_root}/{name}" },
});

export async function init(root: string, name: string, args: string[]) {
  const config = { schema: "atdd-workflow/coordination/v1", site: name, backend: "tmux" as Backend };
  await Promise.all([mkdir(paths(root).work, { recursive: true }), mkdir(paths(root).threads, { recursive: true })]);
  await atomicYaml(paths(root).site, config);
  if (args.includes("--git") && !await exists(join(root, ".git"))) await run(["git", "init", "--initial-branch=main", root]);
  console.log(`Initialized ${root}`);
}

export async function initProject(root: string, name: string) {
  await site(root);
  const config: Project = { schema: "atdd-workflow/project/v1", project: name, roles: defaultRoles() };
  await mkdir(paths(root).seats(name), { recursive: true });
  await atomicYaml(paths(root).projectFile(name), config);
  console.log(`Initialized project ${name}`);
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

export async function spawn(root: string, projectName: string, roleName: string, name: string, args: string[]) {
  const config = await project(root, projectName);
  const role = required(config.roles[roleName], `role ${roleName}`);
  const entries = { project: config.project, name, worktree_root: config.worktree_root ?? "" };
  const address = fill(role.address, entries);
  const configuredPath = role.worktree ? fill(role.worktree, { ...entries, repository: config.repository ?? "" }) : undefined;
  const worktree = resolve(required(words(args, "--worktree") ?? configuredPath, "--worktree or role worktree template"));
  const branch = words(args, "--branch") ?? fill(role.branch, { project: config.project, name });
  await ensureWorktree(config, role, worktree, branch);
  const purpose = words(args, "--purpose") ?? (role.purpose ? fill(role.purpose, entries) : undefined);
  const record: Seat = { schema: "atdd-workflow/seat/v1", address, role: roleName, project: config.project, worktree, branch, agent: role.agent, ...(purpose ? { purpose } : {}) };
  await atomicYaml(paths(root).seatFile(address), record);
  console.log(address);
}

export async function bind(root: string, address: string, args: string[]) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  const config = await site(root);
  record.runtime = {
    pane: required(words(args, "--pane"), "--pane"),
    ...(words(args, "--session") ? { session: words(args, "--session") } : {}),
    backend: (words(args, "--backend") ?? config.backend) as Backend,
    attached_at: now(),
  };
  await atomicYaml(paths(root).seatFile(resolved), record);
  console.log(`Bound ${resolved} to ${record.runtime.backend}:${record.runtime.pane}`);
}

export async function describe(root: string, address: string, args: string[]) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  record.purpose = required(words(args, "--purpose"), "--purpose");
  await atomicYaml(paths(root).seatFile(resolved), record);
  console.log(`Described ${resolved}`);
}

export async function checkpoint(root: string, address: string, args: string[]) {
  const resolved = await canonicalAddress(root, address);
  await seat(root, resolved);
  const references = words(args, "--references")?.split(",").filter(Boolean);
  const record: Checkpoint = {
    schema: "atdd-workflow/checkpoint/v1", seat: resolved,
    status: (words(args, "--status") ?? "active") as Checkpoint["status"], updated_at: now(),
    summary: required(words(args, "--summary"), "--summary"), next_action: required(words(args, "--next"), "--next"),
    ...(references?.length ? { references } : {}),
  };
  await atomicYaml(paths(root).checkpointFile(resolved), record);
  console.log(`Checkpointed ${resolved}`);
}

export async function openSeat(root: string, address: string) {
  const resolved = await canonicalAddress(root, address);
  const record = await seat(root, resolved);
  console.log(yaml.print(record));
  const checkpointFile = paths(root).checkpointFile(resolved);
  if (await exists(checkpointFile)) console.log(yaml.print(await readYaml<Checkpoint>(checkpointFile)));
  const threadIds = await readdir(paths(root).threads);
  for (const threadId of threadIds) {
    const file = paths(root).threadFile(threadId);
    if (!await exists(file)) continue;
    const entry = await readYaml<{ participants: string[]; state: string; subject: string }>(file);
    if (entry.participants.includes(resolved)) console.log(`${threadId}  ${entry.state}  ${entry.subject}`);
  }
}
