# Atomic bootstrap token redemption

## Problem

Bootstrap token redemption currently depends on KV `get` then `delete`, plus an isolate-local in-flight map. That prevents duplicate redemption inside one isolate but does not make the single-use consume atomic across Cloudflare Worker isolates or concurrent requests.

## Research findings

- `apps/api/src/services/bootstrap.ts` stores token payloads in KV and redeems with KV `get/delete`.
- `apps/api/src/routes/bootstrap.ts` exposes `POST /api/bootstrap/:token` and preserves the current response shape for VM agents.
- `apps/api/src/routes/workspaces/runtime.ts` has a legacy bootstrap-token endpoint that writes KV directly.
- Existing tests cover normal valid/invalid redemption and an isolate-local in-flight replay, but not cross-isolate atomic consume.
- Cloudflare KV cannot provide compare-and-delete semantics; D1 can provide an atomic conditional write/update for the consume decision.
- Relevant prior findings:
  - `tasks/archive/2026-03-12-shannon-security-assessment.md` documents the TOCTOU race on bootstrap KV get/delete.
  - `tasks/archive/2026-07-18-harden-callback-bootstrap-token-lifecycle.md` requires fail-closed callback/bootstrap token lifecycle behavior while keeping bounded legacy compatibility.

## Checklist

- [x] Add a D1 migration for a bootstrap token consume ledger keyed by a non-secret token hash.
- [x] Register newly created bootstrap tokens in the ledger while preserving the existing KV payload format.
- [x] Redeem tokens only after an atomic D1 consume succeeds.
- [x] Add migration-safe handling for in-flight legacy KV-only tokens, using atomic insert-wins semantics.
- [x] Fail closed if the consume state is ambiguous or failed.
- [x] Update direct legacy bootstrap-token creation to register the ledger.
- [x] Add tests for concurrent redemption, single-use semantics, expired/missing tokens, and existing valid-token compatibility.
- [x] Run relevant validation and local specialist reviews.
- [x] Open a narrow PR and do not merge.

## Acceptance criteria

- Exactly one concurrent redemption can receive credentials for a known valid token.
- Replays are rejected after one successful consume.
- Missing and expired tokens are rejected without exposing credentials.
- Existing valid token response semantics and token format remain unchanged.
- In-flight KV-only tokens remain redeemable at most once through an atomic legacy claim path.
- CI is green and the PR documents no-breaking-change rationale.
