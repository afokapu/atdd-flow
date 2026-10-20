# Exact-adoption RESUMED proof and safe relaunch

## Acceptance identity

`acc:flow:E006-RED-001` records the two exact released-state contracts reported in
`M-20261020T033401Z-exact-adoption-6-of-6-contradiction_6748f2e8` and
`M-20261020T033659Z-frg-present-state-recovery-requires-exact-launch-fix_b53be8c0`.

## Contract A — adopted successor reconciliation

Given an active Path-A request published from an authorized live source, after the
source is released and exact adoption starts a fresh process, the process keeps the
source Pi session and canonical JSONL path by design. `handover resumed` therefore
must count the immutable launch receipt's exact request, relocation authorization,
backup hash, target tuple, and fresh heartbeat as the freshness proof. Session
inequality remains mandatory for an ordinary non-adoption successor.

## Contract B — exact exited-state relaunch

Given vacant `forge/w6:p6`, seat runtime session
`01a15391-2a48-7467-aedd-a13f993202d6`, the failed-adoption launch receipt, the
unchanged active supersession request whose `live_source` is that session, and the
same ready TODO takeover task, one normal launch without `--adopt-session` or
`--resume` may mint a fresh session and receipt. Eligibility comes only from the
byte-identical active request plus the exact immutable adoption receipt,
authorization, relocation backup, archive, vacant target, and task. It does not
rewrite the request or canonical pre-adoption source.

## Smallest coherent GREEN seam (not authorized in this delivery)

Keep launch mechanics and receipt publication unchanged. Extend the existing
Path-A lifecycle reconciliation in `src/handover.ts` with one exact failed-adoption
proof classifier shared by `replacementForMainLaunch` and
`resumedHandoverReplacement`:

1. retain the current canonical pre-adoption eligibility branch;
2. recognize an adopted same-identity successor only from its exact relocation and
   replacement receipt, not from session equality alone;
3. when that exact adopted process is absent from the already-required vacant
   target, admit one ordinary launch against the unchanged TODO request;
4. let the ordinary launch's fresh session/receipt satisfy the existing 6/6 path.

Do not add a command, state file, manual rebind, task churn, process mutation, or a
second request lifecycle. Reject request/receipt tuple mismatch, duplicate candidate
receipts, missing or changed backup/archive evidence, non-TODO or blocked tasks,
and every existing authorization, source, target, topology, or occupancy negative.

## RED witness

`tests/exact-adoption-resumed-proof-and-relaunch.red.test.ts` executes publication,
source release, exact adoption, same-identity RESUMED reconciliation, adopted-process
exit, normal fresh relaunch, fresh receipt and final RESUMED 6/6. It also locks the
ordinary-session inequality and mismatch/duplicate/archive/task refusal boundaries.
