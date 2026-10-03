# ATDD Seat

`atdd-seat` is a tiny, filesystem-first coordination tool for replaceable coding-agent seats.

The durable protocol is YAML. A site is independent from the code repositories and worktrees it coordinates. TUIOS is the primary live host: it provides the operator's pane layout and queues a file-reading notification when a message arrives.

No database, daemon, cloud account, or model-provider SDK is required.

## Layout

```text
agent-seats/
├── site.yaml
├── work/
│   └── resolver-os/
│       ├── project.yaml
│       └── seats/
│           └── driver.runtime/
│               ├── seat.yaml
│               └── checkpoint.yaml
└── threads/
    └── T-<id>/
        ├── thread.yaml
        └── M-<id>.yaml
```

`work/` is the responsibility view: a project's repository/worktree policy and its seats. `threads/` is the shared communication view, including cross-project threads. Messages are immutable YAML files; a seat's inbox is derived from threads addressed to it, rather than copied into per-seat folders.

Each seat may carry a one-line `purpose`, set with `seat describe <address> --purpose <text>`. It is the human and agent-readable responsibility statement; it does not presume a fixed lane, branch, worktree, or host.

## Quick start

```sh
bun run src/seat.ts init ~/Github/agent-seats
cd ~/Github/agent-seats
bun /path/to/atdd-seat/src/seat.ts project init resolver-os
bun /path/to/atdd-seat/src/seat.ts spawn resolver-os coordinator main --worktree /src/resolver-os
bun /path/to/atdd-seat/src/seat.ts spawn resolver-os driver runtime --worktree /src/resolver-os-runtime
bun /path/to/atdd-seat/src/seat.ts thread start \
  --with coordinator@resolver-os,driver.runtime@resolver-os \
  --subject 'Runtime rollout'
bun /path/to/atdd-seat/src/seat.ts post T-... \
  --from coordinator@resolver-os \
  --to driver.runtime@resolver-os \
  --expects-result \
  --body 'Run the rollout checks and report the result.'
```

The operator sets `repository` and `worktree_root` in `work/<project>/project.yaml`. Role templates derive driver paths from that policy; when `repository` is present, `seat spawn` creates a missing non-main Git worktree on the role's configured branch and base. A command-line worktree override is available for an operator but should not be used by drivers.

`post`, `receipt`, and `result` first persist a message and only then make a best-effort notification through the configured backend. A missed notification cannot lose the message; `status` and a future seat launch can rediscover it.

## Host integration

TUIOS is the intended interactive host. A seat binds to a TUIOS pane, and a posted message is queued as a concise instruction to read its durable YAML file. Tmux and Herdr have small compatibility adapters with the same best-effort contract.

The filesystem protocol does not depend on a multiplexer. An agent hosted elsewhere can participate when it has filesystem and shell access and is started with its seat address and the `seat` CLI entry point. Without a host adapter capable of injecting a notification, the seat remains correct and recoverable but has no automatic live wake-up; the host or operator must supply the prompt to inspect the seat.

## Checkpoints

`checkpoint.yaml` is one compact answer to “where is this seat now?” It is not a progress log and is not updated for ordinary commits, messages, or every merge. The current seat holder updates it at meaningful responsibility transitions: accepting or replanning work, becoming blocked, opening or closing a PR when that changes the next action, deployment/approval decisions, and always before a planned handover or rate-limit replacement.

The holder writes it with `seat checkpoint`; a coordinator may write it when assigning or formally taking over a seat. A merge requires an update only when it changes ownership, the remaining work, or the next action. The thread history keeps the detail; the checkpoint stays short enough for a replacement agent to read first.

Use `status: unverified` for imported or recovered records until the current host, worktree, and responsibility have been reconciled. Historical handoff text alone is not evidence that a seat is still active.

## Scope of this first version

The first version handles local filesystems, deterministic addressing, shared threads, receipts/results, status derivation, seat spawning, runtime binding, and simple tmux/Herdr/TUIOS notification adapters. It deliberately does not run a daemon, poll for retries, synchronize across machines, or provide a browser UI.
