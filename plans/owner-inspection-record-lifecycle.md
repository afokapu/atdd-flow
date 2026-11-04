# Owner-inspection record lifecycle plan (Flow Phase 1)

Base: `origin/main` 4f02637 (v0.3.94), which contains PR #124 / 2f07a166 and
`docs/owner-inspection-shared-contract.adoc`. Task:
`atdd-flow/owner-inspection-flow-standard`.

## Boundary

Flow adds a new `src/owner-inspection.ts` module and an `owner-inspection` CLI
group. Flow is the sole schema and immutable-record owner. It stores references
and provenance only, never artifact contents, and never re-implements ATDD Bun
validation. Bun may only consume Flow records. This slice adds no deploy, preview,
URL, Bun-side registry, or second hold mechanism.

## Contract-to-implementation map

| Contract clause (docs/owner-inspection-shared-contract.adoc) | Planned Flow behavior |
| --- | --- |
| Flow is sole schema and immutable-record owner | `atdd-workflow/owner-inspection/v1` record written once under `.atdd-flow/owner-inspections/<id>.yaml`; republish with a different payload is rejected. |
| Packet identity, owner, surface, scenario, data classification | `publish` validates all five. A missing field is a named negative error, with no inferred substitute. |
| Deterministic health, smoke, teardown evidence | Each is a required reference (kind plus locator plus digest). Contents are never copied. |
| Direct rendered evidence; N/A only for a toolkit-only surface | `rendered` is a reference. `na_rationale` plus a CI, ratchet, or package reference is accepted only when `surface_kind: toolkit`. Any other N/A is rejected. |
| Candidate and merge inspection provenance | A record is `stage: candidate` or `stage: merge`. It carries task, PR, and commit SHA refs. A merge record must name its candidate record. |
| Immutable acknowledgement history | Append-only `.../acks/<id>/<n>.yaml`, each with `immutable: true`. Acknowledgements never rewrite a prior acknowledgement or the record. |
| Operator-only acknowledgement | `ack` requires `--by operator@desk` and an available operator seat, matching the `owner-escalations.ts` pattern. A driver, coordinator, or main is rejected. |
| Owner accountable for each assertion | Every assertion carries `owner` and an evidence ref. Without both, `publish` fails. |
| Safety: no production target or implicit preview | `target` must be explicit and non-production. Production-looking, implicit, or fabricated targets are rejected. No URL is generated. |
| Parent/dependent hold linkage and retention | The record links `parent: {project, task}`. An unacknowledged required record holds parent completion and dependent unblock by extending the existing `assertSettled` seam in `ephemeral-resources.ts` (a call into it, not a second engine). Any teardown or ephemeral inventory reuses the existing ephemeral-resource declaration. |
| Status (advisory) | `owner-inspection status <project>` and a `task status` line report `pending`, `acknowledged`, and `held`. Output is advisory and never mutates tasks. |

## CLI surface (Phase 1)

- `atdd-flow owner-inspection publish --file <packet.yaml> --by <seat>`
- `atdd-flow owner-inspection read <id>`
- `atdd-flow owner-inspection ack <id> --by operator@desk --note <text>`
- `atdd-flow owner-inspection status [<project> [<task>]]`

## RED matrix (`tests/owner-inspection-record-lifecycle.red.test.ts`)

Positive:
- A complete candidate packet publishes to one immutable record.
- A merge packet with a linked candidate publishes.
- `read` returns the stored refs only, with no copied content.
- An operator acknowledgement appends history.
- Status reflects pending, then acknowledged.
- Parent completion and dependent unblock are held until acknowledged.

Negative:
- Each missing field fails: owner, surface, scenario, data classification, health, smoke, teardown, rendered evidence.
- A toolkit N/A is accepted only with a rationale and evidence; a non-toolkit N/A is rejected.
- Production or implicit-preview targets are rejected.
- Acknowledgement by driver, coordinator, main, or a missing operator seat is rejected.
- Republishing a changed payload and rewriting an acknowledgement are rejected.
- A merge record without a candidate is rejected.
- No artifact contents or secrets are persisted.
- Hold clears only on acknowledgement.

## Phases

1. PLAN (this document), reported to `main@atdd-flow`.
2. RED, then GREEN and REFACTOR separated per the phase-discipline convention. These start only after owner decision.
3. Review and gate evidence. No merge or publish without separate owner authorization.

## Non-goals

No Bun changes, no profile or config changes, no deployment, no merge or release,
no migration of existing ephemeral-resource records.
