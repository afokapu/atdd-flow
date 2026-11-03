# Main succession after a closed source pane

Task `atdd-flow/main-rotation-stale-request-recovery-20261031`; acceptance `acc:flow:E023-UNIT-001`.

## Finding

The live `main@atdd-flow` incident (consumed Path-A request, source pane `w5:pB` closed, seat rebound to
shell pane `w5:pN`) is already covered by the released pane-gone recovery
(`handover replace --recover-stale-main`, then an ordinary `pi runtime launch`, then `handover resumed`).
That recovery archives the consumed request by hash, needs no transcript adoption and reconciles
RESUMED 6/6 against the fresh receipt and heartbeat.

It was unreachable because the seat recorded its Herdr pane as `forge/w5:pN` (session-qualified text).
Every exact current-locator comparison (`relocationFor`, `replacementMatchesRuntime`, the launch target
check) then compared `w5:pN` with `forge/w5:pN` and fell back to the generic
"target must be the exact released source pane" refusal.

## Change

- `herdrPaneId(session, pane)` in `src/core.ts` strips a redundant `<session>/` prefix.
- `seat()` applies it when reading a Herdr locator; `bind` applies it when writing one.

No new flag, registry, state file or lifecycle. Safety checks (source Pi and retired pane absent from one
global snapshot, vacant non-host target, one ready takeover task, tuple-bound operator authorization,
runtime/request match) are unchanged.

## Proof

`tests/consumed-request-shell-pane-succession.red.test.ts` reproduces the live shape for both locator
forms through request, dry-run, fresh launch and RESUMED 6/6, plus fail-closed negatives. A read-only
probe of the fixed code against the live seat and request files reaches the
`launcher-receipt-pane-gone` relocation.

## Not in scope

The generic one-command `pi runtime rotate` orchestrator stays with `delegated-seat-runtime-rotation`
and `autonomous-pi-handover-successor-strategy-20261028`.
