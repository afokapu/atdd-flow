import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exists, paths, project, readYaml, runOutput, type Project, type Seat } from "./core";
import { seatTasks } from "./tasks";

export type HerdrPolicy = {
  schema: "atdd-workflow/multiplexer/herdr/v1";
  projection: {
    primary: {
      worktree: "primary";
      workspace_label: "{project}";
      seats: { roles: string[]; tab_label: "{seat.address}"; pane_label: "{seat.address}" };
    };
    linked_worktree: {
      worktree: "linked";
      seats: {
        coordinator: "always";
        driver: "active_or_assigned";
        workspace_label: "{seat.address}";
        tab_label: "{seat.address}";
        pane_label: "{seat.address}";
      };
    };
  };
};

type Workspace = { workspace_id: string; label?: string; worktree?: { checkout_path?: string } };
type Tab = { tab_id: string; workspace_id: string; label?: string };
type Pane = { pane_id: string; tab_id: string; label?: string };
type Target = { project: string; worktree: string; workspaceLabel: string; seat?: Seat };
type WorkspaceState = { id: string; label: string; worktree: string; rootTab?: string; rootPane?: string };
type HerdrCommand = (command: string[]) => Promise<string>;

export type HerdrSeatProjection = {
  session: string;
  workspace: string;
  tab: string;
  pane: string;
  worktree: string;
  label: string;
};

const policyFile = () => join(import.meta.dir, "..", "multiplexer", "herdr.yaml");
const selectedSession = (args: string[], environment: Record<string, string | undefined> = process.env) => {
  const index = args.indexOf("--session");
  return index < 0 ? environment.HERDR_SESSION : args[index + 1];
};

/** The policy is deliberately instance-free; all concrete data comes from Desk records at apply time. */
export async function herdrPolicy() {
  const file = policyFile();
  if (!await exists(file)) throw new Error(`Herdr multiplexer policy is missing: ${file}`);
  const value = await readYaml<HerdrPolicy>(file);
  const keys = (entry: object, expected: string[]) => expected.length === Object.keys(entry).length && expected.every((key) => key in entry);
  const expected = keys(value, ["schema", "projection"])
    && keys(value.projection ?? {}, ["primary", "linked_worktree"])
    && keys(value.projection?.primary ?? {}, ["worktree", "workspace_label", "seats"])
    && keys(value.projection?.primary?.seats ?? {}, ["roles", "tab_label", "pane_label"])
    && keys(value.projection?.linked_worktree ?? {}, ["worktree", "seats"])
    && keys(value.projection?.linked_worktree?.seats ?? {}, ["coordinator", "driver", "workspace_label", "tab_label", "pane_label"])
    && value.schema === "atdd-workflow/multiplexer/herdr/v1"
    && value.projection?.primary?.worktree === "primary"
    && value.projection.primary.workspace_label === "{project}"
    && Array.isArray(value.projection.primary.seats?.roles)
    && value.projection.primary.seats.roles.length === 2
    && value.projection.primary.seats.roles.includes("main")
    && value.projection.primary.seats.roles.includes("coordinator")
    && value.projection.primary.seats.tab_label === "{seat.address}"
    && value.projection.primary.seats.pane_label === "{seat.address}"
    && value.projection.linked_worktree?.worktree === "linked"
    && value.projection.linked_worktree.seats?.coordinator === "always"
    && value.projection.linked_worktree.seats.driver === "active_or_assigned"
    && value.projection.linked_worktree.seats.workspace_label === "{seat.address}"
    && value.projection.linked_worktree.seats.tab_label === "{seat.address}"
    && value.projection.linked_worktree.seats.pane_label === "{seat.address}";
  if (!expected) throw new Error("Invalid generic Herdr multiplexer policy.");
  return value;
}

async function projectSeats(root: string, projectName: string) {
  const folder = paths(root).seats(projectName);
  let names: string[];
  try { names = await readdir(folder); }
  catch { return []; }
  const seats = await Promise.all(names.map(async (name) => {
    const file = join(folder, name, "seat.yaml");
    return await exists(file) ? readYaml<Seat>(file) : undefined;
  }));
  return seats.filter((entry): entry is Seat => Boolean(entry && entry.schema === "atdd-workflow/seat/v2" && !entry.retired));
}

function assertNewTopologyPlacement(config: Project, entry: Seat, primary: string) {
  const coordinator = config.roles.coordinator;
  const namedCoordinatorDefaults = coordinator?.address === "coordinator.{name}@{project}" && coordinator.branch === "integration/{name}";
  const mainDefaults = config.roles.main?.address === "main@{project}" && config.roles.main.branch === "main";
  if (entry.role === "main" && mainDefaults && (entry.address !== `main@${config.project}` || entry.branch !== "main" || resolve(entry.worktree) !== primary)) {
    throw new Error(`Main seat ${entry.address} must use the primary main worktree and branch.`);
  }
  if (entry.role !== "coordinator" || !namedCoordinatorDefaults) return;
  // coordinator@project remains the preserved historical primary identity;
  // every newly named coordinator must be a single linked integration stream.
  if (entry.address === `coordinator@${config.project}`) {
    if (entry.branch !== "main" || resolve(entry.worktree) !== primary) throw new Error(`Legacy primary coordinator ${entry.address} has mismatched placement.`);
    return;
  }
  const suffix = `@${config.project}`;
  const local = entry.address.endsWith(suffix) ? entry.address.slice(0, -suffix.length) : "";
  const match = local.match(/^coordinator\.([a-z0-9_-]+)$/);
  if (!match || entry.branch !== `integration/${match[1]}` || resolve(entry.worktree) === primary) {
    throw new Error(`Named coordinator ${entry.address} must use one linked integration/<stream> worktree and branch.`);
  }
}

async function targets(root: string): Promise<Target[]> {
  let projects: string[];
  try { projects = await readdir(paths(root).work); }
  catch { return []; }
  const result: Target[] = [];
  for (const name of projects) {
    let config: Project;
    try { config = await project(root, name); }
    catch { continue; }
    if (!config.repository) continue;
    const primary = resolve(config.repository);
    result.push({ project: name, worktree: primary, workspaceLabel: name });
    for (const entry of await projectSeats(root, name)) {
      assertNewTopologyPlacement(config, entry, primary);
      if ((entry.role === "main" || entry.role === "coordinator") && resolve(entry.worktree) === primary) {
        result.push({ project: name, worktree: primary, workspaceLabel: name, seat: entry });
        continue;
      }
      if (entry.role === "coordinator" && resolve(entry.worktree) !== primary) {
        result.push({ project: name, worktree: resolve(entry.worktree), workspaceLabel: entry.address, seat: entry });
        continue;
      }
      if (entry.role === "driver") {
        const active = (await seatTasks(root, name, entry.address)).some(({ task }) => task.assignee === entry.address && task.status !== "done");
        if (active) result.push({ project: name, worktree: resolve(entry.worktree), workspaceLabel: entry.address, seat: entry });
      }
    }
  }
  return result;
}

const herdr: HerdrCommand = (args) => runOutput(args);
function json(output: string): any {
  try { return JSON.parse(output).result; }
  catch { throw new Error("Herdr returned invalid JSON; projection did not guess a target."); }
}
function workspaceId(value: any) {
  const found = value?.workspace?.workspace_id ?? value?.workspace_id;
  if (typeof found !== "string") throw new Error("Herdr did not return a workspace id.");
  return found;
}
function tabId(value: any) {
  const found = value?.root_tab?.tab_id ?? value?.tab?.tab_id;
  return typeof found === "string" ? found : undefined;
}
function paneId(value: any) {
  const found = value?.root_pane?.pane_id ?? value?.pane?.pane_id;
  return typeof found === "string" ? found : undefined;
}
async function liveWorkspaces(session: string, command: HerdrCommand) {
  const value = json(await command(["herdr", "--session", session, "workspace", "list"]));
  if (!Array.isArray(value?.workspaces)) throw new Error("Herdr workspace list response is invalid.");
  return value.workspaces as Workspace[];
}

async function ensureWorkspace(session: string, target: Target, workspaces: Workspace[], command: HerdrCommand, primary?: WorkspaceState) {
  let current = workspaces.find((entry) => resolve(entry.worktree?.checkout_path ?? "") === target.worktree);
  if (!current) {
    const args = target.workspaceLabel === target.project
      ? ["workspace", "create", "--cwd", target.worktree, "--label", target.workspaceLabel, "--no-focus"]
      : ["worktree", "open", "--workspace", primary?.id ?? "", "--path", target.worktree, "--label", target.workspaceLabel, "--no-focus"];
    if (args.includes("")) throw new Error(`Project primary workspace is required to open linked worktree ${target.worktree}.`);
    const created = json(await command(["herdr", "--session", session, ...args]));
    current = { workspace_id: workspaceId(created), label: target.workspaceLabel, worktree: { checkout_path: target.worktree } };
    workspaces.push(current);
    return { id: current.workspace_id, label: target.workspaceLabel, worktree: target.worktree, ...(tabId(created) ? { rootTab: tabId(created) } : {}), ...(paneId(created) ? { rootPane: paneId(created) } : {}) };
  }
  if (current.label !== target.workspaceLabel) {
    await command(["herdr", "--session", session, "workspace", "rename", current.workspace_id, target.workspaceLabel]);
    current.label = target.workspaceLabel;
  }
  return { id: current.workspace_id, label: target.workspaceLabel, worktree: target.worktree };
}

async function tabs(session: string, workspace: string, command: HerdrCommand) {
  const result = json(await command(["herdr", "--session", session, "tab", "list", "--workspace", workspace]));
  if (!Array.isArray(result?.tabs)) throw new Error("Herdr tab list response is invalid.");
  return result.tabs as Tab[];
}
async function panes(session: string, workspace: string, command: HerdrCommand) {
  const result = json(await command(["herdr", "--session", session, "pane", "list", "--workspace", workspace]));
  if (!Array.isArray(result?.panes)) throw new Error("Herdr pane list response is invalid.");
  return result.panes as Pane[];
}

async function ensureSeatTab(session: string, workspace: WorkspaceState, target: Target & { seat: Seat }, command: HerdrCommand): Promise<HerdrSeatProjection> {
  let entries = await tabs(session, workspace.id, command);
  let tab = entries.find((entry) => entry.label === target.seat.address);
  let pane: string | undefined;
  if (!tab && workspace.rootTab) {
    tab = entries.find((entry) => entry.tab_id === workspace.rootTab) ?? { tab_id: workspace.rootTab, workspace_id: workspace.id };
    await command(["herdr", "--session", session, "tab", "rename", tab.tab_id, target.seat.address]);
    tab.label = target.seat.address;
  }
  if (!tab) {
    const created = json(await command(["herdr", "--session", session, "tab", "create", "--workspace", workspace.id, "--cwd", target.worktree, "--label", target.seat.address, "--no-focus"]));
    const id = tabId(created);
    if (!id) throw new Error("Herdr did not return a tab id.");
    tab = { tab_id: id, workspace_id: workspace.id, label: target.seat.address };
    pane = paneId(created);
  }
  const entriesPanes = await panes(session, workspace.id, command);
  const labelled = entriesPanes.find((entry) => entry.tab_id === tab!.tab_id && entry.label === target.seat.address);
  if (labelled) return { session, workspace: workspace.id, tab: tab.tab_id, pane: labelled.pane_id, worktree: target.worktree, label: target.seat.address };
  const first = pane ?? workspace.rootPane ?? entriesPanes.find((entry) => entry.tab_id === tab!.tab_id)?.pane_id;
  if (!first) throw new Error(`Herdr tab ${tab.tab_id} has no pane to label.`);
  await command(["herdr", "--session", session, "pane", "rename", first, target.seat.address]);
  return { session, workspace: workspace.id, tab: tab.tab_id, pane: first, worktree: target.worktree, label: target.seat.address };
}

async function ensureTarget(session: string, target: Target, workspaces: Workspace[], command: HerdrCommand, primary: WorkspaceState) {
  const workspace = target.workspaceLabel === target.project ? primary : await ensureWorkspace(session, target, workspaces, command, primary);
  return target.seat ? ensureSeatTab(session, workspace, target as Target & { seat: Seat }, command) : undefined;
}

/** Reconciles exactly one Desk seat into a labeled Herdr workspace/tab/pane. */
export async function projectHerdrSeat(root: string, address: string, session: string, command: HerdrCommand = herdr): Promise<HerdrSeatProjection> {
  await herdrPolicy();
  const desired = await targets(root);
  const target = desired.find((entry) => entry.seat?.address === address);
  if (!target?.seat) throw new Error(`No active Desk projection target exists for ${address}.`);
  const primaryTarget = desired.find((entry) => entry.project === target.project && entry.workspaceLabel === target.project && !entry.seat);
  if (!primaryTarget) throw new Error(`Project ${target.project} has no declared primary workspace.`);
  const workspaces = await liveWorkspaces(session, command);
  const primary = await ensureWorkspace(session, primaryTarget, workspaces, command);
  return (await ensureTarget(session, target, workspaces, command, primary))!;
}

async function topologyCompliant(session: string, target: Target, workspace: Workspace, command: HerdrCommand) {
  if (workspace.label !== target.workspaceLabel) return false;
  if (!target.seat) return true;
  const entries = await tabs(session, workspace.workspace_id, command);
  const tab = entries.find((entry) => entry.label === target.seat!.address);
  if (!tab) return false;
  return (await panes(session, workspace.workspace_id, command)).some((entry) => entry.tab_id === tab.tab_id && entry.label === target.seat!.address);
}

export async function multiplexer(root: string, args: string[]) {
  const action = args[0];
  const application = args[1];
  if (!(["status", "apply"] as string[]).includes(action) || application !== "herdr") {
    throw new Error("Use `atdd-flow multiplexer status|apply herdr [--session <name>]`.");
  }
  await herdrPolicy();
  const session = selectedSession(args.slice(2));
  if (!session) {
    console.log("No Herdr session selected; projection was not run.");
    return;
  }
  const desired = await targets(root);
  const command: HerdrCommand = herdr;
  const workspaces = await liveWorkspaces(session, command);
  if (action === "status") {
    const present = desired.filter((target) => workspaces.some((entry) => resolve(entry.worktree?.checkout_path ?? "") === target.worktree));
    const topology = await Promise.all(desired.map(async (target) => {
      const workspace = workspaces.find((entry) => resolve(entry.worktree?.checkout_path ?? "") === target.worktree);
      return workspace ? topologyCompliant(session, target, workspace, command) : false;
    }));
    console.log(JSON.stringify({ schema: "atdd-workflow/multiplexer-status/v1", application: "herdr", session, desired: desired.length, present: present.length, topology_compliant: topology.filter(Boolean).length }, null, 2));
    return;
  }
  const primary = new Map<string, WorkspaceState>();
  for (const target of desired) {
    let projectPrimary = primary.get(target.project);
    if (!projectPrimary) {
      const primaryTarget = desired.find((entry) => entry.project === target.project && entry.workspaceLabel === target.project && !entry.seat);
      if (!primaryTarget) throw new Error(`Project ${target.project} has no declared primary workspace.`);
      projectPrimary = await ensureWorkspace(session, primaryTarget, workspaces, command);
      primary.set(target.project, projectPrimary);
    }
    await ensureTarget(session, target, workspaces, command, projectPrimary);
  }
  console.log(`Projected ${desired.length} Desk seat worktree(s) into Herdr session ${session}.`);
}
