# Pinned ATDD Bun resolution plan

Task: `atdd-flow/flow-invoked-pinned-atdd-bun-resolution-20261104` (HIGH). Phase: PLAN. No code, test, upgrade, generation, merge, or publish yet.

## Defect (confirmed in code at 6e3521b)

- `src/reviews.ts:242` runs bare `atdd-bun` (PATH, i.e. global) in the delivery worktree as the deterministic gate. The global version judges a project that pins a different one, and applies consumer integrity to the `@afokapu/atdd-bun` source checkout, which correctly has no self-dependency.
- `src/reviews.ts:121` `convention()` requires `<worktree>/node_modules/@afokapu/atdd-bun/conventions/...`, which cannot exist in a source checkout.
- `src/tasks.ts:252-259` `retirementBun()` already prefers a primary-checkout local bin, then the source `src/cli.ts`, but ends with `Bun.which("atdd-bun")`, a global fallback. This is the same defect on the seat-retirement (`worktree finish`) path.
- `src/recovery-bundle.ts:33` only pattern-matches `atdd-bun` in text; it never launches it, so it is out of scope.

## Design: one resolver, no PATH

New `src/pinned-toolkit.ts` exports `resolvePinnedToolkit(projectRoot)`. It returns `{ kind: "consumer" | "source", command: string[], conventionsRoot, version }`, and it never consults `PATH`, `Bun.which`, or the environment.

1. Read `<root>/package.json`. If it is unreadable or invalid, throw.
2. `name === "@afokapu/atdd-bun"` means **source**. Require `<root>/src/cli.ts`, `<root>/conventions/` and a `version`. The command is `[process.execPath, <root>/src/cli.ts]`, and `conventionsRoot` is `<root>`. `node_modules` is ignored and a self-dependency is not required.
3. Otherwise **consumer**. Require all of:
   - `<root>/node_modules/.bin/atdd-bun`.
   - `<root>/node_modules/@afokapu/atdd-bun/package.json` and its `conventions/`.
   - The bin's realpath lies inside that installed package, so the bin and the conventions come from one install.
   - When the project declares an exact pin in `dependencies` or `devDependencies`, the installed version equals it.

   The command is `[<abs .bin/atdd-bun>]`, and `conventionsRoot` is the installed package.
4. Any miss throws one `PinnedToolkitError` that names the root, the check that failed, and the remedy ("install the pinned toolkit"). It does not fall back, install, generate, or write.

Call sites:
- `launchBehavioralReview` uses `command` for the gate, run in the delivery worktree. `convention()` reads from `conventionsRoot`, so source checkouts use their own `conventions/` and `package_version` is the resolved version.
- `retirementBun()` becomes a thin caller of the resolver on the primary checkout and loses the PATH fallback. The primary checkout stays the retirement root, as documented in the existing comment.
- The resolver is the only place that decides toolkit identity. A guard test (a `rg` over `src/` for `Bun.which("atdd-bun")` and bare `["atdd-bun"` launches) keeps it that way.

## Test plan (isolated tmp fixtures; RED first, then GREEN)

Each fixture puts a sentinel global `atdd-bun` shim first on `PATH`. The shim records an invocation marker and reports a different version.

1. Consumer: the pinned `.bin` runs, the shim marker is absent, and conventions are read from the installed package.
2. Source checkout (`name` is `@afokapu/atdd-bun`, no self-dependency): `bun src/cli.ts` runs, conventions come from `<root>/conventions`, and the shim is never run.
3. Profile/integrity launch: the review gate and `worktree finish` use the same resolved command in both fixture kinds.
4. A global version that disagrees (shim PASS or FAIL) cannot change the verdict.
5. Fail closed, with no mutation and no shim run, for each of:
   - no `node_modules`
   - missing `.bin`
   - a bin that escapes the package
   - a version that differs from the declared exact pin
   - missing `conventions/`
   - bad `package.json`
   - a source checkout missing `src/cli.ts`

   Each case snapshots the fixture tree before and after and asserts it is identical.
6. The existing `review.test.ts` and `seat.test.ts` suites stay green. Their fixtures that rely on the global shim or a symlinked `.bin` are updated to a pinned layout.

## Decisions (accepted by main in M-20261104T235832Z-plan-accepted_a0b63495)

- **Root.** Resolve from the explicit target/delivery worktree being checked. Never fall back to a primary checkout or a parent directory. The resolved package root, bin and conventions must all belong to that target root. This supersedes the earlier primary-checkout choice for `retirementBun()`, which therefore also resolves from an explicit target worktree and loses its PATH fallback in GREEN.
- **Missing install** (a fresh worktree without `node_modules`) fails closed with a remedy message. Flow never installs.
- **Range declarations:** the installed local package must satisfy the declared range (`Bun.semver.satisfies`). Literal equality applies only to an exact pin.

## RED (tests/pinned-atdd-bun-resolution.red.test.ts)

Launches run in a child process whose PATH carries the sentinel global shim, because Bun resolves executables against its start-up PATH.

- Failing: the source checkout, 10 fail-closed cases, the explicit-root and PATH-free resolver contracts (`src/pinned-toolkit.ts` does not exist yet), and the no-PATH-launch source guard.
- Passing guards (existing behavior that must not regress): consumer launch, global disagreement with a local pin, and a satisfied range. `core.execute` already prefers a local `node_modules/.bin`, so a consumer with a local bin is already pinned. The gap is the absence of a local pin (source checkout, missing or invalid install), which falls through to PATH.
- Retirement (tests/pinned-atdd-bun-retirement.red.test.ts, added after main returned RED in M-20261105T000131Z-red-return-retirement-path_6cbbd363): `task done --retire-assignee` runs end to end through the CLI, with a real linked driver worktree and a git repository. The sentinel global shim is on PATH and a decoy pin sits in the primary checkout.
  - Valid consumer and source pins in the target worktree must be the ones that run. The primary decoy and the global shim must not.
  - A rejecting global cannot judge retirement.
  - 10 invalid-pin layouts (same matrix as the launch tests) must fail closed. The seat stays unretired, and the worktree, branch and HEAD stay unchanged. No toolkit runs, and the failure is not downgraded to the merge-proof "refused ... retained" success.
  - Contract for GREEN: every `PinnedToolkitError` message contains the phrase `pinned ATDD Bun`.
  - Existing `seat.test.ts` retirement test: its fixture symlinks a pin into the primary checkout. Under the target-worktree rule it needs a pinned layout in the seat worktree, to be updated in GREEN.
