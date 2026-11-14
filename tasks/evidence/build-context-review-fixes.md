# CodeRabbit review 5834302607 disposition

Base: `a6a626aaa270b5a70bcdb3faf278ba1c84788016`, PR #2605. Coordinator authorized these narrow fixes in message `607a7a3b-3cae-4ef4-afac-6c12ebaee1cb`. No additional staging deployment or resource was created. The coordinator must decide whether the earlier Instant proof remains sufficient; fresh VM live proof remains incomplete.

| Finding | Change | Regression evidence |
| --- | --- | --- |
| 4519199344, profile-less callback | Remove the blanket profile requirement and use the existing deployment policy validator. | Real SQLite policy replaces the permissive mock. Unrestricted null-profile init failed 403 before the fix, with 13 other cases passing. All 14 pass after the fix, including disabled/restricted denial and a policy change fencing completion before HEAD. |
| 4519199371, cleanup starvation | Count individual R2 delete failures, continue to later objects/pages, aggregate errors into cron totals. | Before fix 4 failures/9 passes across cleanup suites; after fix 13/13 pass. A failed first delete no longer prevents later deletes or cursor advancement. |
| 4519199377, portable fixtures | Shared test-only helper skips unavailable/unwritable trusted bases, never creates `/workspaces`, and checks fixture cleanup. | Missing and non-directory bases skip; available fixtures are removed. Reverting skip to the old fatal behavior makes both unavailable-base regressions fail; restored focused race suite passed. |
| 4519199383, source admission | Count incomplete context-only jobs in the same workspace under the same mutex as insertion. Default concurrency 1 with `BUILD_CONTEXT_MAX_ACTIVE_PER_WORKSPACE` override; nonpositive values use the named default. Reject excess requests before source acquisition, spooling, or background launch. | Registered-route test returned 202 for a second job before the fix, expected 409. Current tests cover duplicate IDs, default/negative fallback, configured concurrency 2 accepting second/rejecting third, completed jobs, other workspaces and normal node builds. Config loading covers default/override/invalid input. |

All three nits are implemented: discriminating terminal-Cloudflare/non-Cloudflare retention fixtures plus budget/cursor resume coverage; a bounded `vi.waitFor` in the shadow kickoff test; and redacted `serializeError` diagnostics for shadow collection/start failures. Error messages, credentials and R2 URLs are not newly exposed.

The concurrency bound is an admission limit, not a work truncation or retry queue. At the outer configured 2 GiB bundle limit, default 1 permits at most 2 GiB compressed spool per workspace; concurrency N permits at most N × 2 GiB. Each admitted attempt retains the existing 20-minute source deadline. If callers submit sequentially at that worst-case duration, one slot accommodates 3 attempts/hour; overflow attempts receive 409 immediately and are not retried automatically. A saturated shadow probe fails internally while the real node publish continues. No batch of files or required work is deferred by this bound. Existing scale evidence covers 100,000 files / 1.6 GB in 7.43s; it is repetitive payload, not a network-throughput claim.

Local validation after fixes:

- Affected API suite: **59 tests / 9 files PASS**.
- Go race checks: config/admission/source/context/fixture cases PASS (server 11.723s). The collector itself is unchanged; this focused run did not select its tests.
- API lint and typecheck PASS; runtime-tunable and agent-context budget checks PASS.
- Independent Go/security/constitution/environment review PASS; independent API/security/docs/integration review PASS. No reviewers pending.

The rooted collector, trusted-base acquisition, trailing `rel + "/."`, SigV4 binding, source PUT request and completion flow are unchanged from the earlier staging-tested source. Production changes are limited to callback policy delegation, cleanup error isolation/accounting, safe shadow diagnostics, and admission before context collection. Migrations are unchanged. Full CI and incremental CodeRabbit review remain to be reconciled at the pushed fix head.
