import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicYaml, exists, now as workflowNow, paths, readYaml, required, seat } from "./core";
import { type Task, terminal } from "./tasks";
import { post, startThread } from "./threads";

type Option = "authorize-safe-fallback" | "provide-cross-project-decision" | "hold-or-resolve";
type Alert = {
  schema: "atdd-workflow/owner-alert/v1"; id: string; incident: string; fingerprint: string;
  state: "blocked" | "waiting" | "resolved" | "superseded";
  material_class: "cross-project" | "toolkit" | "authorization"; affected_tasks: string[]; evidence: string;
  fallback: { state: "absent"; evidence: string; safe_automatic_action: "none" };
  owner_options: { id: Option; text: string }[]; prohibited_actions: string[];
  delivery: { state: "persisted" | "sent" | "delivered" | "acknowledged" | "executing" | "owner_unavailable"; persisted_at: string; sent_at?: string; delivered_at?: string; acknowledged_at?: string; executing_at?: string; unavailable_reason?: string };
  notifications: { at: string; thread?: string; message?: string; kind: "initial" | "reminder" }[]; thread?: string;
  owner_decision?: { option: Option; by: "operator@desk"; at: string }; resolution?: { by: string; reason: string; at: string }; superseded_by?: string;
};
type Candidate = Omit<Alert, "id" | "incident" | "fingerprint" | "delivery" | "notifications" | "thread">;
export type OwnerAlertScan = { created: string[]; sent: string[]; renotified: string[]; unavailable: string[]; ignored: string[] };

const directory = (root: string) => join(root, ".atdd-flow", "owner-alerts");
export const ownerAlertFile = (root: string, id: string) => join(directory(root), `${id}.yaml`);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const time = (value?: string) => value ?? workflowNow();
const options: { id: Option; text: string }[] = [
  { id: "authorize-safe-fallback", text: "Authorize one named safe fallback; Flow will not infer that authorization." },
  { id: "provide-cross-project-decision", text: "Provide the named cross-project/toolkit/authorization decision or owner." },
  { id: "hold-or-resolve", text: "Hold the work explicitly or confirm the blocker is resolved." },
];

/** Redaction occurs before blocker text enters an alert key, record, or durable mail. */
export function redactOwnerEvidence(value: string) {
  return value.replace(/\b(token|password|secret|api[-_ ]?key|authorization)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}
function classification(value: string) {
  if (/\bcross[- ]project\b/i.test(value)) return "cross-project" as const;
  if (/\btoolkit\b/i.test(value)) return "toolkit" as const;
  if (/\bauthorization\b|\bauthori[sz](?:e|ation)\b/i.test(value)) return "authorization" as const;
}
async function projects(root: string) {
  let names: string[]; try { names = await readdir(paths(root).work); } catch { return []; }
  const found = await Promise.all(names.map(async (name) => ({ name, valid: await exists(paths(root).projectFile(name)) })));
  return found.filter((entry) => entry.valid).map((entry) => entry.name);
}
async function tasks(root: string) {
  const result: { project: string; id: string; task: Task }[] = [];
  for (const project of await projects(root)) {
    let files: string[]; try { files = await readdir(paths(root).tasks(project)); } catch { continue; }
    for (const file of files.sort()) if (file.endsWith(".yaml") && !file.endsWith(".reviews.yaml")) result.push({ project, id: file.slice(0, -5), task: await readYaml<Task>(join(paths(root).tasks(project), file)) });
  }
  return result;
}
async function alerts(root: string) {
  let files: string[]; try { files = await readdir(directory(root)); } catch { return [] as Alert[]; }
  return Promise.all(files.filter((file) => file.endsWith(".yaml")).sort().map((file) => readYaml<Alert>(join(directory(root), file))));
}
async function escalator(root: string, address: string) {
  const actor = await seat(root, address);
  if (actor.role !== "coordinator" && actor.role !== "main") throw new Error("Only a coordinator or main seat may scan or resolve owner alerts.");
  return actor.address;
}
async function ownerAvailable(root: string) { try { return (await seat(root, "operator@desk")).role === "operator"; } catch { return false; } }
async function independent(root: string, entry: { project: string; id: string }, all: Awaited<ReturnType<typeof tasks>>) {
  for (const other of all) {
    if (other.project !== entry.project || other.id === entry.id || other.task.status !== "in_progress" || other.task.blocker || !other.task.assignee) continue;
    try { if ((await readYaml<{ status?: string }>(paths(root).checkpointFile(other.task.assignee))).status === "active") return true; } catch { /* absent checkpoint is not visible execution */ }
  }
  return false;
}
function candidate(entry: { project: string; id: string; task: Task }): Candidate | undefined {
  if (terminal(entry.task) || !entry.task.blocker) return;
  const material = classification(entry.task.blocker); if (!material) return;
  return { schema: "atdd-workflow/owner-alert/v1", state: "blocked", material_class: material, affected_tasks: [`${entry.project}/${entry.id}`], evidence: redactOwnerEvidence(entry.task.blocker),
    fallback: { state: "absent", evidence: "No independent checkpoint-active task is visibly executing in the affected project.", safe_automatic_action: "none" }, owner_options: options,
    prohibited_actions: ["Do not infer authorization.", "Do not execute an external action.", "Do not expose secrets."] };
}
function incident(value: Candidate) { return hash(`${value.material_class}\0${value.affected_tasks.join("\0")}`).slice(0, 16); }
function fingerprint(value: Candidate) { return hash(JSON.stringify({ state: value.state, evidence: value.evidence, fallback: value.fallback })); }
async function coordinatorFor(root: string, record: Alert) {
  return required((await tasks(root)).find((entry) => record.affected_tasks.includes(`${entry.project}/${entry.id}`))?.task.coordinator, "alert coordinator");
}
async function send(root: string, record: Alert, kind: "initial" | "reminder", timestamp: string) {
  const coordinator = await coordinatorFor(root, record);
  const thread = record.thread ?? await startThread(root, ["--with", `operator@desk,${coordinator}`, "--subject", `Owner alert ${record.id}`]);
  if (!record.thread) { record.thread = thread; await atomicYaml(ownerAlertFile(root, record.id), record); }
  const message = await post(root, thread, ["--from", coordinator, "--to", "operator@desk", "--label", "material stall owner alert", "--expects-result", "--body",
    `OWNER ALERT ${record.id}\nstate: ${record.state}\nclass: ${record.material_class}\naffected: ${record.affected_tasks.join(", ")}\nevidence: ${record.evidence}\nfallback: ${record.fallback.evidence}\nsafe automatic action: ${record.fallback.safe_automatic_action}\noptions: ${record.owner_options.map((option) => `${option.id} (${option.text})`).join("; ")}\nprohibited: ${record.prohibited_actions.join(" ")}`]);
  record.thread = thread; record.delivery.state = "sent"; record.delivery.sent_at = timestamp; record.notifications.push({ at: timestamp, thread, message, kind });
}

/** An explicit bounded observation, never a daemon, executor, or authorization proxy. */
export async function scanOwnerAlerts(root: string, input: { by: string; re_notify_after_ms?: number; now?: string }): Promise<OwnerAlertScan> {
  await escalator(root, input.by); const timestamp = time(input.now); const result: OwnerAlertScan = { created: [], sent: [], renotified: [], unavailable: [], ignored: [] };
  const all = await tasks(root); const stored = await alerts(root);
  for (const entry of all) {
    const next = candidate(entry);
    if (!next || await independent(root, entry, all)) { result.ignored.push(`${entry.project}/${entry.id}`); continue; }
    const key = incident(next); const digest = fingerprint(next); const active = stored.find((record) => record.incident === key && record.state !== "resolved" && record.state !== "superseded");
    if (active && active.fingerprint !== digest) { active.state = "superseded"; active.superseded_by = `O-${key}-${digest.slice(0, 8)}`; await atomicYaml(ownerAlertFile(root, active.id), active); }
    const exact = stored.find((record) => record.incident === key && record.fingerprint === digest);
    if (exact && exact.state !== "superseded") {
      if (exact.state === "resolved") { result.ignored.push(`${entry.project}/${entry.id}`); continue; }
      const last = exact.notifications.at(-1)?.at; const delay = input.re_notify_after_ms;
      if (exact.delivery.state === "sent" && delay !== undefined && delay >= 0 && last && Date.parse(timestamp) - Date.parse(last) >= delay) { await send(root, exact, "reminder", timestamp); await atomicYaml(ownerAlertFile(root, exact.id), exact); result.renotified.push(exact.id); }
      else result.ignored.push(`${entry.project}/${entry.id}`);
      continue;
    }
    const id = `O-${key}-${digest.slice(0, 8)}`; const record: Alert = { ...next, id, incident: key, fingerprint: digest, delivery: { state: "persisted", persisted_at: timestamp }, notifications: [] };
    await atomicYaml(ownerAlertFile(root, id), record); result.created.push(id);
    if (!await ownerAvailable(root)) { record.delivery.state = "owner_unavailable"; record.delivery.unavailable_reason = "operator@desk is absent or is not an operator seat."; await atomicYaml(ownerAlertFile(root, id), record); result.unavailable.push(id); continue; }
    try { await send(root, record, "initial", timestamp); await atomicYaml(ownerAlertFile(root, id), record); result.sent.push(id); }
    catch (error) { record.delivery.state = "persisted"; record.delivery.unavailable_reason = `Owner delivery path failed closed: ${(error as Error).message}`; await atomicYaml(ownerAlertFile(root, id), record); result.unavailable.push(id); }
  }
  return result;
}
async function read(root: string, id: string) { return readYaml<Alert>(ownerAlertFile(root, id)); }
async function owner(root: string, address: string) { if (address !== "operator@desk" || !await ownerAvailable(root)) throw new Error("Only the available operator@desk seat may update owner delivery state."); }
export async function deliverOwnerAlert(root: string, id: string, input: { by: string; now?: string }) { await owner(root, input.by); const record = await read(root, id); if (record.delivery.state !== "sent") throw new Error(`Owner alert ${id} is not awaiting delivery.`); record.delivery.state = "delivered"; record.delivery.delivered_at = time(input.now); await atomicYaml(ownerAlertFile(root, id), record); }
export async function acknowledgeOwnerAlert(root: string, id: string, input: { by: string; note: string; now?: string }) { await owner(root, input.by); required(input.note, "owner acknowledgement note"); const record = await read(root, id); if (record.delivery.state !== "delivered") throw new Error(`Owner alert ${id} must be delivered before acknowledgement.`); record.delivery.state = "acknowledged"; record.delivery.acknowledged_at = time(input.now); await atomicYaml(ownerAlertFile(root, id), record); }
export async function chooseOwnerAlertOption(root: string, id: string, input: { by: string; option: Option; now?: string }) { await owner(root, input.by); if (!options.some((entry) => entry.id === input.option)) throw new Error("Unknown owner alert option."); const record = await read(root, id); if (record.delivery.state !== "acknowledged") throw new Error(`Owner alert ${id} must be acknowledged before selecting an option.`); record.delivery.state = "executing"; record.delivery.executing_at = time(input.now); record.owner_decision = { option: input.option, by: "operator@desk", at: record.delivery.executing_at }; await atomicYaml(ownerAlertFile(root, id), record); }
export async function resolveOwnerAlert(root: string, id: string, input: { by: string; reason: string; now?: string }) { const by = await escalator(root, input.by); const record = await read(root, id); if (record.state === "resolved" || record.state === "superseded") throw new Error(`Owner alert ${id} is already terminal.`); record.state = "resolved"; record.resolution = { by, reason: required(input.reason, "resolution reason"), at: time(input.now) }; await atomicYaml(ownerAlertFile(root, id), record); }
