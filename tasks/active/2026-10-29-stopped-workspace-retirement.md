# End stuck workspace deletion and stopped-node retirement

Parent SAM task: 01M6364S1M4WHNR1JJZ062B82Y. Implementation task: 01M639RSX46DJ8YZC1PBW0EK20.

## Problem

Legacy VM workspace deletion returns HTTP404 without physical deletion proof. Retry writes advance workspace.updated_at, so stopped handoff nodes never age into retirement. Running incompatible-node retirement can verify saved sources but stopped handoff cannot. Mixed unsafe sources must continue to block whole-VM destruction.

## Research

- `scheduled/node-cleanup/node-phases.ts`: stopped/destroying handoff uses MAX(updated_at), no preservation authority.
- `services/preserved-vm-retirement.ts`: exact generations and R2 artifact verification already authorize whole-VM retirement, but requires sleeping_at even when preservation is complete.
- `node-lifecycle-workspace-deletion.ts`: durable retries already dead-letter at configured maximum residence. Node retirement must remain possible after that exhaustion; HTTP404 is never physical proof.
- `session-sleep-fallback.ts`: bounded snapshot failures retain transcript/backups and record explicit teardown intent, distinct from arbitrary no-snapshot/OOM rows.
- Production read-only evidence: three supplied nodes remain stopped, no termination proof; retry counters advanced to 68. Missing snapshot sources and null sleeping_at occur in mixed nodes.

## Implementation checklist / acceptance

- [ ] Use preservation-owned activity clock in stopped handoff selector and fenced claim, unaffected by retry writes.
- [ ] Apply bounded exact-source verification to stopped/destroying managed VM handoff; preserve provider/owner/incarnation/placement gates.
- [ ] Recover legacy complete preservation with missing sleeping_at without inventing stop proof; honor recorded bounded fallback only with transcript/ownership safeguards.
- [ ] Keep no-snapshot failed-start/OOM sources blocked unless positive authority exists; report residual blockers.
- [ ] Regression tests: old-agent404 bookkeeping, handoff/strict deletion, mixed sources, missing sleeping_at, retry exhaustion, concurrency, artifact loss, failure backoff/budgets.
- [ ] Relevant lint/typecheck/tests/build; independent specialist reviews, best-effort CodeRabbit; green non-draft PR.
- [ ] Merge, successful production deploy, basic smoke and bounded read-only affected-state check; report URL/SHA/evidence to parent.

## Constraints

Staging explicitly waived by user; no production lifecycle/stress fixtures. Preserve transcript/artifacts and all ownership/termination proof boundaries. Coordinate on feature.reliability-20261029; deployment sibling owns strict deployment-node changes; OOM sibling owns relocation contract. No blanket delete or status/error-derived never-started proof.

References: .claude/rules/47-control-loop-io-budget.md (API scoped copy), .claude/rules/25-review-merge-gate.md, Constitution X/XI.
