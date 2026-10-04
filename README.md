# ATDD Workflow

`atdd-workflow` is a filesystem-first control plane for coordinated coding agents. It keeps durable coordination in a separate Git-backed **Desk**, not inside the code repositories and worktrees being changed.

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
bun add -d @afokapu/atdd-workflow@latest
```

The operator creates one private Desk for projects that coordinate together:

```sh
atdd-workflow init "$HOME/Github/desk" --git
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
`enabled` flag is false, are excluded. At launch, Jev sees the seat's active work and any review
posture, then selects the weakest available model sufficient for that responsibility. An adversarial
review is routed directly to the strongest available candidate. If Jev is unavailable or its model
selection confidence is low, Workflow also conservatively launches the strongest available model. Older Desks without
`models.yaml` continue to honor a legacy seat `agent` through the executable registry.

## Configure worktrees and seats

Create a project, then set its policy in `work/<project>/project.yaml`:

```sh
atdd-workflow project init resolver-os
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
atdd-workflow spawn resolver-os coordinator main --worktree /Users/you/Github/resolver-os
atdd-workflow spawn resolver-os driver runtime
```

`spawn` creates missing driver worktrees through Git: this example creates `/Users/you/Github/worktrees/resolver-os/runtime` on `delivery/runtime`. ATDD Bun owns safe retirement, not creation. A seat can own several tasks.

## Deliver work

```text
todo → in_progress → review → done
```

The coordinator assigns; the driver implements, proves each criterion, and submits for review; only the coordinator marks the task done.

```sh
atdd-workflow task add resolver-os runtime-rollout --title 'Complete runtime rollout' \
  --coordinator coordinator@resolver-os --assignee driver.runtime@resolver-os \
  --done-when 'Checks pass' --done-when 'Review accepted'
atdd-workflow task start resolver-os runtime-rollout --by driver.runtime@resolver-os
atdd-workflow task prove resolver-os runtime-rollout --by driver.runtime@resolver-os --item 1 --proof 'CI run 42'
atdd-workflow task review resolver-os runtime-rollout --by driver.runtime@resolver-os
atdd-workflow task done resolver-os runtime-rollout --by coordinator@resolver-os
```

Proof is a compact PR, CI run, report, commit range, deployment, or thread reference. Dependencies gate prerequisites; independent tasks are parallel-ready. Use `task block` only for a real external blocker, then checkpoint exact state and next action. For an idle driver’s final task, `task done ... --retire-assignee` delegates clean-and-merged worktree retirement to ATDD Bun.

## Communicate and hand over

Threads are the durable inbox/outbox. Workflow persists a message before a best-effort host notification, so a closed pane, rate limit, or missed prompt cannot lose it.

```sh
atdd-workflow thread start --with coordinator@resolver-os,driver.runtime@resolver-os \
  --subject 'Runtime rollout' --task resolver-os/runtime-rollout
atdd-workflow post T-... --from coordinator@resolver-os --to driver.runtime@resolver-os \
  --expects-result --body 'Implement the task and return proof references.'
atdd-workflow result T-... M-... --from driver.runtime@resolver-os --body 'CI run 42; PR #81.'
```

For a shared boundary: driver → coordinator → affected coordinator(s) → minimum agreement in a thread → driver. `--to all` broadcasts; requested results remain outstanding until every recipient replies. Checkpoints are short handoffs, not logs; update at responsibility transitions and before replacing an agent.

## Inspect, host, and guide agents

```sh
atdd-workflow status
atdd-workflow status seat driver.runtime@resolver-os
atdd-workflow open driver.runtime@resolver-os
```

TUIOS is the primary live host; tmux and Herdr have notification adapters. TUIOS launch targets the named session, never the focused session:

```sh
atdd-workflow attach driver.runtime@resolver-os --application tuios
atdd-workflow launch driver.runtime@resolver-os --application tuios --placement resolver-os
```

Launch selects a model from `models.yaml`, starts that model's executable in the seat's declared worktree, passes `ATDD_WORKFLOW_ROOT` and `ATDD_WORKFLOW_SEAT`, records the selected model on the live runtime binding, and asks the agent to read its seat. Other hosts remain correct without an adapter; their operator supplies that prompt.

With ATDD Bun, enable the Workflow profile:

```yaml
profiles: [planner, coder, tester, traceability, security, workflow]
```

The lifecycle convention makes agents read CLI help and durable records, prefer the smallest sufficient change, avoid speculative scope, work until review-ready or explicitly blocked, prove criteria, and coordinate boundaries through coordinators. ATDD Bun remains repository and merge authority.

## Optional Jev helper

Jev is read-only; it cannot mutate state, approve proof, or override ATDD Bun.

```sh
atdd-workflow scout --goal 'Fix payment retry behavior' --path src/payment/retry.ts --path src/profile/avatar.ts
atdd-workflow focus-check resolver-os runtime-rollout --action 'Add a generic retry orchestration service'
```

`scout` selects likely files. `focus-check` returns `REQUIRED`, `USEFUL_BUT_NOT_REQUIRED`, or `SPECULATIVE`.
`review-check <project> <task-id>` classifies specification closure, proof directness, and escape risk,
then deterministically returns `CONFORMANCE` or `ADVERSARIAL`; low-confidence review judgments
escalate. Review posture also informs launch-time model selection. Use these helpers for bounded
decisions, not as correctness authority. If scouting or focus judgment is unavailable, use repository
evidence and prefer the smaller reversible solution; if review or model selection is unavailable,
escalate conservatively.

On macOS, Jev reads its TypeSafe key only from Keychain item `atdd-workflow.typesafe`; `TYPESAFE_API_KEY` is a temporary or CI override. The secret is never written to Desk records, output, Git, npm, or GitHub.

## Command reference

```sh
bunx atdd-workflow --help
```

Installed help is the authoritative syntax for that version.
