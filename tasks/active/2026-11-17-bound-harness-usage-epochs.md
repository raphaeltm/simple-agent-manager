# Bound harness usage writes without deleting history (PR #2863)

## Problem and research

Authenticated runtime reporters choose token-usage epochs and model names. The callback allows120 reports/minute and16models/report (up to1920new rows/minute/session); a rate limit does not bound lifetime storage. Migration0253 indexes project/session/source/epoch/model/credential. Accounts exposes7/30/90day windows; age-based retention is a separate data-loss decision and remains Idea01M7JPRW3JPBE0C3CPMR95WAZB. Scanner retention work remains preserved in original commit5ab78cb9c30be37874647099e2b3676201b3630a.

Classes: security-sensitive-change, business-logic-change, cross-component-change, docs-sync-change. No new trust/auth model or secrets. Billable data is measured token usage; proxy responses aggregate separately and readers prefer measured proxy usage over harness reports to avoid double counting. No compute billing change.

Data flow: combined projects callback router → callback JWT/schema/lifecycle/session/credential binding → recordHarnessTokenReport → recordHarnessRunUsage → D1 agent_run_usage → operations readRunUsage/summarizeRunTokens → task receipt. Credential-limit observations follow token storage and must still persist when novel keys are refused.

## Implementation checklist

- [ ] Verify exploit through real callback and realSQL, prove tests fail without guard.
- [x] Atomic bounded novel-row admission across epochs/models/credentials, preserving retries/reordering and existing counters even in mixed rejected reports.
- [x] Bound existing-row scan on legacy over-cap runs; no history deletion or retention migration.
- [x] Use canonical typed admin setting and cached resolver, no redundant env knobs.
- [ ] Cover multi-model, whitespace alias, credential switch, cross-project/chat, default cap, lowered cap and concurrent final-slot callbacks.
- [ ] Prove credential-limit reporting and receipt remain functional at cap.
- [x] Document bounds, I/O budget and throughput; preserve residual retention in existingIdea.
- [ ] Complete full local checks and independent security/Cloudflare/test/constitution/docs/completion reviews.
- [ ] Ready original PR and request CodeRabbit, verify exact-headCI; leased real staging checks and cleanup; merge only after all gates; basic production health.

## Acceptance criteria

At most configured lifetime harness rows per project/chat; preexisting rows remain unchanged unless valid cumulative counters grow. Whole novel model sets admit atomically or are refused while existing keys update. Concurrent callback writers cannot exceed final capacity. Proxy accounting, callback attribution/credential observations and owner receipt controls continue working. No user history deletion. Default256 rows and admin range1..10000; statement scans at most cap+1 old index entries and16incoming models,11SQL binds. At maximum10000rows, a one-model fresh-epoch flood fills in~84minutes at120/min, then writes no further novel rows; this is an admission ceiling, not deferred work. Each callback report issues one usage statement plus at most one cache-miss settings read; final endpoint round-trip inventory must fit mutation budget12 or consolidate before merge.

## References

PR2863; existingIdea01M7JPRW3JPBE0C3CPMR95WAZB; rules28,31,35,60,62,69,81; no-secret-readback policy795e72a6. Parent task01M7NB9FZNC4CXG6MGXJDQJM1C owns sequential five scanner completions.

## Implementation evidence (in progress)

Original mainwriter independently reproduced1024fresh epochs/1024rows. Candidate preserves existing10001-row legacy history while blocking growth and allowing cumulative updates; query-plan regression requires materialized count/admission and covering index. Surgical removal of the admission WHERE produced6unit failures/20total and2Workers failures/6total; restored guarded source. Unit+admin44PASS including admin update/range/reset/cache and failclosedcap1outage. Workers6PASS before final fullcredential-I/O/receipt enhancement (rerun pending). Independent security/CF review found accidental existingregistryargument and wideningoutage fallback; fixed both. Testreview gaps addressed via largelegacyplanfixture/adminmutation/fullI/O/atcapreceipt; rereview pending.

Taskplan-only mainpush was refused by branchprotectionGH013 requiredWorkers after normal integration of concurrentmain. Plan carried in originalfeaturePR instead; no bypass. No user-facing retention selected and no history deleted.
