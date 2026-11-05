// URN: component:flow:e024:launch-review-child:backend:integration
// Tested-By:
// - test:flow:pinned-atdd-bun-resolution:E024-UNIT-001
// Runtime: bun
// Purpose: Test child that runs launchBehavioralReview under a caller-controlled PATH.

// Test helper: runs launchBehavioralReview in a child whose PATH the parent controls, and reports the outcome as JSON.
import { launchBehavioralReview } from "../../src/reviews";

const [desk] = process.argv.slice(2);
try {
  await launchBehavioralReview(desk!, "demo", "delivery", ["--by", "coordinator@demo", "--application", "herdr", "--placement", "none"]);
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, name: (error as Error).name, message: (error as Error).message })}\n`);
}
