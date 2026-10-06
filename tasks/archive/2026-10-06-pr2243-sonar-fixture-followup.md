# PR2243 Sonar screenshot-fixture follow-up

PR2243 was merged externally before the completing agent finished Sonar/CodeRabbit gates. A postmerge scoped scan of candidate2a961c3f confirmed new duplication0.0% (previous9.5%), but found excessive cognitive complexity23/15, unnecessary async, and two RegExp.match calls in the extracted shared helper. The scan also incorrectly counted Playwright fixtures as production code for coverage; subsequent scans must classify them as tests.

Scope: preserve screenshot scene responses while simplifying the route helper. No runtime UI or documentation behavior changes. No project quality threshold or repository exclusions changes.

- [x] Separate session/task response resolution from common exact routes.
- [x] Return route.fulfill directly without unnecessary async; use RegExp.exec.
- [x] Re-run both screenshot suites at375x667/1280x800 and lint/typecheck.
- [x] Independent response-preservation review and completion review.
- [ ] Scan source/tests accurately and record exact scope/result.
- [ ] Green CI and trusted CodeRabbit request+wait before merge.

Acceptance: all prior screenshot assertions remain green, new helper has no Sonar findings, and a follow-up PR records verification honestly. Never claim the original premerge temporal constraint was met; investigate separately in SAM idea01M496QHP8MY2S8W3F2BJPV2XN.

Local validation: ESLint and web typecheck PASS; both screenshot suites11passed5intentional skips. Independent ui_review response-preservation PASS; doc_review completion PASS once typecheck passed. Implementation complete. Scan, PR and execution gates remain Phase7 in .do-state.md; no successful Sonar or CI gate claimed yet.
