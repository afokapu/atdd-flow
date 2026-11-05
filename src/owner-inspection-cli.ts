// URN: component:atdd-flow:owner-inspection:OwnerInspectionCli:backend:application
// Tested-By:
//   - test:atdd-flow:owner-inspection-record-lifecycle
//   - test:atdd-flow:owner-inspection-cli
// Runtime: bun
// Purpose: Command handler for `atdd-flow owner-inspection`

import { readFile } from "node:fs/promises";
import { required, words, yaml } from "./core";
import { acknowledgeOwnerInspection, ownerInspectionStatus, publishOwnerInspection, readOwnerInspection } from "./owner-inspection";

const usage = "Use `atdd-flow owner-inspection publish|read|ack|status ...`.";
const emit = (value: unknown) => process.stdout.write(`${yaml.print(value)}\n`);

/** Handles `atdd-flow owner-inspection publish|read|ack|status`; Flow owns every record it writes. */
export async function ownerInspectionCommand(root: string, rest: string[]) {
  const [subcommand, first, second] = rest;
  const tail = rest.slice(1);
  if (subcommand === "publish") {
    const packet = yaml.parse<unknown>(await readFile(required(words(tail, "--file"), "--file"), "utf8"));
    return emit(await publishOwnerInspection(root, packet, { by: required(words(tail, "--by"), "--by") }));
  }
  if (subcommand === "read") return emit(await readOwnerInspection(root, required(first, "inspection id")));
  if (subcommand === "ack") {
    return emit(await acknowledgeOwnerInspection(root, required(first, "inspection id"), { by: required(words(tail, "--by"), "--by"), note: required(words(tail, "--note"), "--note") }));
  }
  if (subcommand === "status") return emit(await ownerInspectionStatus(root, required(first, "project"), second));
  throw new Error(usage);
}
