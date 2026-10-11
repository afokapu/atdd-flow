import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desk, exists, paths, project, readYaml, runOutput, type Project, type Seat } from "./core";
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
type Pane = { pane_id: string; tab_id: string; label?: string; agent?: string; agent_status?: string };
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

async function projectSeats(root: string, projectName: string, includeRetired = false) {
  const folder = paths(root).seats(projectName);
  let names: string[];
  try { names = await readdir(folder); }
  catch { return []; }
  const seats = await Promise.all(names.map(async (name) => {
    const file = join(folder, name, "seat.yaml");
    return await exists(file) ? readYaml<Seat>(file) : undefined;
  }));
  return seats.filter((entry): entry is Seat => Boolean(entry && entry.schema === "atdd-workflow/seat/v2" && (includeRetired || !entry.retired)));
}

type Liveness = (entry: Seat) => Promise<boolean>;

/** A bound Herdr pane is live only when Herdr still reports that exact pane running an agent. */
const livePane = (session: string, command: HerdrCommand): Liveness => async (entry) => {
  const binding = entry.runtime?.addresses?.herdr;
  if (!binding) return false;
  const pane = typeof binding === "string" ? binding : binding.pane;
  const owner = typeof binding === "string" ? session : binding.session;
  try {
    const value = json(await command(["herdr", "--session", owner, "pane", "get", pane]));
    const report = value?.pane ?? value;
    return report?.pane_id === pane && typeof report.agent === "string" && report.agent !== "";
  } catch { return false; }
};

/** A driver is active for blanket projection only with unblocked in-progress work or a live bound runtime. */
async function activeDriver(root: string, projectName: string, entry: Seat, live?: Liveness) {
  const owned = (await seatTasks(root, projectName, entry.address)).filter(({ task }) => task.assignee === entry.address);
  if (owned.some(({ task }) => task.status === "in_progress" && !task.blocker)) return true;
  return live ? live(entry) : false;
}

export type UnprojectedSeat = { address: string; reason: string };

/** Seats whose recorded placement violates the project topology; they are never projected. */
export async function misplacedSeats(root: string, projectName: string): Promise<UnprojectedSeat[]> {
  const config = await project(root, projectName);
  if (!config.repository) return [];
  const primary = resolve(config.repository);
  const result: UnprojectedSeat[] = [];
  for (const entry of await projectSeats(root, projectName)) {
    try { assertNewTopologyPlacement(config, entry, primary); }
    catch (error) { result.push({ address: entry.address, reason: (error as Error).message }); }
  }
  return result;
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

/**
 * A misplaced seat is skipped and recorded in `unprojected` so it never aborts projection of other
 * seats; requesting that seat explicitly (`strict`) still rejects.
 */
async function targets(root: string, options: { strict?: string; unprojected?: UnprojectedSeat[]; live?: Liveness; activeDrivers?: Set<string> } = {}): Promise<Target[]> {
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
      try { assertNewTopologyPlacement(config, entry, primary); }
      catch (error) {
        if (entry.address === options.strict) throw error;
        options.unprojected?.push({ address: entry.address, reason: (error as Error).message });
        continue;
      }
      if ((entry.role === "main" || entry.role === "coordinator" || entry.role === "operator") && resolve(entry.worktree) === primary) {
        result.push({ project: name, worktree: primary, workspaceLabel: name, seat: entry });
        continue;
      }
      let linked = entry.role === "coordinator" && resolve(entry.worktree) !== primary;
      if (entry.role === "driver") {
        // An explicit per-seat projection keeps the established assigned-work rule.
        linked = entry.address === options.strict
          ? (await seatTasks(root, name, entry.address)).some(({ task }) => task.assignee === entry.address && task.status !== "done")
          : await activeDriver(root, name, entry, options.live);
        if (linked) options.activeDrivers?.add(entry.address);
      }
      if (!linked) continue;
      if (entry.address !== options.strict && !await exists(entry.worktree)) {
        options.unprojected?.push({ address: entry.address, reason: `Worktree ${resolve(entry.worktree)} does not exist.` });
        continue;
      }
      result.push({ project: name, worktree: resolve(entry.worktree), workspaceLabel: entry.address, seat: entry });
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

/** A live workspace without a checkout path never matches: resolve("") would be the process cwd. */
/**
 * Herdr may list a primary workspace created for a non-code checkout with no checkout path. Such a
 * workspace matches only the primary target, and only by its exact project label (so it is never
 * renamed); linked seat targets always require a checkout path.
 */
function matchWorkspace(workspaces: Workspace[], target: Target) {
  const checkoutOf = (entry: Workspace) => {
    const checkout = entry.worktree?.checkout_path;
    return typeof checkout === "string" && checkout !== "" ? checkout : undefined;
  };
  const byCheckout = workspaces.find((entry) => { const checkout = checkoutOf(entry); return checkout !== undefined && resolve(checkout) === target.worktree; });
  if (byCheckout || target.workspaceLabel !== target.project) return byCheckout;
  return workspaces.find((entry) => checkoutOf(entry) === undefined && entry.label === target.project);
}

async function ensureWorkspace(session: string, target: Target, workspaces: Workspace[], command: HerdrCommand, primary?: WorkspaceState) {
  let current = matchWorkspace(workspaces, target);
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
  const desired = await targets(root, { strict: address });
  const target = desired.find((entry) => entry.seat?.address === address);
  if (!target?.seat) throw new Error(`No active Desk projection target exists for ${address}.`);
  const primaryTarget = desired.find((entry) => entry.project === target.project && entry.workspaceLabel === target.project && !entry.seat);
  if (!primaryTarget) throw new Error(`Project ${target.project} has no declared primary workspace.`);
  const workspaces = await liveWorkspaces(session, command);
  const primary = await ensureWorkspace(session, primaryTarget, workspaces, command);
  return (await ensureTarget(session, target, workspaces, command, primary))!;
}

type StaleWorkspace = { workspace: Workspace; address: string; reason: "retired" | "no active task" };

async function commonDirectory(path: string) {
  return runOutput(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
}
async function topLevel(path: string) {
  return runOutput(["git", "-C", path, "rev-parse", "--show-toplevel"]);
}

/** True when a checkout no longer exists or is a linked (non-primary) worktree of the primary repository. */
async function linkedOrMissing(checkout: string, primary: string) {
  if (!await exists(checkout)) return true;
  try {
    return await commonDirectory(checkout) === await commonDirectory(primary) && await topLevel(checkout) !== await topLevel(primary);
  } catch { return false; }
}

/**
 * A stale workspace carries a Desk driver seat label (retired or inactive) and a checkout that is a
 * linked worktree of that seat's Desk project, or no longer exists. Every other workspace is ignored.
 */
async function staleWorkspaces(root: string, workspaces: Workspace[], activeDrivers: Set<string>) {
  let projects: string[];
  try { projects = await readdir(paths(root).work); }
  catch { return []; }
  const result: StaleWorkspace[] = [];
  for (const name of projects) {
    let config: Project;
    try { config = await project(root, name); }
    catch { continue; }
    if (!config.repository) continue;
    const primary = resolve(config.repository);
    const drivers = (await projectSeats(root, name, true)).filter((entry) => entry.role === "driver" && !activeDrivers.has(entry.address));
    for (const entry of drivers) {
      for (const workspace of workspaces.filter((candidate) => candidate.label === entry.address)) {
        const checkout = workspace.worktree?.checkout_path;
        if (typeof checkout !== "string" || checkout === "" || resolve(checkout) === primary) continue;
        if (await linkedOrMissing(checkout, primary)) result.push({ workspace, address: entry.address, reason: entry.retired ? "retired" : "no active task" });
      }
    }
  }
  return result;
}

type StaleDecision = {
  address: string;
  workspace_id: string;
  reason: StaleWorkspace["reason"];
  agents: Array<Pick<Pane, "pane_id" | "agent" | "agent_status">>;
  outcome: "close" | "keep";
  because?: string;
};

const closeInactiveOff = "close_inactive is off";

/**
 * Read-only decision for one stale workspace, shared by `status` and `apply`: it is closed only when
 * close_inactive is on and none of its agents is working or blocked.
 */
async function decideStale(session: string, stale: StaleWorkspace, close: boolean, command: HerdrCommand): Promise<StaleDecision> {
  const agents = (await panes(session, stale.workspace.workspace_id, command))
    .map(({ pane_id, agent, agent_status }) => ({ pane_id, ...(agent ? { agent } : {}), ...(agent_status ? { agent_status } : {}) }));
  const busy = agents.find((entry) => entry.agent_status === "working" || entry.agent_status === "blocked");
  const because = !close ? closeInactiveOff : busy ? `agent in ${busy.pane_id} is ${busy.agent_status}` : undefined;
  return { address: stale.address, workspace_id: stale.workspace.workspace_id, reason: stale.reason, agents, outcome: because ? "keep" : "close", ...(because ? { because } : {}) };
}

/** Acts on one stale-workspace decision: closes it, or reports why it is kept. */
async function applyStale(session: string, decision: StaleDecision, command: HerdrCommand) {
  const label = `${decision.address}  ${decision.workspace_id}`;
  if (decision.outcome === "keep") return `${decision.because === closeInactiveOff ? "stale" : "kept"}  ${label}: ${decision.because}`;
  await command(["herdr", "--session", session, "workspace", "close", decision.workspace_id]);
  return `closed  ${label}`;
}

const closeInactive = async (root: string) => (await desk(root)).multiplexer?.close_inactive === true;

/**
 * Closes the workspace of a just-retired driver when the Desk enables close_inactive. Closing is
 * best-effort housekeeping: it reports, and never undoes the completed retirement.
 */
export async function closeRetiredDriverWorkspace(root: string, entry: Seat, command: HerdrCommand = herdr, environment: Record<string, string | undefined> = process.env) {
  try {
    const config = await desk(root);
    if (config.multiplexer?.close_inactive !== true) return;
    const binding = entry.runtime?.addresses?.herdr;
    const session = (binding && typeof binding !== "string" ? binding.session : undefined) ?? environment.HERDR_SESSION ?? config.herdr_session;
    if (!session) return;
    const workspaces = (await liveWorkspaces(session, command)).filter((workspace) => workspace.label === entry.address);
    if (!workspaces.length) return;
    for (const stale of await staleWorkspaces(root, workspaces, new Set())) console.log(await applyStale(session, await decideStale(session, stale, true, command), command));
  } catch (error) {
    console.log(`Workspace close for ${entry.address} was not completed: ${(error as Error).message}`);
  }
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
  const unprojected: UnprojectedSeat[] = [];
  const command: HerdrCommand = herdr;
  const activeDrivers = new Set<string>();
  const desired = await targets(root, { unprojected, live: livePane(session, command), activeDrivers });
  const workspaces = await liveWorkspaces(session, command);
  const close = await closeInactive(root);
  const stale = await staleWorkspaces(root, workspaces, activeDrivers);
  const decide = (entry: StaleWorkspace) => decideStale(session, entry, close, command);
  if (action === "status") {
    const present = desired.filter((target) => matchWorkspace(workspaces, target));
    const topology = await Promise.all(desired.map(async (target) => {
      const workspace = matchWorkspace(workspaces, target);
      return workspace ? topologyCompliant(session, target, workspace, command) : false;
    }));
    console.log(JSON.stringify({ schema: "atdd-workflow/multiplexer-status/v1", application: "herdr", session, desired: desired.length, present: present.length, topology_compliant: topology.filter(Boolean).length, stale: stale.length, stale_workspaces: await Promise.all(stale.map(decide)), close_inactive: close, unprojected }, null, 2));
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
  for (const entry of unprojected) console.log(`unprojected  ${entry.address}: ${entry.reason}`);
  // Decided at close time with the same read-only rule `status` reports.
  for (const entry of stale) console.log(await applyStale(session, await decide(entry), command));
  console.log(`Projected ${desired.length} Desk seat worktree(s) into Herdr session ${session}.`);
}
