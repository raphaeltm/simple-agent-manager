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

- [x] Use preservation-owned activity clock in stopped handoff selector and fenced claim, unaffected by retry writes.
- [x] Apply bounded exact-source verification to stopped/destroying managed VM handoff; preserve provider/owner/incarnation/placement gates.
- [x] Recover legacy complete preservation with missing sleeping_at without inventing stop proof; honor recorded bounded fallback only with transcript/ownership safeguards.
- [x] Keep no-snapshot failed-start/OOM sources blocked unless positive authority exists; report residual blockers.
- [x] Regression tests: old-agent404 bookkeeping, handoff/strict deletion, mixed sources, missing sleeping_at, retry exhaustion, concurrency, artifact loss, failure backoff/budgets.
- [x] Relevant lint/typecheck/tests/build and independent specialist reviews.
- [ ] Green non-draft PR and best-effort CodeRabbit (release gate tracked in PR body).
- [ ] Merge, successful production deploy, basic smoke and bounded read-only affected-state check; report URL/SHA/evidence to parent.

## Constraints

Staging explicitly waived by user; no production lifecycle/stress fixtures. Preserve transcript/artifacts and all ownership/termination proof boundaries. Coordinate on feature.reliability-20261029; deployment sibling owns strict deployment-node changes; OOM sibling owns relocation contract. No blanket delete or status/error-derived never-started proof.

References: .claude/rules/47-control-loop-io-budget.md (API scoped copy), .claude/rules/25-review-merge-gate.md, Constitution X/XI.

## Validation / review evidence

- Focused real-SQL retirement suite: 53 passed (52 independently repeated before final bounded-page regression) by completion reviewer.
- Broader lifecycle unit suites: 146 passed before final additions.
- Root lint: 13 tasks passed; root typecheck: 19 passed; root build: 9 passed.
- Workers scheduled cleanup: 28 passed. NodeLifecycle: 81 passed; isolated retry-finalizer regression also passes after original concurrent-load timeout.
- Full root bounded run completed: all non-API packages pass; API 14,117 passed with four failures corrected through final retirement/guard rerun (63/63). The old partial SQLite guard fixtures now use complete schema; a healthy/fresh-heartbeat orphan pair isolates orphan phase without relaxing any assertion. One in-run cached shared module preceded the final repair edit; final isolated suite confirms the repair. Default parallel attempt hit local fork timeouts.
- Security/Cloudflare: PASS after recovery-point claim downgraded by exact CAS when unavailable.
- Completion/test/constitution/doc: PASS, independent52/52 plus final53/53 bounded-page regression and diff check.
- Explicit staging waiver honored; production verification limited to basic smoke/read-only state.

## Production recovery limits

Read-only classification: node01M61H40DCXNPD22N1KYNZ727S has a full preserved unconfirmed source and can retire if provider/R2 checks pass. Node01M60MET9WNMZHBWHRS53KTJD9 additionally has failed-start source01M61J61GKHH00XN3C3GW0QCGS with no preservation authority. Its null-sleeping_at source is fully preserved and its separate bounded fallback source has an explicit decision.
The two evictions on01M61JA31QX4TXBCJ5GKP1JCZF did recover onto successors: moved snapshots retain eviction markers and restore timestamps, but their current cleanup identities/generations belong to the successor node. Original-source generation is NULL. Successor snapshots alone cannot establish original-incarnation/latest-source preservation authority; keep originals fenced pending positive proof. Shared-channel coordinator/OOM owner informed.

Final recovery repair: `retired-vm-sleep-repair.ts` confirms wakeability only from exact matching durable VM/workspace termination proof, retried before source preparation after interruption. No pre-proof timestamp fabrication; backup keys and expiry retained. Both specialists re-reviewed PASS; 132 combined focused tests pass.

Implementation archived after completion validation. Remaining PR/CodeRabbit/merge/deployment evidence is maintained in the PR body and parent SAM completion report; staging explicitly waived. Final fixture re-review independently10/10 guard tests PASS.

Final adversarial wake-race review: fallback refuses waking/restored/foreign recovery workspace; downgrade CAS and saved claim/final-boundary authority fence recovery status/attempt/workspace. Three asynchronous/atomic wake races added. Four affected suites90/90 PASS; final security re-review PASS.
