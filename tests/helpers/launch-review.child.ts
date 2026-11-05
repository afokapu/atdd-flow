// Test helper: runs launchBehavioralReview in a child whose PATH the parent controls, and reports the outcome as JSON.
import { launchBehavioralReview } from "../../src/reviews";

const [desk] = process.argv.slice(2);
try {
  await launchBehavioralReview(desk!, "demo", "delivery", ["--by", "coordinator@demo", "--application", "herdr", "--placement", "none"]);
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, name: (error as Error).name, message: (error as Error).message }));
}
