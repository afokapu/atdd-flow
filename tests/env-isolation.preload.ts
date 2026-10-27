// Test isolation: a test run must never inherit the live Desk location from a driver pane.
// Runs before any test file loads; child processes spawned by tests inherit the cleaned environment.
delete process.env.ATDD_WORKFLOW_ROOT;
delete process.env.ATDD_WORKFLOW_SEAT;
// Fleet wake waits are bounded by this variable; fixtures that never answer must fail inside the default test timeout.
process.env.ATDD_FLOW_WAKE_TIMEOUT_MS = "250";
