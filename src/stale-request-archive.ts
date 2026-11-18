// URN: component:flow:e005:stale-request-archive:backend:integration
// Tested-By:
// - test:atdd-flow:patha-stale-request-archive
// Runtime: bun
// Purpose: Create-only hash archive and rollback for an inert stale Path-A request.

import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { exists, yaml } from "./core";
import type { HandoverReplacementDependencies, HandoverReplacementRequest } from "./handover";

const staleArchiveSchema = "atdd-flow/context-handover-replacement-stale-archive/v1";
export const staleArchivePath = (root: string, resolved: string, hash: string) => join(root, ".atdd-flow", "handover-replacement-stale-archive", encodeURIComponent(resolved), hash);

/** The archive records only the inert prior request, so an identical copy stays valid evidence for any retry. */
export function staleArchiveManifest(resolved: string, file: string, stale: { request: HandoverReplacementRequest; hash: string }) {
  const { request } = stale;
  return yaml.print({
    schema: staleArchiveSchema, seat: resolved,
    prior_request: { path: file, sha256: stale.hash, task: request.task, handover: request.handover.id, handover_sha256: request.handover.sha256, authorization: request.authorization },
  });
}

async function staleArchiveMatches(destination: string, bytes: string, manifest: string) {
  try {
    const [files, request, proof] = await Promise.all([readdir(destination), readFile(join(destination, "request.yaml"), "utf8"), readFile(join(destination, "archive.yaml"), "utf8")]);
    return files.sort().join("\n") === "archive.yaml\nrequest.yaml" && request === bytes && proof === manifest;
  } catch { return false; }
}
export type StaleArchiveTransaction = { archiveStage: string; successorStage: string; publishAttempted: boolean; archiveExisted: boolean; swapAttempted: boolean; parentExisted: boolean };

export async function stageStaleArchive(file: string, archive: string, bytes: string, manifest: string, successor: string, dependencies: HandoverReplacementDependencies) {
  const archiveStage = join(dirname(archive), `.${basename(archive)}.${crypto.randomUUID()}.tmp`), successorStage = join(dirname(file), `.${basename(file)}.${crypto.randomUUID()}.tmp`);
  const parentExisted = await exists(dirname(archive));
  await mkdir(dirname(archive), { recursive: true });
  const transaction: StaleArchiveTransaction = { archiveStage, successorStage, publishAttempted: false, archiveExisted: await exists(archive), swapAttempted: false, parentExisted };
  try {
    await mkdir(archiveStage);
    await Promise.all([
      writeFile(join(archiveStage, "request.yaml"), bytes, { encoding: "utf8", flag: "wx" }), writeFile(join(archiveStage, "archive.yaml"), manifest, { encoding: "utf8", flag: "wx" }),
      dependencies.publish ? dependencies.publish(successorStage, successor) : writeFile(successorStage, successor, { encoding: "utf8", flag: "wx" }),
    ]);
  } catch (error) { await discardStaleArchiveStages(transaction); await removeCreatedArchiveParent(transaction, archive); throw error; }
  return transaction;
}

export async function discardStaleArchiveStages(transaction: StaleArchiveTransaction) {
  await rm(transaction.archiveStage, { recursive: true, force: true });
  await rm(transaction.successorStage, { force: true });
}

/** Remove the per-seat archive folder only when this attempt created it and nothing was published into it. */
async function removeCreatedArchiveParent(transaction: StaleArchiveTransaction, archive: string) {
  if (transaction.parentExisted) return;
  await rmdir(dirname(archive)).catch(() => undefined);
}

export async function publishStaleArchive(transaction: StaleArchiveTransaction, archive: string, bytes: string, manifest: string, dependencies: HandoverReplacementDependencies) {
  if (!transaction.archiveExisted) {
    transaction.publishAttempted = true;
    await (dependencies.publishArchive ?? rename)(transaction.archiveStage, archive);
  }
  if (!await staleArchiveMatches(archive, bytes, manifest)) throw new Error("Stale Path-A request archive collides with different immutable evidence.");
}

export async function rollbackStaleArchive(file: string, archive: string, bytes: string, transaction: StaleArchiveTransaction | undefined, restoreActive: (file: string, bytes: string) => Promise<void>) {
  if (!transaction) return;
  if (transaction.swapAttempted) await restoreActive(file, bytes);
  if (transaction.publishAttempted && !transaction.archiveExisted) await rm(archive, { recursive: true, force: true });
  await discardStaleArchiveStages(transaction);
  await removeCreatedArchiveParent(transaction, archive);
}

