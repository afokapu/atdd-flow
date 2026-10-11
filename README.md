# ATDD Workflow

`atdd-flow` is a filesystem-first control plane for coordinated coding agents. It keeps durable coordination in a separate Git-backed **Desk**, not inside the code repositories and worktrees being changed.

## The model

```text
Desk (private Git repository)             Code repositories / worktrees
├── work/<project>/                       └── implementation only
│   ├── project.yaml  policy
│   ├── seats/        replaceable responsibilities and handoffs
│   └── tasks/        delivery, criteria, and proof
└── threads/          conversation and immutable messages
```

- A **seat** owns responsibility, branch, worktree, checkpoint, and host addresses; a **task** owns its brief, ownership, dependencies, criteria, and proof.
- A **thread** owns messages, receipts, results, and decisions; a **host** owns panes and notifications—never durable state.

A stable address, such as `driver.runtime@example-app`, survives a different pane, host, model, or replacement agent. A replacement reads its durable seat, task, checkpoint, and threads rather than predecessor-private context.

Workflow is a YAML protocol and CLI—not a database, daemon, agent runtime, or task-management SaaS. Git supplies history and replication; a multiplexer may wake an agent, but never owns state.

## Install and create a Desk

Install locally in every code repository whose agents use Workflow:

```sh
bun add -d @afokapu/atdd-flow@latest
```

### Migrating from ATDD Workflow

Install `@afokapu/atdd-flow` and replace `atdd-workflow` (including `bunx atdd-workflow`) with
`atdd-flow`. Existing Desk YAML schemas and `ATDD_WORKFLOW_ROOT` remain compatible.

The operator creates one private Desk for projects that coordinate together:

```sh
atdd-flow init "$HOME/Github/desk" --git
export ATDD_WORKFLOW_ROOT="$HOME/Github/desk"
```

Use `--root "$HOME/Github/desk"` for one-off commands. Keeping the Desk separate avoids code-branch conflicts and permits cross-repository work.

### Declare launch executables once

`desk.yaml` owns the executable names that every seat may use. Give each name
an absolute command path when the host does not guarantee a shared `PATH`:

```yaml
schema: atdd-workflow/desk/v1
desk: desk
application: herdr
executables:
  pi: /opt/homebrew/bin/pi
```

The executable registry is transport configuration, not model allocation. New seats do not pin an
agent. Instead, `models.yaml` declares the launchable model portfolio in descending capability order:

```yaml
schema: atdd-workflow/models/v1
models:
  - id: pi
    executable: pi
# Add Pi --model arguments here when local policy selects a specific Pi model.
```

Order is policy: strongest first, weakest last. New Desks use Pi for every entry; add Pi `--model`
arguments when local policy selects a specific model. Entries whose executable is unavailable, or whose
`enabled` flag is false, are excluded. For ordinary phase work, Jev sees the seat's active work and
selects the weakest available configured Pi model sufficient for that responsibility. If model selection is
unavailable or low-confidence, Workflow conservatively selects the strongest available configured Pi
model. Final behavioral review has its own bounded routing step described below. Older Desks without
`models.yaml` continue to honor a legacy seat `agent` through the executable registry.

## Configure worktrees and seats

Create a project, declare its primary checkout and linked-worktree root, then adjust its policy in `work/<project>/project.yaml`:

```sh
atdd-flow project init example-app
atdd-flow project configure example-app --repository /Users/you/Github/example-app --worktree-root /Users/you/Github/worktrees/example-app
```

`project configure` sets only `repository` and `worktree_root`. It fails closed, leaving the project
unchanged, when `--repository` is not the top level of a Git repository or a flag is unknown, repeated,
or missing its value. It never changes seats, runtimes, tasks, branches, worktrees, or repository
content; it lists each seat whose recorded placement violates the topology as `unprojected`.

A misplaced seat is left unprojected: `multiplexer status` reports it under `unprojected`, and
`multiplexer apply` and launch projection of other seats continue. Projecting that seat explicitly
still rejects until its placement is corrected.

```yaml
repository: /Users/you/Github/example-app
worktree_root: /Users/you/Github/worktrees/example-app
roles:
  coordinator: { address: coordinator@{project}, branch: main, worktree: '{repository}' }
  driver: { address: driver.{name}@{project}, branch: delivery/{name}, base: main, worktree: '{worktree_root}/{name}' }
```

The operator or coordinator creates seats; drivers do not choose their policy:

```sh
atdd-flow spawn example-app coordinator main --worktree /Users/you/Github/example-app
atdd-flow spawn example-app driver runtime
```

`spawn` creates missing driver worktrees through Git: this example creates `/Users/you/Github/worktrees/example-app/runtime` on `delivery/runtime`. ATDD Bun owns safe retirement, not creation. A seat can own several tasks.

For the canonical named-coordinator topology, create an unassigned `todo` task first, then use `atdd-flow spawn <project> driver <name> --task <task-id>`. Flow derives the fresh `delivery/<name>` worktree from the task coordinator's exact `integration/<stream>` head (or `main` for `main@project`), records that commit as `governed_base`, assigns the task, and reports the integration return branch. It refuses existing seats, worktrees, or branches and invalid, dirty, stale, generic, nested, or cross-project coordinator lineage rather than reusing history.

## Deliver work

```text
todo → in_progress → review → done
```

The coordinator assigns; the driver implements, proves each criterion, and submits for review; only the coordinator marks the task done.

```sh
atdd-flow task add example-app runtime-rollout --title 'Complete runtime rollout' \
  --coordinator coordinator@example-app --assignee driver.runtime@example-app \
  --done-when 'Checks pass'
atdd-flow task start example-app runtime-rollout --by driver.runtime@example-app
atdd-flow task prove example-app runtime-rollout --by driver.runtime@example-app --item 1 --proof 'CI run 42'
atdd-flow task review example-app runtime-rollout --by driver.runtime@example-app
# An independently attached reviewer persists APPROVE, RETURN, or ESCALATE through behavioral-review record
atdd-flow task done example-app runtime-rollout --by coordinator@example-app
```

Proof is a compact PR, CI run, report, commit range, deployment, or thread reference. Dependencies gate prerequisites; independent tasks are parallel-ready. A coordinator can staff an unassigned ready task with `atdd-flow task assign <project> <task-id> --assignee <address> --by <coordinator-address>`; assignment is allowed only once while the task is `todo`. Use `task block` only for a real external blocker, then checkpoint exact state and next action. Once the blocker is resolved, only that coordinator can clear it with `atdd-flow task unblock <project> <task-id> --by <coordinator-address>` while the task remains `in_progress`. For deliveries explicitly governed by the `workflow` ATDD Bun profile, `review → done` additionally requires a durable final behavioral-review result with decision `APPROVE` for the current clean delivery commit. For an idle driver’s final task, `task done ... --retire-assignee` delegates clean-and-merged worktree retirement to ATDD Bun. A driver whose assigned tasks are all already `done` is retired with `atdd-flow seat retire <address> --by <coordinator-or-main>`, using the same checks. When every assigned task is `done` and the recorded worktree is absent from disk and from `git worktree list`, `seat retire` records the retirement without running worktree finish, deleting the branch, or recreating the worktree; a missing worktree that Git still registers fails closed. Both paths fail closed on unfinished tasks or a dirty or unmerged worktree; on success they record `retired` and a checkpoint, then close the driver's Herdr workspace when `close_inactive` is enabled. `main@<project>` may likewise retire a coordinator seat (never main, the operator, or a seat on the primary checkout) once every task it coordinates or is assigned is `done`, through the same worktree-finish, absent-and-unregistered, and fail-closed paths. Retirement runs in the seat worktree with ATDD Bun from the primary checkout's `node_modules/.bin`, else the primary checkout's own source when it is the ATDD Bun package, else `PATH`; never the seat worktree's copy, which may pin an older toolkit.

At 80% context usage a seat writes a structured handover (template and process rules in the lifecycle convention), checks it with `atdd-flow handover <address> --check --file <path>`, and records it with `atdd-flow handover <address> --file <path>`. The seat keeps one durable `handover.yaml` beside its unchanged checkpoint. Recording rejects a missing header, Runtime line, or section, sections out of order, more than 150 lines, vague references such as `latest` or `that PR` without an exact ID, and a `supersedes` value that does not match the recorded handover id. A fresh session bound to the same seat reads it with `atdd-flow handover show <address>`.

For topology normalization, transfer an active task through the narrow durable command, never by editing its YAML: `atdd-flow task transfer <project> <task-id> --to <main-or-named-coordinator> --reason <text> --by <current-coordinator>`; `main@project` must additionally pass `--authorization <operator-message-id>`. That message must be an immutable `task-transfer-authorization/v1` exact tuple for the project, task, current/target coordinator, reason, and target branch/head; only `operator@desk` creates it through `atdd-flow post --task-transfer-authorization <json>`. The command appends immutable source/target/reason/exact-head/effective-time provenance, keeps earlier phase/review/message evidence intact, derives the new governed base from the accepted target head, and never moves a seat, branch, runtime, or worktree. Same-target, duplicate, nested, mismatched, unauthorized, and manually rewritten transitions fail closed.

## Communicate and hand over

Threads are the durable inbox/outbox. Workflow persists a message before a best-effort host notification, so a closed pane, rate limit, or missed prompt cannot lose it.

```sh
atdd-flow thread start --with coordinator@example-app,driver.runtime@example-app \
  --subject 'Runtime rollout' --task example-app/runtime-rollout
atdd-flow post T-... --from coordinator@example-app --to driver.runtime@example-app \
  --label 'implementation request' --expects-result --body 'Implement the task and return proof references.'
atdd-flow result T-... M-... --from driver.runtime@example-app --label 'proof returned' --body 'CI run 42; PR #81.'
```

New durable thread and message IDs are human-readable: `T-` or `M-`, a UTC-second
stamp (`YYYYMMDDTHHMMSSZ`), a kebab-case slug, and a short random suffix, such as
`M-20261010T122049Z-rollover-review_7e5e12ab`. Thread slugs derive from `--subject`.
`post`, `receipt`, and `result` optionally accept `--label` for the message slug; it
defaults to the message kind (`message`, `receipt`, or `result`). Labels are durable
metadata, so provide only non-sensitive text. Message bodies are never used in IDs.
Existing Desk thread and message filenames retain their legacy IDs unchanged and remain
readable.

For a shared boundary: driver → coordinator → affected coordinator(s) → minimum agreement in a thread → driver. `--to all` broadcasts; requested results remain outstanding until every recipient replies. Checkpoints are short handoffs, not logs; update at responsibility transitions and before replacing an agent.

## Inspect, host, and guide agents

```sh
atdd-flow status
atdd-flow status seat driver.runtime@example-app
atdd-flow open driver.runtime@example-app
```

Herdr and tmux can notify an already attached host pane. Flow does not create host panes: the operator starts the agent in its declared worktree with `ATDD_WORKFLOW_ROOT` and `ATDD_WORKFLOW_SEAT`, then attaches that pane deterministically.

```sh
atdd-flow attach driver.runtime@example-app --application herdr
```

### Optional Herdr worktree projection

`multiplexer/herdr.yaml` is a compact, instance-free policy: it describes only primary versus linked worktree role placement. The Desk remains authoritative for projects, seats, tasks, branches, and worktrees. Herdr is an optional display/runtime projection and never becomes a second registry.

An operator must select the target session explicitly, or run from a Herdr pane that supplies `HERDR_SESSION`; Flow never chooses a Desk-wide or focused session. Status is read-only and apply uses `--no-focus`:

```sh
atdd-flow multiplexer status herdr --session forge
atdd-flow multiplexer apply herdr --session forge
# Inside a Herdr pane, the inherited HERDR_SESSION is sufficient:
atdd-flow multiplexer apply herdr
```

For each Desk project, apply reconciles the declared repository checkout as workspace `{project}` and gives every main/coordinator seat using it a tab and pane named `{seat.address}`. Linked coordinator worktrees and active drivers become linked-worktree workspaces named `{seat.address}`, with an equally named tab and pane. A driver is active only while it has an unblocked `in_progress` assigned task or a bound Herdr pane that still runs an agent; never-started, blocked, and finished drivers get no workspace. An explicit per-seat projection such as `pi runtime launch` still projects its own seat. A missing linked worktree is skipped and reported under `unprojected` instead of aborting the Desk. Unbound worktrees are ignored, and apply never focuses or guesses about other sessions.

A workspace is stale when it is labelled with a Desk driver seat address, that driver is retired or inactive, and its checkout is a linked worktree of the seat's Desk project or no longer exists. `multiplexer status` reports the `stale` count. `multiplexer apply` closes stale workspaces only when `desk.yaml` enables it:

```yaml
multiplexer:
  close_inactive: true
```

Apply never closes a stale workspace while one of its agents is `working` or `blocked`; it reports it instead. Primary, main, coordinator, operator, and unrelated workspaces are never stale. The bundled `multiplexer/herdr.yaml` policy is unchanged.

New Herdr attachments store both the inherited session and pane id. Older scalar pane bindings remain readable and use their legacy Desk session only when one exists, so a bare `w1:p1` from one session cannot be mistaken for the same pane in another newly attached session.

### Pi-native Desk mail

When Pi starts with Flow’s bundled extension, it remains a normal, interactive agent in its host pane, but the extension watches the immutable Desk mail files and wakes Pi internally with `pi.sendMessage()`—not terminal text injection.

The Pi seat records both concepts independently:

```yaml
runtime:
  application: herdr
  addresses:
    herdr: w9:p1
  model: pi
  wake: native
```

`application` identifies the visible pane. `wake: native` tells Flow not to also send a host prompt; the Pi extension reads `ATDD_WORKFLOW_ROOT` and `ATDD_WORKFLOW_SEAT`, observes final `M-*.yaml` files, filters recipients, and queues a compact follow-up containing the thread subject, sender, recipients, thread/message IDs, and `atdd-flow message read <message-id>`. It never embeds the message body. Other agents keep `wake: host` and receive the same compact notification through their normal host adapter.

Read one durable message without loading its complete thread:

```sh
atdd-flow message read M-...
```

The output includes only the message and its thread ID/subject; Flow rejects missing or ambiguous message IDs.

Pi’s native wake-up is intentionally lightweight: no daemon, duplicate mailbox, or separate extension installation. The extension is shipped inside the Flow package. Desk thread files remain the source of truth.

At session start, the extension records one local, token-fenced **advisory** runtime observation at `.atdd-flow/pi-runtime/<encoded-seat>.yaml`. It contains only its opaque owner token, PID, model, cwd, start time, and heartbeat. A replacement Pi process atomically supersedes the prior observation; the old process can neither heartbeat, clear, nor consume queued mail after it loses its token. Shutdown and expired-heartbeat cleanup remove only the matching advisory observation. This file never selects recipients or changes a Desk seat, task, thread, checkpoint, branch, worktree, or immutable mail. `atdd-flow status seat` may display its active/stale activity as read-only information.

Native mail is loss-tolerant rather than watcher-dependent. When Flow persists a message for a native or Pi-designated unbound seat, it also appends a small per-seat reference to an ordered, fixed-size pending segment under `.atdd-flow/pi-inbox/<encoded-seat>`; immutable thread `M-*.yaml` files remain the authoritative message source. On session start/reload and at a bounded interval, the extension reads only the durable queue head and consumes a fixed batch in `created_at`/message-ID order, removing a reference only after Pi accepts delivery. The pending queue shrinks after delivery, so periodic recovery neither scans nor retains the complete Desk history. `fs.watch` on that queue remains a low-latency fast path; an unavailable watcher or restarted Pi is recovered by reconciliation. Existing Pi processes still require `/reload` or restart after a Flow package upgrade to load the bundled extension.

To host Pi in Herdr, create a pane with the durable Desk and seat identity, then start Pi with the extension supplied by the installed Flow package:

```sh
PI_EXTENSION="$(atdd-flow pi extension-path)"
herdr pane split --current --direction right --cwd /path/to/worktree --no-focus \
  --env ATDD_WORKFLOW_ROOT=/path/to/desk \
  --env ATDD_WORKFLOW_SEAT=driver.runtime@example-app
# Use the pane id returned above.
herdr agent start pi-runtime --kind pi --pane <pane-id> -- --extension "$PI_EXTENSION"
atdd-flow --root /path/to/desk attach driver.runtime@example-app --application herdr --wake native
```

Pi receives its identity and startup task from the extension itself. Its normal TUI remains visible and manually usable; incoming Desk mail wakes it through Pi's native message API. The runtime lifecycle has one internal bounded inbox transport; it does not add a second watcher, registry, mailbox, reservation system, or routing path.

The lifecycle and recovery design was informed by [nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger) at `09937ed647a1b07a3b595bf75943feacb80ff123` (MIT). No pi-messenger source is copied here. Flow keeps Desk identity, recipient selection, immutable mail, and governance authoritative; any future copied source must carry its MIT notice.

With ATDD Bun, enable the Workflow profile:

```yaml
profiles: [planner, coder, tester, traceability, security, workflow]
```

The lifecycle convention makes agents read CLI help and durable records, prefer the smallest sufficient change, avoid speculative scope, work until review-ready or explicitly blocked, prove criteria, and coordinate boundaries through coordinators. ATDD Bun remains repository and merge authority.

### Final behavioral reconciliation

Phase work does not add a writer/reviewer pair after every artifact. The next phase consumes and
semantically challenges the previous phase while ATDD Bun provides deterministic enforcement. The
explicit independent review is reserved for the terminal integration boundary:

```text
implementation → deterministic gates → task review → JEV routing
               → behavioral reviewer → coordinator decision → done/merge
```

ATDD Bun owns the substantive method through
`atdd-bun.review.behavioral-reconciliation`. Workflow first runs deterministic ATDD Bun gates; a red
gate prevents reviewer launch. JEV then classifies only the required review surface
(`LOCAL | ASSEMBLED | JOURNEY | SYSTEM`) plus bounded routing signals such as proof boundary,
cross-path scope, consequence, and runtime observability. JEV does not decide correctness.

Workflow selects the reviewer model from `models.yaml`, creates a task-scoped reviewer seat in the
delivery worktree, injects the full installed ATDD Bun review convention into the reviewer prompt, and
presents inputs in intent-first order. The reviewer records a structured result with
`APPROVE | RETURN | ESCALATE`; it never mutates task state. Review attempts are retained in
`work/<project>/tasks/<task>.reviews.yaml` and are bound to a clean delivery commit.

`APPROVE` makes the task eligible for coordinator completion. `RETURN` is evidence for the
coordinator to move `review → in_progress`. `ESCALATE` leaves the task in review (or the coordinator
may explicitly block it) while authoritative intent is resolved. Only the coordinator can transition
`review → done`.

## Optional Jev helper

Jev is read-only; it cannot mutate state, approve proof, or override ATDD Bun.

```sh
atdd-flow scout --goal 'Fix payment retry behavior' --path src/payment/retry.ts --path src/profile/avatar.ts
atdd-flow focus-check example-app runtime-rollout --action 'Add a generic retry orchestration service'
```

`scout` selects likely files. `focus-check` returns `REQUIRED`, `USEFUL_BUT_NOT_REQUIRED`, or `SPECULATIVE`.
The final behavioral-review launcher also uses JEV System-1 for bounded routing questions only; low
routing confidence becomes conservative `SYSTEM` routing. Use Jev judgments as routing advice, never
as correctness or completion authority. If scouting or focus judgment is unavailable, use repository
evidence and prefer the smaller reversible solution; if model selection is unavailable, escalate
conservatively to the strongest available candidate.

On macOS, Jev reads its TypeSafe key only from Keychain item `atdd-workflow.typesafe`; `TYPESAFE_API_KEY` is a temporary or CI override. The secret is never written to Desk records, output, Git, npm, or GitHub.

## Command reference

```sh
bunx atdd-flow --help
```

Installed help is the authoritative syntax for that version.
