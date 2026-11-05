# Share one receipt-ledger implementation in the VM agent persistence layer

## Problem

`packages/vm-agent/internal/persistence` now has three hand-written copies of the same
accept → claim → complete → get receipt state machine, each with its own conflict
detection, claim compare-and-set and stale-runtime reconciliation:

- `PromptDeliveryReceipt` (`execution_protocol.go`)
- `CheckpointRolloverOperation` (`execution_protocol.go`)
- `SteerDeliveryReceipt` (`steer_delivery.go`, added by the live-steering branch)

A future correctness fix (locking, reconciliation) has to land three times.

## Context

Raised by the architecture review of the live-steering draft PR
(branch `sam/build-draft-pr-implementing-pm2ayp`, MEDIUM, deferred: each copy is correct and
tested, and the refactor touches two existing ledgers outside that PR's scope).

## Acceptance Criteria

- [ ] One generic ledger helper (shared accept-conflict detection, claim CAS, stale-runtime
      reconciliation) backs all three receipt types.
- [ ] Existing tests for all three ledgers pass unchanged, plus a table test over the shared helper.
- [ ] Migrations and on-disk schemas are unchanged.
