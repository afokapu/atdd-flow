# Explicit-baseline governed spawn

## Acceptance identity

`acc:flow:E002-RED-001` records the RED contract for task-aware driver spawn
with `--base <full-40-sha>`. The supplied commit must exist in the configured
repository and descend the responsible main or named-coordinator governed head.

## Boundary

The capability uses repository refs and objects rather than a dirty or stale
primary checkout. Dry-run reports the exact seat, delivery branch, worktree,
task, and governed base without writing any resource. Success writes only the
new target branch/worktree/seat/task assignment; it does not launch or bind a
runtime. Missing, abbreviated, unrelated, non-descendant, colliding, unready,
and partial-write paths remain atomic and side-effect-free.

## RED witness

`tests/explicit-baseline-governed-spawn.test.ts` proves the unsupported explicit
base/dry-run contract and captures the no-side-effect and exact-governed-base
acceptance before implementation.
