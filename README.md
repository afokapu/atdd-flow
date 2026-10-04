# ATDD Workflow

`atdd-workflow` is a tiny, filesystem-first coordination tool for replaceable coding-agent seats and tasks. Its durable data lives in a private coordination repository, separate from the code repositories it coordinates.

The durable protocol is YAML. A site is independent from the code repositories and worktrees it coordinates. TUIOS is the primary live application: it provides the operator's pane layout and queues a file-reading notification when a message arrives.

No database, daemon, cloud account, or model-provider SDK is required.

## Layout

```text
private-work-coordination/
├── coordination.yaml
├── work/
│   └── resolver-os/
│       ├── project.yaml
│       ├── seats/
│           └── driver.runtime/
│               ├── seat.yaml
│               └── checkpoint.yaml
│       └── tasks/
│           └── W-runtime-rollout.yaml
└── threads/
    └── T-<id>/
        ├── thread.yaml
        └── M-<id>.yaml
```

`work/` is the responsibility view: a project's repository/worktree policy and its seats. `threads/` is the shared communication view, including cross-project threads. Messages are immutable YAML files; a seat's inbox is derived from threads addressed to it, rather than copied into per-seat folders.

Each seat may carry a one-line `purpose`, set with `atdd-workflow describe <address> --purpose <text>`. It is the human and agent-readable responsibility statement; it does not presume a fixed lane, branch, worktree, or host.

`coordination.yaml` may also declare address aliases when a project is consolidated or renamed. Aliases resolve at the CLI boundary; threads and checkpoints retain the canonical address, so a legacy name never creates a second seat.

`project.yaml` can describe optional named scopes—such as independent coordinator responsibilities within one repository—and their legacy aliases. A scope is explanatory metadata, not a lane system: it does not impose a branch, worktree, or lifecycle on a seat.

## Tasks

A task is a project-level YAML file, independent of seats and threads. It names its coordinator and optional assignee; a seat's task view is derived from those references. Tasks move through four deliberately small states:

```text
todo → in_progress → review → done
```

The driver starts a task, fills the proof beside each `done_when` criterion, and submits it for review. Only its coordinator can mark it done; a review can instead be returned to `in_progress`. Dependencies are task-local: a task starts only after every `depends_on` task is done. Tasks without unfinished dependencies are parallel-ready.

When a driver has no remaining unfinished tasks, its coordinator may make housekeeping the final layer of completion with `task done --retire-assignee`. Workflow delegates this to `atdd-bun worktree finish --delete-branch` in that driver's worktree. ATDD Bun verifies that the linked worktree is clean and its branch is merged, removes the worktree, and deletes the local branch; any failure leaves the task in review and checkpoints the seat as blocked. Remote branches are intentionally retained because ATDD Bun's finish operation does not delete them.

```sh
atdd-workflow task add resolver-os W-runtime \
  --title 'Complete runtime rollout' \
  --coordinator coordinator@resolver-os \
  --assignee driver.runtime@resolver-os \
  --body 'Deliver the bounded runtime rollout.' \
  --done-when 'Required checks pass' \
  --done-when 'Coordinator accepts the result'
atdd-workflow task start resolver-os W-runtime --by driver.runtime@resolver-os
atdd-workflow task prove resolver-os W-runtime --by driver.runtime@resolver-os --item 1 --proof 'CI run 42: passed'
atdd-workflow task review resolver-os W-runtime --by driver.runtime@resolver-os
atdd-workflow task done resolver-os W-runtime --by coordinator@resolver-os
```

An item is effectively checked when its `proof` is present. Proof is a short durable reference—a PR, CI run, report, commit range, deployment, or thread message—not a new evidence database. The task body carries the full brief and can point to its source document. A thread may optionally link a task, but one is not created automatically for every task.

## Bootstrap a coordination repository

The operator creates this repository once—not a coordinator or driver during ordinary work. Give it a name that describes its trust boundary, not the tool: for example, `private-work-coordination` or `client-a-coordination`. Start with one repository for projects that need to coordinate together. Create another only for a different operator, access boundary, or retention policy; cross-repository threads are deliberately not a v1 feature.

```sh
atdd-workflow init ~/Github/private-work-coordination --git
cd ~/Github/private-work-coordination
git add . && git commit -m 'chore: initialize coordination repository'
gh repo create afokapu/private-work-coordination --private --source . --remote origin --push
```

The Git repository is the local and remote history. The tool writes YAML; Git records, syncs, and restores it. Agents do not create or choose the repository. The operator supplies its path through the host configuration or each agent's launch environment:

```sh
export ATDD_WORKFLOW_ROOT="$HOME/Github/private-work-coordination"
atdd-workflow status
# Equivalent for a one-off invocation:
atdd-workflow --root ~/Github/private-work-coordination status
```

## Use from a code repository

Install the CLI once as a development dependency in each coordinated code repository. Every agent working from that checkout then uses the same version; individual agents do not install their own copy.

```sh
bun add -d @afokapu/atdd-workflow
bunx atdd-workflow --root ~/Github/private-work-coordination status
```

Your TUIOS, tmux, Herdr, ChatGPT Desktop, or Claude launch arrangement should set `ATDD_WORKFLOW_ROOT` and the seat address. A live application is optional; the root path is the durable entry point.

## ATDD Bun profile

When the code repository also uses ATDD Bun, add the optional `workflow` profile after both packages are installed:

```yaml
# atdd-bun.yaml
profiles: [planner, coder, tester, traceability, security, workflow]
```

ATDD Bun remains the sole owner of `AGENTS.md` and `CLAUDE.md`. Its managed instruction block selects the `workflow` registry, which points to this package's lifecycle convention. That convention teaches drivers and coordinators to use the durable seat, task, thread, proof, review, handoff, and safe-retirement protocol; it does not create another agent file or a separate skill loader.

## Releases

Every package change merged to `main` runs tests, selects the next patch version, publishes `@afokapu/atdd-workflow` with provenance, commits that version, and tags it.

Configure npm trusted publishing for `afokapu/atdd-workflow` with GitHub repository `afokapu/atdd-workflow`, workflow filename `publish.yml`, and permission to run `npm publish`. Every eligible merge to `main` then publishes through short-lived GitHub OIDC credentials; no NPM token or repository variable is stored.

## First project

```sh
atdd-workflow project init resolver-os
atdd-workflow spawn resolver-os coordinator main --worktree /src/resolver-os
atdd-workflow spawn resolver-os driver runtime --worktree /src/resolver-os-runtime
atdd-workflow thread start \
  --with coordinator@resolver-os,driver.runtime@resolver-os \
  --subject 'Runtime rollout'
atdd-workflow post T-... \
  --from coordinator@resolver-os \
  --to driver.runtime@resolver-os \
  --expects-result \
  --body 'Run the rollout checks and report the result.'
```

The operator sets `repository` and `worktree_root` in `work/<project>/project.yaml`. Role templates derive driver paths from that policy; when `repository` is present, `atdd-workflow spawn` creates a missing non-main Git worktree on the role's configured branch and base. A command-line worktree override is available for an operator but should not be used by drivers.

`post`, `receipt`, and `result` first persist a message and only then make a best-effort notification through the configured application adapter. A missed notification cannot lose the message; `status` and a future seat launch can rediscover it.

## Host integration

TUIOS is the intended interactive application. A runtime binding names the active `application` and preserves an opaque native address for every application in which that seat has been hosted. The durable seat never depends on any of them. A posted message is queued as a concise instruction to read its durable YAML file when the active application has an adapter.

```yaml
runtime:
  application: herdr # the currently active application
  addresses:
    herdr: w89e05ef9ff16:p2f1de975e7b0
    tuios: decision-os-runtime/driver-runtime
    tmux: workflow:2.1
```

Each value is owned by its application, not parsed as a Workflow identifier. Herdr uses its opaque pane locator such as `w…:p…`; tmux uses its normal target-pane syntax; TUIOS uses `session/window`, because its queue command requires both native values. Binding an address never erases addresses already recorded for other applications. The active application selects which bridge receives new-message notifications.

The built-in notification bridges are TUIOS, Herdr, and tmux. You may also record a native ChatGPT Desktop, Claude Desktop, or future host address now; without a matching bridge, Workflow still persists the message and its handoff state but does not attempt a live wake-up.

```sh
atdd-workflow bind driver.runtime@decision-os \
  --application herdr \
  --address w89e05ef9ff16:p2f1de975e7b0
atdd-workflow bind driver.runtime@decision-os \
  --application tuios \
  --address decision-os-runtime/driver-runtime
atdd-workflow application use driver.runtime@decision-os herdr
```

When the command runs inside a supported host, use deterministic discovery instead of copying an address yourself:

```sh
atdd-workflow attach driver.runtime@decision-os --application herdr
```

`attach` reads the host's own process metadata (`HERDR_PANE_ID`, `TMUX_PANE`, or the TUIOS session/window IDs), binds that native address, and makes that application active. It never infers an address from a pane title or whichever UI pane currently has focus.

To create a new live pane, placement is mandatory. It is separate from the pane's later runtime address: it says where the host must create the pane, while the newly returned native address says which pane was created. The initial launcher supports TUIOS explicitly and never falls back to the active session.

```sh
atdd-workflow launch driver.runtime@decision-os \
  --application tuios \
  --placement decision-os
```

`launch` reads the seat's declared worktree and agent, opens the pane with `tuios -s decision-os --cwd <seat-worktree>`, passes `ATDD_WORKFLOW_ROOT` and `ATDD_WORKFLOW_SEAT` into the agent process, binds the new pane address, and queues the instruction to open the seat. Herdr and tmux may still attach to pre-existing panes; their launch adapters will be added only after their creation interfaces are verified for the host in use.

The filesystem protocol does not depend on a multiplexer. An agent hosted elsewhere can participate when it has filesystem and shell access and is started with its seat address and the `atdd-workflow` CLI. Without a host adapter capable of injecting a notification, the seat remains correct and recoverable but has no automatic live wake-up; the host or operator must supply the prompt to inspect the seat.

## Checkpoints

`checkpoint.yaml` is one compact answer to “where is this seat now?” It is not a progress log and is not updated for ordinary commits, messages, or every merge. The current seat holder updates it at meaningful responsibility transitions: accepting or replanning work, becoming blocked, opening or closing a PR when that changes the next action, deployment/approval decisions, and always before a planned handover or rate-limit replacement.

The holder writes it with `atdd-workflow checkpoint`; a coordinator may write it when assigning or formally taking over a seat. A merge requires an update only when it changes ownership, the remaining work, or the next action. The thread history keeps the detail; the checkpoint stays short enough for a replacement agent to read first.

Use `status: unverified` for imported or recovered records until the current host, worktree, and responsibility have been reconciled. Historical handoff text alone is not evidence that a seat is still active.

## Scope of this first version

The first version handles local filesystems, deterministic addressing, project tasks and dependencies, shared threads, receipts/results, status derivation, seat spawning, runtime binding, and simple tmux/Herdr/TUIOS notification adapters. It deliberately does not run a daemon, poll for retries, synchronize across machines, or provide a browser UI.
