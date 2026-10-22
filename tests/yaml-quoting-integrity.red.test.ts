// URN: test:atdd-flow:yaml-quoting-integrity
// Acceptance: acc:flow:E007-UNIT-001
// Phase: UNIT
import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicYaml, readYaml, yaml } from "../src/core";
import { init, initProject, spawn } from "../src/seats";
import { messages, post, startThread } from "../src/threads";

// Live body from the REC-JEV addendum that broke a whole thread Desk-wide.
const recJevBody = "REC-JEV addendum (records only). Fold the synthesis addendum M-20261021T134843Z into your phase-R record updates:\n- jev-15-profile-findings-reduction and the held ledger review record the corrected 40 = 16/3/21.\n- U22-U25 reopen as work (pending the C1 confirmation requested).\n- 36 is a lower bound for audit history only.\n- The future basis is a per-finding re-measurement at the post-JEV-8 head.\nDo NOT reopen or edit the DONE task jev-bind-four-existing-acceptance-proofs; the correction will be a forward remediation task created later. No repository mutation or push.";

const hostile = [
  recJevBody,
  "word ".repeat(40) + "heading:\nnext",
  "- item: value\n# not a comment\n  indented\n\ttabbed ",
  "  leading and trailing space  \n\n\ntrailing newlines\n\n",
  "key: value\n---\n...\n&anchor *alias !tag %dir @at `tick`",
  "null", "true", "123", "~", "",
];

test("yaml.print output parses back to the exact input for hostile strings", () => {
  for (const body of hostile) {
    const record = { schema: "x/v1", body, nested: { list: [body, "a: b"] } };
    expect(yaml.parse(yaml.print(record))).toEqual(record);
  }
});

test("atomicYaml writes the REC-JEV body so it reads back exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-yaml-quoting-"));
  const file = join(root, "message.yaml");
  const record = { schema: "atdd-workflow/message/v1", id: "M-1", created_at: "2026-10-21T13:49:28.573Z", body: recJevBody };
  await atomicYaml(file, record);
  expect(await readYaml(file)).toEqual(record);
});

test("atomicYaml fails closed without writing when a value cannot round-trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-yaml-quoting-"));
  const file = join(root, "bad.yaml");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await expect(atomicYaml(file, { when: new Date("2026-01-01"), fn: () => 1 })).rejects.toThrow();
  await expect(atomicYaml(file, cyclic)).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
});

test("post stores the REC-JEV body and reads it back exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-yaml-quoting-"));
  await init(root, "demo", []);
  await initProject(root, "demo");
  await spawn(root, "demo", "coordinator", "main", ["--worktree", join(root, "coordinator")]);
  await spawn(root, "demo", "driver", "worker", ["--worktree", join(root, "driver")]);
  const thread = await startThread(root, ["--with", "coordinator@demo,driver.worker@demo", "--subject", "Quoting"]);
  const id = await post(root, thread, ["--from", "coordinator@demo", "--to", "driver.worker@demo", "--body", recJevBody]);
  const stored = (await messages(root, thread)).find((message) => message.id === id);
  expect(stored?.body).toBe(recJevBody);
  expect(await readFile(join(root, "threads", thread, `${id}.yaml`), "utf8")).toContain("REC-JEV");
});
