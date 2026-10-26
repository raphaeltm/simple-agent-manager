# Align TanStack Query dependency pair (PR2396)

## Problem and research
Separate Dependabot updates2396 (react-query) and2394 (persist-client-core) select incompatible query-core5.101.2/5.104.4 types. Both published5.104.4 packages require query-core exactly5.104.4. Existing persistence enforces scope allowlists, TTL, mutation exclusion, cancellation and fail-open IDB. Preserve these without casts or schema changes.

Sole completion owner task01M5DWG9TYMN3RZ89GN136KSMC. Reuse2396 and preserve bot commits; no force-push.2394 is companion, bot-only/unassigned with no associated task found (search2394 only returned this task). Do not close until merged2396 demonstrably includes its bump. Staging lease held by Astra01M5C6H5MVNVBZPRHBXTY0QH3T; coordinate consolidated train.

## Checklist / acceptance
- [x] Align both packages5.104.4 and regenerate lockfile; frozen install succeeds with one query-core.
- [x] Meaningful real persistence round-trip compatibility validation; preserve safety tests.
- [x] Relevant lint/typecheck/tests/build; final-head CI and Sonar pass. (reconciled 2026-10-26: #2396 body — web lint, typecheck/build and full web suite 351 files/4251 tests passed; final-head CI 39526038635 success on `72c325238` incl. Lint/Type Check/Test/Build; SonarCloud check pass)
- [x] Independent local specialist review, preflight evidence, CodeRabbit request/wait/findings. (reconciled 2026-10-26: #2396 specialist table all PASS; Preflight Evidence and Specialist Review Evidence pass in CI 39526038635; coderabbit-review label 00:54 UTC, trusted run 39524234456, CodeRabbit "Review skipped", wait ended 01:11 UTC with no findings)
- [x] Coordinated staging persistence/core flows, no extra spend/cap changes, zero VMs at rest. (reconciled 2026-10-26: staging 39526656625 success on `72c325238`; #2396 body records authenticated browser flow PASS 01:56 UTC incl. IndexedDB restore and sign-out purge; zero VMs/workspaces created, no cap changes; staging released to #2393)
- [x] Merge2396, verify canonical production deployment and health/version only. (reconciled 2026-10-26: merged as `c0fb8edd8`; main CI 39532928062 and production 39534453374 success; #2396 body records 03:01 UTC smoke — API health 200, CLI version matches merge, Worker version `e74319d9` at 100%)
- [x] Verify2394 represented and report disposition. (reconciled 2026-10-26: `apps/web/package.json:29-30` on `main` pins both packages at 5.104.4; #2394 closed unmerged 2026-10-21 02:26 UTC with a "Superseded by merged #2396" comment)

## References
.claude/rules/25-review-merge-gate.md; .claude/rules/13-staging-verification.md.

## Validation and review so far
Frozen install passed after narrowing original bot resolver churn; one core5.104.4.108 focused tests passed, independent reviewer103 tests passed; compatibility/test/completion implementation review PASS. Legacy successful records tested without dehydratedAt. Web lint zero errors/three existing warnings. Merged main2389; rebuilding shared/UI artifacts before final typecheck/build/full tests (first attempt used stale pre-merge artifacts). No runtime/UI surfaces changed. Release criteria remain pending.

## Reconciliation 2026-10-26

- Shipped by #2396 (`c0fb8edd8`, merged 2026-10-21); first successful production deploy:
  run 39534453374 (head `c0fb8edd8`, 2026-10-21). Companion #2394 closed as superseded.
- Unticked: 0 — none.
- Verdict: ARCHIVE. Both packages are aligned at 5.104.4 on `main` and deployed; the unrelated
  staging spinner observation is filed separately as SAM idea `01M5E2TY3FWR551J2Q9P27MPR1`.
