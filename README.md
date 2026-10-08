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

A stable address, such as `driver.runtime@resolver-os`, survives a different pane, host, model, or replacement agent. A replacement reads its durable seat, task, checkpoint, and threads rather than predecessor-private context.

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
application: tuios
executables:
  claude: /Users/you/.local/bin/claude
  codex: /opt/homebrew/bin/codex
  pi: /opt/homebrew/bin/pi
  kimi: /Users/you/.kimi-code/bin/kimi
```

The executable registry is transport configuration, not model allocation. New seats do not pin an
agent. Instead, `models.yaml` declares the launchable model portfolio in descending capability order:

```yaml
schema: atdd-workflow/models/v1
models:
  - id: frontier
    executable: claude
    args: [--model, opus]
  - id: standard
    executable: claude
    args: [--model, sonnet]
  - id: codex
    executable: codex
  - id: glm
    executable: glm
    enabled: false
```

Order is policy: strongest first, weakest last. Entries whose executable is unavailable, or whose
`enabled` flag is false, are excluded. For ordinary phase work, Jev sees the seat's active work and
selects the weakest available model sufficient for that responsibility. If model selection is unavailable
or low-confidence, Workflow conservatively launches the strongest available model. Final behavioral
review has its own bounded routing step described below. Older Desks without `models.yaml` continue
to honor a legacy seat `agent` through the executable registry.

## Configure worktrees and seats

Create a project, then set its policy in `work/<project>/project.yaml`:

```sh
atdd-flow project init resolver-os
```

```yaml
repository: /Users/you/Github/resolver-os
worktree_root: /Users/you/Github/worktrees/resolver-os
roles:
  coordinator: { address: coordinator@{project}, branch: main, worktree: '{repository}' }
  driver: { address: driver.{name}@{project}, branch: delivery/{name}, base: main, worktree: '{worktree_root}/{name}' }
```

The operator or coordinator creates seats; drivers do not choose their policy:

```sh
atdd-flow spawn resolver-os coordinator main --worktree /Users/you/Github/resolver-os
atdd-flow spawn resolver-os driver runtime
```

`spawn` creates missing driver worktrees through Git: this example creates `/Users/you/Github/worktrees/resolver-os/runtime` on `delivery/runtime`. ATDD Bun owns safe retirement, not creation. A seat can own several tasks.

## Deliver work

```text
todo → in_progress → review → done
```

The coordinator assigns; the driver implements, proves each criterion, and submits for review; only the coordinator marks the task done.

```sh
atdd-flow task add resolver-os runtime-rollout --title 'Complete runtime rollout' \
  --coordinator coordinator@resolver-os --assignee driver.runtime@resolver-os \
  --done-when 'Checks pass'
atdd-flow task start resolver-os runtime-rollout --by driver.runtime@resolver-os
atdd-flow task prove resolver-os runtime-rollout --by driver.runtime@resolver-os --item 1 --proof 'CI run 42'
atdd-flow task review resolver-os runtime-rollout --by driver.runtime@resolver-os
atdd-flow behavioral-review launch resolver-os runtime-rollout --by coordinator@resolver-os \
  --application tuios --placement resolver-os --gate 'CI run 42'
# the reviewer persists APPROVE, RETURN, or ESCALATE through behavioral-review record
atdd-flow task done resolver-os runtime-rollout --by coordinator@resolver-os
```

Proof is a compact PR, CI run, report, commit range, deployment, or thread reference. Dependencies gate prerequisites; independent tasks are parallel-ready. A coordinator can staff an unassigned ready task with `atdd-flow task assign <project> <task-id> --assignee <address> --by <coordinator-address>`; assignment is allowed only once while the task is `todo`. Use `task block` only for a real external blocker, then checkpoint exact state and next action. Once the blocker is resolved, only that coordinator can clear it with `atdd-flow task unblock <project> <task-id> --by <coordinator-address>` while the task remains `in_progress`. For deliveries explicitly governed by the `workflow` ATDD Bun profile, `review → done` additionally requires a durable final behavioral-review result with decision `APPROVE` for the current clean delivery commit. For an idle driver’s final task, `task done ... --retire-assignee` delegates clean-and-merged worktree retirement to ATDD Bun.

## Communicate and hand over

Threads are the durable inbox/outbox. Workflow persists a message before a best-effort host notification, so a closed pane, rate limit, or missed prompt cannot lose it.

```sh
atdd-flow thread start --with coordinator@resolver-os,driver.runtime@resolver-os \
  --subject 'Runtime rollout' --task resolver-os/runtime-rollout
atdd-flow post T-... --from coordinator@resolver-os --to driver.runtime@resolver-os \
  --expects-result --body 'Implement the task and return proof references.'
atdd-flow result T-... M-... --from driver.runtime@resolver-os --body 'CI run 42; PR #81.'
```

For a shared boundary: driver → coordinator → affected coordinator(s) → minimum agreement in a thread → driver. `--to all` broadcasts; requested results remain outstanding until every recipient replies. Checkpoints are short handoffs, not logs; update at responsibility transitions and before replacing an agent.

## Inspect, host, and guide agents

```sh
atdd-flow status
atdd-flow status seat driver.runtime@resolver-os
atdd-flow open driver.runtime@resolver-os
```

TUIOS is the primary live host; tmux and Herdr have notification adapters. TUIOS launch targets the named session, never the focused session:

```sh
atdd-flow attach driver.runtime@resolver-os --application tuios
atdd-flow launch driver.runtime@resolver-os --application tuios --placement resolver-os
```

Launch selects a model from `models.yaml`, starts that model's executable in the seat's declared worktree, passes `ATDD_WORKFLOW_ROOT` and `ATDD_WORKFLOW_SEAT`, records the selected model on the live runtime binding, and asks the agent to read its seat. Other hosts remain correct without an adapter; their operator supplies that prompt.

### Optional Herdr worktree projection

`multiplexer/herdr.yaml` is a compact, instance-free policy: it describes only primary versus linked worktree role placement. The Desk remains authoritative for projects, seats, tasks, branches, and worktrees. Herdr is an optional display/runtime projection and never becomes a second registry.

An operator must select the target session explicitly, or run from a Herdr pane that supplies `HERDR_SESSION`; Flow never chooses a Desk-wide or focused session. Status is read-only and apply uses `--no-focus`:

```sh
atdd-flow multiplexer status herdr --session forge
atdd-flow multiplexer apply herdr --session forge
# Inside a Herdr pane, the inherited HERDR_SESSION is sufficient:
atdd-flow multiplexer apply herdr
```

For each Desk project, apply reconciles the declared repository checkout as workspace `{project}` and gives every main/coordinator seat using it a tab and pane named `{seat.address}`. Linked coordinator worktrees and drivers with a non-done assigned task become linked-worktree workspaces named `{seat.address}`, with an equally named tab and pane. Unbound worktrees are ignored. Apply neither focuses, closes, nor guesses about other workspaces or sessions.

New Herdr attachments store both the inherited session and pane id. Older scalar pane bindings remain readable and use their legacy Desk session only when one exists, so a bare `w1:p1` from one session cannot be mistaken for the same pane in another newly attached session.

### Pi-native Desk mail

When Flow launches the `pi` executable, it automatically loads its bundled Pi extension. Pi remains a normal, interactive agent in its host pane, but the extension watches the immutable Desk mail files and wakes Pi internally with `pi.sendMessage()`—not terminal text injection.

The Pi seat records both concepts independently:

```yaml
runtime:
  application: herdr # or tuios
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

Pi’s native wake-up is intentionally lightweight: no daemon, duplicate mailbox, or separate extension installation. The extension is shipped inside the Flow package. Its in-memory message-id guard tolerates duplicate filesystem events; the Desk thread files remain the source of truth.

To host Pi in Herdr, create a pane with the durable Desk and seat identity, then start Pi with the extension supplied by the installed Flow package:

```sh
PI_EXTENSION="$(atdd-flow pi extension-path)"
herdr pane split --current --direction right --cwd /path/to/worktree --no-focus \
  --env ATDD_WORKFLOW_ROOT=/path/to/desk \
  --env ATDD_WORKFLOW_SEAT=driver.runtime@resolver-os
# Use the pane id returned above.
herdr agent start pi-runtime --kind pi --pane <pane-id> -- --extension "$PI_EXTENSION"
atdd-flow --root /path/to/desk attach driver.runtime@resolver-os --application herdr --wake native
```

Pi receives its identity and startup task from the extension itself. Its normal TUI remains visible and manually usable; incoming Desk mail wakes it through Pi's native message API.

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
atdd-flow focus-check resolver-os runtime-rollout --action 'Add a generic retry orchestration service'
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
