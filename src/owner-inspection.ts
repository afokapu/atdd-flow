// URN: component:atdd-flow:owner-inspection:OwnerInspection:backend:application
// Tested-By:
//   - test:atdd-flow:owner-inspection-record-lifecycle
//   - test:atdd-flow:owner-inspection-cli
// Runtime: bun
// Purpose: Flow-owned immutable owner-inspection records and their hold query

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicYaml, exists, now as workflowNow, paths, readYaml, required, seat, taskId } from "./core";

/**
 * Flow-owned owner-inspection records (docs/owner-inspection-shared-contract.adoc).
 * A record stores references and digests only; it never copies artifact contents.
 * Acknowledgements are append-only files beside the record, so the record is write-once.
 */
type Reference = { kind: string; locator: string; sha256: string };
type NotApplicable = { na: true; rationale: string; evidence: Reference };
type Stage = "candidate" | "merge";
export type OwnerInspectionPacket = {
  id: string;
  stage: Stage;
  candidate?: string;
  parent: { project: string; task: string };
  owner: string;
  surface: { kind: string; name: string };
  scenario: string;
  data_classification: string;
  target: { kind: string; locator: string };
  provenance: { task: string; pr?: string; commit: string };
  evidence: { health: Reference; smoke: Reference; teardown: Reference; rendered: Reference | NotApplicable };
};
type Acknowledgement = { schema: "atdd-workflow/owner-inspection-ack/v1"; immutable: true; inspection: string; sequence: number; by: "operator@desk"; note: string; at: string };
export type OwnerInspectionRecord = OwnerInspectionPacket & {
  schema: "atdd-workflow/owner-inspection/v1";
  published_by: string;
  published_at: string;
  acknowledgements?: Acknowledgement[];
};

const operatorAddress = "operator@desk";
const naEvidenceKinds = ["ci", "ratchet", "package"];
const targetKinds = ["local", "sandbox", "preview"];
const referenceKeys = ["kind", "locator", "sha256"];

const inspectionRoot = (root: string) => join(root, ".atdd-flow", "owner-inspections");
export const ownerInspectionFile = (root: string, id: string) => join(inspectionRoot(root), `${taskId(id)}.yaml`);
const ackRoot = (root: string, id: string) => join(inspectionRoot(root), "acks", taskId(id));

// Whitespace-only text counts as missing, so a blank field is a named negative rather than an inferred value.
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function field<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`Owner inspection packet requires ${name}.`);
  return value;
}

function textField(value: unknown, name: string) {
  if (!isText(value)) throw new Error(`Owner inspection packet requires ${name}.`);
  return value;
}

function objectField(value: unknown, name: string) {
  if (!isObject(value)) throw new Error(`Owner inspection packet requires ${name}.`);
  return value;
}

// A reference is exactly kind, locator, and digest; any other key could smuggle artifact contents into Flow state.
function reference(value: unknown, name: string): Reference {
  const entry = objectField(value, name);
  const extra = Object.keys(entry).filter((key) => !referenceKeys.includes(key));
  if (extra.length) throw new Error(`${name} must be a reference (kind, locator, sha256) and may not carry content: ${extra.join(", ")}.`);
  if (!/^[a-f0-9]{64}$/.test(String(entry.sha256))) throw new Error(`${name} requires a sha256 digest reference.`);
  return { kind: textField(entry.kind, `${name}.kind`), locator: textField(entry.locator, `${name}.locator`), sha256: String(entry.sha256) };
}

// N/A is a narrow exception: only a toolkit-only surface, and only with a rationale plus direct CI, ratchet, or package evidence.
function notApplicable(entry: Record<string, unknown>, surfaceKind: string): NotApplicable {
  if (surfaceKind !== "toolkit") throw new Error("Rendered evidence may state N/A only for a toolkit-only surface.");
  const rationale = textField(entry.rationale, "evidence.rendered N/A rationale");
  const evidence = reference(entry.evidence, "evidence.rendered N/A evidence");
  if (!naEvidenceKinds.includes(evidence.kind)) throw new Error("N/A rendered evidence must be direct CI, ratchet, or package evidence.");
  return { na: true, rationale, evidence };
}

function rendered(value: unknown, surfaceKind: string) {
  const entry = objectField(value, "evidence.rendered");
  return entry.na === true ? notApplicable(entry, surfaceKind) : reference(entry, "evidence.rendered");
}

// Targets are always explicit and non-production; Flow never generates a URL or infers a preview.
function target(value: unknown) {
  const entry = objectField(value, "target");
  const kind = textField(entry.kind, "target.kind");
  if (/prod/i.test(kind)) throw new Error("A production target is never permitted for an owner inspection.");
  if (!targetKinds.includes(kind)) throw new Error(`Owner inspection target kind must be one of ${targetKinds.join(", ")}.`);
  if (!isText(entry.locator)) throw new Error(`Owner inspection requires an explicit ${kind} target locator; an implicit preview is not permitted.`);
  return { kind, locator: entry.locator };
}

function provenance(value: unknown) {
  const entry = objectField(value, "provenance");
  if (!/^[a-f0-9]{40}$/.test(String(entry.commit))) throw new Error("Owner inspection provenance requires a 40-hex commit.");
  return { task: textField(entry.task, "provenance.task"), ...(isText(entry.pr) ? { pr: entry.pr } : {}), commit: String(entry.commit) };
}

function stage(value: unknown): Stage {
  if (value !== "candidate" && value !== "merge") throw new Error(`Owner inspection stage must be candidate or merge, not ${String(value)}.`);
  return value;
}

// Validates the whole packet and returns only the known fields, so unknown keys never reach the record.
function normalize(raw: unknown): OwnerInspectionPacket {
  const entry = objectField(raw, "packet");
  const surface = objectField(entry.surface, "surface");
  const parent = objectField(entry.parent, "parent");
  const evidence = objectField(entry.evidence, "evidence");
  const surfaceKind = textField(surface.kind, "surface.kind");
  const packetStage = stage(entry.stage);
  return {
    id: taskId(textField(entry.id, "id")),
    stage: packetStage,
    ...(packetStage === "merge" ? { candidate: taskId(textField(entry.candidate, "candidate")) } : {}),
    parent: { project: textField(parent.project, "parent.project"), task: taskId(textField(parent.task, "parent.task")) },
    owner: textField(entry.owner, "owner"),
    surface: { kind: surfaceKind, name: textField(surface.name, "surface.name") },
    scenario: textField(entry.scenario, "scenario"),
    data_classification: textField(entry.data_classification, "data_classification"),
    target: target(entry.target),
    provenance: provenance(entry.provenance),
    evidence: {
      health: reference(field(evidence.health, "evidence.health"), "evidence.health"),
      smoke: reference(field(evidence.smoke, "evidence.smoke"), "evidence.smoke"),
      teardown: reference(field(evidence.teardown, "evidence.teardown"), "evidence.teardown"),
      rendered: rendered(field(evidence.rendered, "evidence.rendered"), surfaceKind),
    },
  };
}

// Publishing needs a real seat; the operator seat is reserved for acknowledgement so it cannot self-approve its own packet.
async function assertPublisher(root: string, by: string) {
  const actor = await seat(root, by).catch(() => undefined);
  if (!actor || actor.role === "operator") throw new Error(`Owner inspection records are published by an existing non-operator seat, not ${by}.`);
}

async function assertParentTask(root: string, packet: OwnerInspectionPacket) {
  if (!await exists(paths(root).taskFile(packet.parent.project, packet.parent.task))) {
    throw new Error(`Owner inspection parent task does not exist: ${packet.parent.project}/${packet.parent.task}.`);
  }
}

// A merge inspection must cite a published candidate inspection, which keeps candidate and merge provenance linked.
async function assertCandidate(root: string, packet: OwnerInspectionPacket) {
  if (packet.stage !== "merge") return;
  const cited = await readStored(root, packet.candidate!).catch(() => undefined);
  if (!cited || cited.stage !== "candidate") throw new Error(`A merge inspection requires a published candidate record: ${packet.candidate}.`);
}

async function readStored(root: string, id: string) {
  return readYaml<OwnerInspectionRecord>(ownerInspectionFile(root, id));
}

const packetOf = (record: OwnerInspectionRecord): OwnerInspectionPacket => {
  const { schema: _schema, published_by: _by, published_at: _at, acknowledgements: _acks, ...packet } = record;
  return packet;
};

/** Publishes one write-once record; an identical republish is idempotent and a changed one is rejected. */
export async function publishOwnerInspection(root: string, raw: unknown, input: { by: string; now?: string }) {
  await assertPublisher(root, input.by);
  const packet = normalize(raw);
  await assertParentTask(root, packet);
  await assertCandidate(root, packet);
  const file = ownerInspectionFile(root, packet.id);
  if (await exists(file)) {
    if (JSON.stringify(packetOf(await readStored(root, packet.id))) !== JSON.stringify(packet)) throw new Error(`Owner inspection ${packet.id} is immutable and already published with a different payload.`);
    return { id: packet.id };
  }
  await atomicYaml(file, { schema: "atdd-workflow/owner-inspection/v1", ...packet, published_by: input.by, published_at: input.now ?? workflowNow() });
  return { id: packet.id };
}

// Acknowledgements are separate append-only files, which keeps the published record itself write-once.
async function acknowledgements(root: string, id: string): Promise<Acknowledgement[]> {
  const folder = ackRoot(root, id);
  if (!await exists(folder)) return [];
  const files = (await readdir(folder)).filter((file) => file.endsWith(".yaml")).sort();
  return Promise.all(files.map((file) => readYaml<Acknowledgement>(join(folder, file))));
}

/** Returns the stored references and provenance plus the immutable acknowledgement history. */
export async function readOwnerInspection(root: string, id: string): Promise<OwnerInspectionRecord> {
  if (!await exists(ownerInspectionFile(root, id))) throw new Error(`Owner inspection does not exist: ${id}.`);
  return { ...await readStored(root, id), acknowledgements: await acknowledgements(root, id) };
}

// Fails closed: a missing or non-operator operator@desk seat blocks acknowledgement instead of being inferred.
async function assertOperator(root: string, by: string) {
  const operator = by === operatorAddress ? await seat(root, operatorAddress).catch(() => undefined) : undefined;
  if (operator?.role !== "operator") throw new Error(`Only the available ${operatorAddress} seat may acknowledge an owner inspection.`);
}

/** Appends one immutable acknowledgement; the record itself is never rewritten. */
export async function acknowledgeOwnerInspection(root: string, id: string, input: { by: string; note: string; now?: string }) {
  await assertOperator(root, input.by);
  const note = required(input.note, "owner acknowledgement note");
  if (!await exists(ownerInspectionFile(root, id))) throw new Error(`Owner inspection does not exist: ${id}.`);
  const sequence = (await acknowledgements(root, id)).length + 1;
  const file = join(ackRoot(root, id), `${String(sequence).padStart(4, "0")}.yaml`);
  if (await exists(file)) throw new Error(`Owner inspection ${id} acknowledgement ${sequence} already exists.`);
  await atomicYaml(file, { schema: "atdd-workflow/owner-inspection-ack/v1", immutable: true, inspection: id, sequence, by: operatorAddress, note, at: input.now ?? workflowNow() });
  return { id, sequence };
}

// Reads every published record with its acknowledged flag; an empty Desk is a clean status, not an error.
async function records(root: string) {
  const folder = inspectionRoot(root);
  if (!await exists(folder)) return [];
  const files = (await readdir(folder)).filter((file) => file.endsWith(".yaml")).sort();
  return Promise.all(files.map(async (file) => {
    const record = await readYaml<OwnerInspectionRecord>(join(folder, file));
    return { record, acknowledged: (await acknowledgements(root, record.id)).length > 0 };
  }));
}

/** Advisory status for a project, or one parent task; it never mutates any task. */
export async function ownerInspectionStatus(root: string, project: string, task?: string) {
  const matching = (await records(root)).filter((entry) => entry.record.parent.project === project && (task === undefined || entry.record.parent.task === task));
  const ids = (acknowledged: boolean) => matching.filter((entry) => entry.acknowledged === acknowledged).map((entry) => entry.record.id).sort();
  return { pending: ids(false), acknowledged: ids(true) };
}

/** Records still awaiting an owner acknowledgement; the existing Flow hold seam consumes this. */
export async function pendingOwnerInspections(root: string, parent: { project: string; task: string }) {
  return (await ownerInspectionStatus(root, parent.project, parent.task)).pending;
}
