// URN: test:flow:adoption-authorizations:E016-UNIT-001
// Acceptance: acc:flow:E016-UNIT-001
// Phase: UNIT
// Layer: unit
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactSessionAdoptionAuthorization, resolveExactSessionAdoptionAuthorization } from "../src/adoption-authorizations";
import { atomicYaml, readYaml } from "../src/core";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const expected = {
  seat: "driver.x@demo", pi_session: "01a12345", pi_session_path: "/s/a.jsonl",
  source: { herdr_session: "legacy", pane: "w1:p1" }, target: { herdr_session: "forge", pane: "w1:p2", cwd: "/work/demo" },
};

async function issue(id = "A-one") {
  const root = await mkdtemp(join(tmpdir(), "atdd-adoption-authorization-"));
  roots.push(root);
  await createExactSessionAdoptionAuthorization(root, id, [
    "--by", "operator@desk", "--seat", expected.seat, "--pi-session", expected.pi_session, "--pi-session-path", expected.pi_session_path,
    "--source-herdr-session", "legacy", "--source-pane", "w1:p1", "--target-herdr-session", "forge", "--target-pane", "w1:p2", "--target-cwd", "/work/demo",
  ]);
  return { root, file: join(root, ".atdd-flow", "exact-session-adoption-authorizations", `${id}.yaml`), hash: join(root, ".atdd-flow", "exact-session-adoption-authorizations", `${id}.sha256`) };
}

/** Runs the repo-local strict metrics sensor (CI has no global atdd-bun on PATH) from the repository root and returns its finding lines. */
async function metricsFindings() {
  const repository = join(import.meta.dir, "..");
  const environment: Record<string, string | undefined> = { ...process.env };
  delete environment.ATDD_WORKFLOW_ROOT;
  delete environment.ATDD_WORKFLOW_SEAT;
  const child = Bun.spawn([join(repository, "node_modules", ".bin", "atdd-bun"), "metrics"], { cwd: repository, env: environment as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  const output = `${out}\n${err}`;
  expect(output).not.toContain("INTEGRITY VIOLATION");
  return output.split("\n").filter((line) => line.includes("src/adoption-authorizations.ts"));
}

test("strict metrics report no finding for src/adoption-authorizations.ts", async () => {
  expect(await metricsFindings()).toEqual([]);
});

test("a valid authorization resolves to its id and stored hash", async () => {
  const { root } = await issue();
  const resolved = await resolveExactSessionAdoptionAuthorization(root, "A-one", expected);
  expect(resolved.id).toBe("A-one");
  expect(resolved.hash).toMatch(/^[a-f0-9]{64}$/);
});

test("resolution keeps its exact error messages in their original check order", async () => {
  await expect(resolveExactSessionAdoptionAuthorization("/nowhere", "bad id", expected)).rejects.toThrow("requires an immutable operator authorization record id.");
  await expect(resolveExactSessionAdoptionAuthorization("/nowhere", "A-missing", expected)).rejects.toThrow("requires an existing immutable operator authorization record.");

  const malformed = await issue();
  await writeFile(malformed.file, "key: [unterminated\n");
  await expect(resolveExactSessionAdoptionAuthorization(malformed.root, "A-one", expected)).rejects.toThrow("requires a well-formed immutable operator authorization record.");

  const unhashed = await issue();
  await rm(unhashed.hash);
  await expect(resolveExactSessionAdoptionAuthorization(unhashed.root, "A-one", expected)).rejects.toThrow("requires a create-only immutable operator authorization record.");

  const tampered = await issue();
  await atomicYaml(tampered.file, { ...(await readYaml<Record<string, unknown>>(tampered.file)), seat: "driver.other@demo" });
  await expect(resolveExactSessionAdoptionAuthorization(tampered.root, "A-one", expected)).rejects.toThrow("requires an immutable operator authorization record.");

  const mismatch = await issue();
  await expect(resolveExactSessionAdoptionAuthorization(mismatch.root, "A-one", { ...expected, target: { ...expected.target, pane: "w9:p9" } })).rejects.toThrow("bound to the exact adoption tuple");

  const reused = await issue();
  await mkdir(join(reused.root, ".atdd-flow", "runtime-launch"), { recursive: true });
  await atomicYaml(join(reused.root, ".atdd-flow", "runtime-launch", "r.yaml"), { relocation: { authorization: { id: "A-one" } } });
  await expect(resolveExactSessionAdoptionAuthorization(reused.root, "A-one", expected)).rejects.toThrow("was already used");
});
