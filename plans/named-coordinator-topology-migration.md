# Named coordinator topology migration

## Acceptance identity

`acc:flow:E001-UNIT-001` is the isolated-Desk acceptance for the explicit
`project migrate-named-coordinator-topology` command. It proves that an existing
project can migrate only its generic coordinator role policy after the caller
supplies the exact remote `main` baseline.

## Boundary

The command is policy-only. It validates the remote baseline and configured
repository/worktree root before one atomic project-policy write. It preserves
legacy `coordinator@{project}` seat history and creates no seat, task, branch,
worktree, runtime, or consumer mutation. It refuses malformed, missing,
non-remote, or locally unavailable baselines; absent project configuration;
and named/generic seat, branch, or worktree collisions without side effects.

## RED witness

`tests/named-coordinator-topology-migration.test.ts` carries
`test:flow:named-coordinator-topology-migration:E001-UNIT-001` and asserts the
command contract and every refusal boundary from this acceptance. The test is
executes the supported command without touching a live Desk or consumer repository.
