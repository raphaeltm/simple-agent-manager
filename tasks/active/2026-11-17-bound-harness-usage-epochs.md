# Bound harness usage writes without deleting history (PR #2863)

## Problem and research

Authenticated runtime reporters choose token-usage epochs and model names. The callback allows120 reports/minute and16models/report (up to1920new rows/minute/session); a rate limit does not bound lifetime storage. Migration0253 indexes project/session/source/epoch/model/credential. Accounts exposes7/30/90day windows; age-based retention is a separate data-loss decision and remains Idea01M7JPRW3JPBE0C3CPMR95WAZB. Scanner retention work remains preserved in original commit5ab78cb9c30be37874647099e2b3676201b3630a.

Classes: security-sensitive-change, business-logic-change, cross-component-change, docs-sync-change, schema-migration, ui-change. No new trust/auth model or secrets. Billable data is measured token usage; proxy responses aggregate separately and readers prefer measured proxy usage over harness reports to avoid double counting. No compute billing change.

Data flow: combined projects callback router → callback JWT/schema/lifecycle/session/credential binding → recordHarnessTokenReport → recordHarnessRunUsage → D1 agent_run_usage → operations readRunUsage/summarizeRunTokens → task receipt. Credential-limit observations follow token storage and must still persist when novel keys are refused.

## Implementation checklist

- [x] Verify exploit through real callback and realSQL, prove tests fail without guard.
- [x] Atomic bounded novel-row admission across epochs/models/credentials, preserving retries/reordering and existing counters even in mixed rejected reports.
- [x] Bound existing-row scan on legacy over-cap runs; no history deletion or retention migration.
- [x] Use canonical typed admin setting and cached resolver, no redundant env knobs.
- [x] Cover multi-model, whitespace alias, credential switch, cross-project/chat, default cap, lowered cap and concurrent final-slot callbacks.
- [x] Prove credential-limit reporting and receipt remain functional at cap.
- [x] Document bounds, I/O budget and throughput; preserve residual retention in existingIdea.
- [ ] Complete full local checks and independent security/Cloudflare/test/constitution/docs/completion reviews.
- [ ] Ready original PR and request CodeRabbit, verify exact-headCI; leased real staging checks and cleanup; merge only after all gates; basic production health.

## Acceptance criteria

At most configured lifetime harness rows per project/chat; preexisting rows remain unchanged unless valid cumulative counters grow. Whole novel model sets admit atomically or are refused while existing keys update. Concurrent callback writers cannot exceed final capacity. Proxy accounting, callback attribution/credential observations and owner receipt controls continue working. No user history deletion. Default256 rows and admin range1..10000; Each of two statements in one atomic D1 batch scans at most cap+1 old index entries and16incoming models,11SQL binds per statement (maximum20002 existing index entries/report). At maximum10000rows, a one-model fresh-epoch flood fills in~84minutes at120/min, then writes no further novel rows; this is an admission ceiling, not deferred work. Each callback report issues one D1 batch of refusal metadata then usage UPSERT plus at most one cache-miss settings read; final endpoint round-trip inventory must fit mutation budget12 or consolidate before merge.

## References

PR2863; existingIdea01M7JPRW3JPBE0C3CPMR95WAZB; rules28,31,35,60,62,69,81; no-secret-readback policy795e72a6. Parent task01M7NB9FZNC4CXG6MGXJDQJM1C owns sequential five scanner completions.

## Implementation evidence (in progress)

Original mainwriter independently reproduced1024fresh epochs/1024rows. Candidate preserves existing10001-row legacy history while blocking growth and allowing cumulative updates; query-plan regression requires materialized count/admission and covering index. Surgical removal of the admission WHERE produced6unit failures/20total and2Workers failures/6total; restored guarded source. Unit+admin44PASS including admin update/range/reset/cache and failclosedcap1outage. Expanded Workers6PASS including fullcredential-I/O and owner receipt after cap/mixed rejection. Independent security/CF review found accidental existingregistryargument and wideningoutage fallback; fixed both. Final runtimehead94836719 security/Cloudflare/test/constitution/docs reviews PASS; completion A-F found no omitted code. Release gates remain pending.

Taskplan-only mainpush was refused by branchprotectionGH013 requiredWorkers after normal integration of concurrentmain. Plan carried in originalfeaturePR instead; no bypass. No user-facing retention selected and no history deleted.

SonarCloud currenthead94836719 reports only duplicate test setup (29newlines/5.5% overall), zero issues/security findings. Shared withUsageCap fixture now owns cap seeding/session creation/cleanup for both capped tests; identical assertions and real trigger preserved, Workers6/6 rerun PASS. No quality threshold or exclusion changed. Full local lint/typecheck PASS; test/build still pending.

Full-suite follow-up: 1092 API suites/16656 tests passed; one suite failed collection because its logger mock hid createModuleLogger newly reached by canonical settings. Preserve real logger exports with importOriginal while retaining existing log spies; proxy43/43 PASS, independent test review PASS. Full quality rerun pending. No production runtime delta.


## Received review: disclose admission loss

Codex review discussion_r4607495621 on939c3974 correctly identified that rejected usage appeared complete. Added migration0260 with one sticky `(project_id,chat_session_id,last_rejected_at)` row per affected run; no history delete/backfill, no new trust model or credentials. Only `recordHarnessRunUsage` writes this metadata, in the same atomic D1 batch before the guarded usage UPSERT. Proxy accounting does not use harness admission and needs no marker. Existing-key updates, cap increases and reordered reports never erase the marker. Shared receipt and Accounts reads consume it in their existing round trip; complete proxy measurements still take precedence. Accounts includes recent refusals and recently updated admitted harness rows of previously limited runs, respecting7/30/90day windows.

UI alternatives considered: retain Not reported with a warning note, or use the existing token tile with Incomplete and a specific note. Selected Incomplete to distinguish known refused reports from absent reporting without new layout/controls. Existing reported totals retain +; priced incomplete totals use At least. Mobile/desktop dark/light audit must pass before commit, with screenshot review and durable PR links. Marker-only receipt retains state not_reported plus limited:true rather than inventing measured zero tokens.

Disclosure RED proof: two new limited assertions failed on939c before implementation (false rather than true). Focused SQLite23, Accounts/proxy51 and Workers6 pass on work in progress; full/new final-head verification pending. Added marker-only real callback→receipt, sticky retry/credential/reordered timestamp, atomic rollback, Accounts reporting-window/proxy and rendered UI regressions. New migration is additive; existing rows retain all capabilities/history. More than100SQL binds are never needed.


Completion review caught a second edge: marker-only Accounts response flagged partial data, but no card/token rows meant no visible warning. Chose existing page Notice over per-card footnotes so zero cards cannot hide disclosure. Rendered marker-only regression RED (1failed/1controlpassed) before notice, GREEN17/17 combined receipt/Accounts after. Added real-app mocked Accounts scene and both-theme mobile/desktop audit. Receipt audit20/20passed with screenshots independently reviewed (scores4/4/4/4/5), durable PRcomment6965358284. Current expanded Workers7/7PASS, SQL38PASS, Accounts/proxy51PASS; final-head fullquality/reviews/CI/stagingpending. Accounts metadata probes seek project/time indexes, join exactPK, and worst-case scan only the selected reporting-window population, linear in recentrows (no N² correlated history scan or per-row network calls).


Disclosure candidate verification before final integration: root test41/41tasksPASS (API1096suites16733testsPASS; web5391testsPASS), typecheck38/38tasksPASS, build19/19tasksPASS. Initial lint found import order in operations and a new API test; corrected without runtime change. The final Accounts page notice was added after that root run: rendered17PASS and actualbrowserAccounts18PASS, both mobile/desktopthemes, screenshots inspected with noissues. Final integrated-head checks/reviews remain required. Additive migration0260 is the only new migration; main0259 preserved. No history purge or marker backfill.
