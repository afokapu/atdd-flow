// URN: test:atdd-flow:seat-rename-continuity
// Acceptance: acc:flow:E028-UNIT-001
// Phase: UNIT
// Purpose: A seat renamed through a Desk alias keeps its existing thread participation under its new address.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, paths } from "../src/core";
import { messages, pendingResponders, post, receipt, result, startThread, threadsForSeat } from "../src/threads";

const roots: string[] = [];
const oldName = "coordinator.old@demo", newName = "coordinator.new@demo", main = "main@demo";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function seatFile(root: string, address: string, role: string) {
  await atomicYaml(paths(root).seatFile(address), { schema: "atdd-workflow/seat/v2", address, role, project: "demo", worktree: "/work/demo", branch: role === "main" ? "main" : "integration/x" });
}

/** A thread opened and answered under the old name, then the seat is renamed by alias. */
async function fixture(renamed = true) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-rename-"));
  roots.push(root);
  await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr" });
  await atomicYaml(paths(root).projectFile("demo"), { schema: "atdd-workflow/project/v1", project: "demo", roles: {} });
  await seatFile(root, main, "main");
  await seatFile(root, oldName, "coordinator");
  const threadId = await startThread(root, ["--with", `${main},${oldName}`, "--subject", "Rename continuity"]);
  const asked = await post(root, threadId, ["--from", main, "--to", oldName, "--body", "please answer", "--expects-result"]);
  const threadBefore = await readFile(paths(root).threadFile(threadId), "utf8");
  await atomicYaml(paths(root).seatFile(newName), { schema: "atdd-workflow/seat/v2", address: newName, role: "coordinator", project: "demo", worktree: "/work/demo", branch: "integration/x" });
  if (renamed) await atomicYaml(paths(root).desk, { schema: "atdd-workflow/desk/v1", desk: "demo", application: "herdr", aliases: { [oldName]: newName } });
  return { root, threadId, asked, threadBefore };
}

test("RED: the renamed seat answers a result requested of its old address", async () => {
  const { root, threadId, asked } = await fixture();
  await receipt(root, threadId, asked, ["--from", newName]);
  const answered = await result(root, threadId, asked, ["--from", newName, "--body", "done"]);
  const all = await messages(root, threadId);
  expect(all.find((message) => message.id === answered)?.from).toBe(newName);
  const request = all.find((message) => message.id === asked)!;
  expect(pendingResponders([main, newName], all, request)).toEqual([]);
});

test("RED: the renamed seat posts to the existing thread and either address reaches it", async () => {
  const { root, threadId } = await fixture();
  await post(root, threadId, ["--from", newName, "--to", main, "--body", "new name speaking"]);
  const viaOld = await post(root, threadId, ["--from", main, "--to", oldName, "--body", "addressed to the old name"]);
  const viaNew = await post(root, threadId, ["--from", main, "--to", newName, "--body", "addressed to the new name"]);
  const all = await messages(root, threadId);
  expect(all.find((message) => message.id === viaOld)?.to).toEqual([newName]);
  expect(all.find((message) => message.id === viaNew)?.to).toEqual([newName]);
});

test("RED: thread lists and historical messages resolve to the new address", async () => {
  const { root, threadId, asked } = await fixture();
  expect((await threadsForSeat(root, newName)).map((entry) => entry.threadId)).toContain(threadId);
  expect((await threadsForSeat(root, oldName)).map((entry) => entry.threadId)).toContain(threadId);
  const record = (await threadsForSeat(root, newName)).find((entry) => entry.threadId === threadId)!.record;
  expect(record.participants.sort()).toEqual([main, newName].sort());
  expect((await messages(root, threadId)).find((message) => message.id === asked)?.to).toEqual([newName]);
});

test("history files are never rewritten by reading or posting through the alias", async () => {
  const { root, threadId, asked, threadBefore } = await fixture();
  await post(root, threadId, ["--from", newName, "--to", main, "--body", "hello"]);
  await threadsForSeat(root, newName);
  expect(await readFile(paths(root).threadFile(threadId), "utf8")).toBe(threadBefore);
  expect(await readFile(paths(root).message(threadId, asked), "utf8")).toContain(oldName);
});

test("without an alias the new address is still not a participant", async () => {
  const { root, threadId } = await fixture(false);
  await expect(post(root, threadId, ["--from", newName, "--to", main, "--body", "x"])).rejects.toThrow("not a thread participant");
});
