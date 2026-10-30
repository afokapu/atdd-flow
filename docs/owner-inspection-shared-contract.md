# Phase 0 owner-inspection shared contract

## Authority and single state owner

Flow is the sole schema and immutable inspection/acknowledgement-record owner. It owns the canonical inspection record and the authoritative ephemeral-resource inventory, receipt, retention, and parent/dependent hold linkage. ATDD Bun is an evidence/applicability consumer only and must not create a parallel registry, task engine, cleaner, or universal manifest.

The record is behavior, not decoration: every inspection assertion must identify the accountable owner and show the evidence that proves the stated behavior. The immutable acknowledgement history records owner acknowledgement without rewriting a prior acknowledgement.

## Required inspection packet

Each packet records identity, the owner, inspectable surface, scenario, and data classification. It provides deterministic health, smoke, and teardown evidence. It provides direct rendered evidence; a toolkit-only surface may state N/A only with an exact N/A rationale and direct rendered CI, ratchet, or package evidence.

## Safety and negative boundaries

No production target or implicit preview is permitted. The contract does not authorize deployment, a fabricated URL, consumer-owned lifecycle state, a duplicate schema, or an implementation in either toolkit. A missing owner, surface, scenario, data classification, health/smoke/teardown evidence, rendered evidence, or N/A rationale is a negative result, not a substituted inference.

## Approval and dependent-work hold

The Phase 0 contract is approved only when Flow’s schema owner, the current ATDD Bun liaison, and an independent review have durably recorded the same boundaries. Until then, dependent work remains held: the ATDD Bun convention, pilot toolkit, and packet/gate adoption chain, and the Flow standard, pilot, and rollout chain, may not start implementation or unblock downstream work.

Current liaison mapping is recorded in the Phase 0 durable thread: `main@atdd-bun` is the supported successor authority because `coordinator@atdd-bun` is retired; this does not fabricate a separate retired-seat approval.
