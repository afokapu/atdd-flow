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

async function targets(root: string): Promise<Target[]> {
  let projects: string[];
  try { projects = await readdir(paths(root).work); }
  catch { return []; }
  const result: Target[] = [];
  for (const name of projects) {
    let config: Project;
    try { config = await project(root, name); }
    catch { continue; }
    // A repository is the Desk's explicit primary-checkout declaration. Do not infer one.
    if (!config.repository) continue;
    const primary = resolve(config.repository);
    // The primary checkout is explicitly declared by the project even if no
    // primary-worktree seat currently occupies it.
    result.push({ project: name, worktree: primary, workspaceLabel: name });
    for (const entry of await projectSeats(root, name)) {
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

function command(session: string, args: string[]) {
  return runOutput(["herdr", "--session", session, ...args]);
}

function json(output: string): any {
  try { return JSON.parse(output).result; }
  catch { throw new Error("Herdr returned invalid JSON; projection did not guess a target."); }
}

function workspaceId(value: any) {
  const found = value?.workspace?.workspace_id ?? value?.workspace_id;
  if (typeof found !== "string") throw new Error("Herdr did not return a workspace id.");
  return found;
}

function paneId(value: any) {
  const found = value?.root_pane?.pane_id ?? value?.pane?.pane_id;
  if (typeof found !== "string") throw new Error("Herdr did not return a pane id.");
  return found;
}

async function liveWorkspaces(session: string) {
  const value = json(await command(session, ["workspace", "list"]));
  if (!Array.isArray(value?.workspaces)) throw new Error("Herdr workspace list response is invalid.");
  return value.workspaces as Workspace[];
}

async function ensureWorkspace(session: string, target: Target, workspaces: Workspace[]) {
  let current = workspaces.find((entry) => resolve(entry.worktree?.checkout_path ?? "") === target.worktree);
  if (!current) {
    const created = target.workspaceLabel === target.project
      ? json(await command(session, ["workspace", "create", "--cwd", target.worktree, "--label", target.workspaceLabel, "--no-focus"]))
      : json(await command(session, ["worktree", "open", "--path", target.worktree, "--label", target.workspaceLabel, "--no-focus"]));
    current = { workspace_id: workspaceId(created), label: target.workspaceLabel, worktree: { checkout_path: target.worktree } };
    workspaces.push(current);
  } else if (current.label !== target.workspaceLabel) {
    await command(session, ["workspace", "rename", current.workspace_id, target.workspaceLabel]);
    current.label = target.workspaceLabel;
  }
  return current.workspace_id;
}

async function ensureSeatTab(session: string, workspace: string, target: Target & { seat: Seat }) {
  const tabsResult = json(await command(session, ["tab", "list", "--workspace", workspace]));
  const tabs = tabsResult?.tabs as Tab[];
  if (!Array.isArray(tabs)) throw new Error("Herdr tab list response is invalid.");
  let tab = tabs.find((entry) => entry.label === target.seat.address);
  let pane: string | undefined;
  if (!tab) {
    const created = json(await command(session, ["tab", "create", "--workspace", workspace, "--cwd", target.worktree, "--label", target.seat.address, "--no-focus"]));
    tab = { tab_id: created?.tab?.tab_id, workspace_id: workspace, label: target.seat.address };
    pane = paneId(created);
    if (!tab.tab_id) throw new Error("Herdr did not return a tab id.");
  }
  const panesResult = json(await command(session, ["pane", "list", "--workspace", workspace]));
  const panes = panesResult?.panes as Pane[];
  if (!Array.isArray(panes)) throw new Error("Herdr pane list response is invalid.");
  const labelled = panes.find((entry) => entry.tab_id === tab!.tab_id && entry.label === target.seat.address);
  if (labelled) return;
  const first = pane ?? panes.find((entry) => entry.tab_id === tab!.tab_id)?.pane_id;
  if (!first) throw new Error(`Herdr tab ${tab.tab_id} has no pane to label.`);
  await command(session, ["pane", "rename", first, target.seat.address]);
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
  if (action === "status") {
    // Status deliberately has no reconciliation side effects.
    const workspaces = await liveWorkspaces(session);
    const present = desired.filter((target) => workspaces.some((entry) => resolve(entry.worktree?.checkout_path ?? "") === target.worktree));
    console.log(JSON.stringify({ schema: "atdd-workflow/multiplexer-status/v1", application: "herdr", session, desired: desired.length, present: present.length }, null, 2));
    return;
  }
  const workspaces = await liveWorkspaces(session);
  for (const target of desired) {
    const workspace = await ensureWorkspace(session, target, workspaces);
    if (target.seat) await ensureSeatTab(session, workspace, target);
  }
  console.log(`Projected ${desired.length} Desk seat worktree(s) into Herdr session ${session}.`);
}
