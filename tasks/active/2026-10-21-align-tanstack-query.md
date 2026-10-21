# Align TanStack Query dependency pair (PR2396)

## Problem and research
Separate Dependabot updates2396 (react-query) and2394 (persist-client-core) select incompatible query-core5.101.2/5.104.4 types. Both published5.104.4 packages require query-core exactly5.104.4. Existing persistence enforces scope allowlists, TTL, mutation exclusion, cancellation and fail-open IDB. Preserve these without casts or schema changes.

Sole completion owner task01M5DWG9TYMN3RZ89GN136KSMC. Reuse2396 and preserve bot commits; no force-push.2394 is companion, bot-only/unassigned with no associated task found (search2394 only returned this task). Do not close until merged2396 demonstrably includes its bump. Staging lease held by Astra01M5C6H5MVNVBZPRHBXTY0QH3T; coordinate consolidated train.

## Checklist / acceptance
- [x] Align both packages5.104.4 and regenerate lockfile; frozen install succeeds with one query-core.
- [x] Meaningful real persistence round-trip compatibility validation; preserve safety tests.
- [ ] Relevant lint/typecheck/tests/build; final-head CI and Sonar pass.
- [ ] Independent local specialist review, preflight evidence, CodeRabbit request/wait/findings.
- [ ] Coordinated staging persistence/core flows, no extra spend/cap changes, zero VMs at rest.
- [ ] Merge2396, verify canonical production deployment and health/version only.
- [ ] Verify2394 represented and report disposition.

## References
.claude/rules/25-review-merge-gate.md; .claude/rules/13-staging-verification.md.

## Validation and review so far
Frozen install passed after narrowing original bot resolver churn; one core5.104.4.108 focused tests passed, independent reviewer103 tests passed; compatibility/test/completion implementation review PASS. Legacy successful records tested without dehydratedAt. Web lint zero errors/three existing warnings. Merged main2389; rebuilding shared/UI artifacts before final typecheck/build/full tests (first attempt used stale pre-merge artifacts). No runtime/UI surfaces changed. Release criteria remain pending.
