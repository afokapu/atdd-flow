# ATDD Seat

`atdd-seat` is a tiny, filesystem-first coordination tool for replaceable coding-agent seats.

The durable protocol is YAML:

- a project has seats and role templates;
- each seat has a `seat.yaml` record;
- each thread is a folder containing `thread.yaml` and immutable message YAML files;
- a multiplexer is only a live notification adapter.

No database, daemon, cloud account, or model-provider SDK is required.

## Quick start

```sh
bun run src/seat.ts init demo
cd demo
bun /path/to/atdd-seat/src/seat.ts spawn coordinator main --worktree /src/demo
bun /path/to/atdd-seat/src/seat.ts spawn driver runtime --worktree /src/demo-runtime
bun /path/to/atdd-seat/src/seat.ts thread start \
  --with coordinator@demo,driver.runtime@demo \
  --subject 'Runtime rollout'
bun /path/to/atdd-seat/src/seat.ts post T-... \
  --from coordinator@demo \
  --to driver.runtime@demo \
  --expects-result \
  --body 'Run the rollout checks and report the result.'
```

The operator sets `repository` and `worktree_root` in `project.yaml`. Role
templates derive driver paths from that policy; when `repository` is present,
`seat spawn` creates a missing non-main Git worktree on the role's configured
branch and base. A command-line worktree override is available for an operator
but should not be used by drivers.

`post`, `receipt`, and `result` first persist a message and only then make a
best-effort notification through the configured backend. A missed notification
cannot lose the message; `status` and a future seat launch can rediscover it.

## Layout

```text
project.yaml
seats/<address>/seat.yaml
threads/<thread-id>/thread.yaml
threads/<thread-id>/<message-id>.yaml
```

`to: all` means all current thread participants. A specific `to` list controls
who is notified; every participant can still inspect the canonical thread.

## Scope of this first version

The first version handles local filesystems, deterministic addressing, threads,
receipts/results, status derivation, seat spawning, runtime binding, and simple
tmux/Herdr/TUIOS notification adapters. It deliberately does not run a daemon,
poll for retries, synchronize across machines, or provide a browser UI.
