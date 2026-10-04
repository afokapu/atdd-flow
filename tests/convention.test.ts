import { expect, test } from "bun:test";
import { join } from "node:path";

const file = join(import.meta.dir, "..", "conventions", "atdd-workflow.workflow", "atdd-workflow.workflow.lifecycle.convention.yaml");

test("workflow lifecycle convention remains valid and carries the focus discipline", async () => {
  const convention = Bun.YAML.parse(await Bun.file(file).text()) as {
    rule_id: string;
    content: { normative_text: string };
  };
  expect(convention.rule_id).toBe("atdd-workflow.workflow.lifecycle");
  expect(convention.content.normative_text).toContain("atdd-workflow --help");
  expect(convention.content.normative_text).toContain("smallest effective change");
  expect(convention.content.normative_text).toMatch(/review-ready or\s+explicitly blocked/);
  expect(convention.content.normative_text).toContain("atdd-workflow scout");
  expect(convention.content.normative_text).toContain("atdd-workflow focus-check");
});
