# GitHub trigger queue and subject routing (#2418)

## Problem

Busy GitHub triggers discard events. Same-subject comments need to reach one active run durably.

## Research

- Current main 88936885a retains busy events only as skipped executions.
- github-trigger-recovery.ts already owns durable signed intake, leases, bounded operational sweep; reuse it to drain execution queue.
- trigger_executions has stable delivery/trigger uniqueness and admission snapshot; waiting must not hold a run slot.
- ProjectData acceptPromptDelivery and getMailboxMessage provide durable idempotent delivery and existing sleeping-session recovery.
- Existing Ideas searched for GitHub; audit followups 01M4TBZJTKH78R14RQNNKC837N remain separate.
- Migration safety requires additive SQL; reservation must atomically repeat capacity and affinity predicates.

## Checklist

- [x] Agree schema ownership on feature.github-automation-2418 with sister/coordinator.
- [x] Add configurable bounded FIFO queue/TTL, immutable prompt/snapshot, atomic admission and stable identities.
- [x] Add opt-in repository+issue/PR affinity using existing durable prompt path, with persisted target audit.
- [x] Handle duplicate/concurrent intake, retries, missing/terminal targets, overflow, expiry and recovery fairness.
- [x] Expose queued/routed/dropped counts and audit target in trigger API and page.
- [x] Add real SQLite tests for sequential different issues, same-PR comments, expiry, concurrency and retries.
- [x] Update docs/config references.
- [x] Validate lint/typecheck/test/build and independent implementation/specialist review (final release validation remains open).
- [ ] Push branch; actual Opus 5.5 Chat review for any UI with desktop/mobile Playwright evidence.
- [ ] Coordinate staging ownership and validate final candidate before PR.
- [ ] PR, CI, CodeRabbit request/wait/findings, merge, basic production smoke.

## Acceptance

Two different issues at concurrency 1 both execute sequentially. Same-PR comments with affinity reach one run and sleeping sessions wake. Expiry/overflow are visible; retries/duplicates/concurrent admission create no duplicate agents and lose no accepted event.

## Scope

No PR watches (#2421). Sister owns #2419/#2420/#2422 filters/review events/MCP context. Optional cross-trigger PR ownership routing is excluded unless separately agreed. Never close #2418 with unmet agreed acceptance.

## Current evidence

- Pushed integration branch includes B930e8131a and A queue/routing, preserving agreed field ownership. Fresh main b73cfe50f adds marketing docs only; integration reconciliation pending after current quality run.
- Full A stable quality passed47 tasks: lint/typecheck/test/build, API13910 tests and web4764 tests. Integrated focused checks pass169 backend,77 web and14 desktop/mobile browser cases. Final integrated full quality is running.
- Workerd prompt delivery regressions pass5; signer37 tests cover bounded issues, PR comments, reviews and inline comments with stable replay. Requested review event subscriptions are checked before live signing.
- Queue/Cloudflare specialist PASS, security principal-through-wake PASS13 independently rerun tests, integrated completion implementation PASS/release WARN. Cleanup repeats predicates at final write and reports actual changes; managed reservations cannot be deleted or cleared.
- Two actual A Opus reviews requested changes. All A findings are addressed: uncertain vs definite drop, immutable audit links, counters/copy, cleanup race fence, queue controls beside overlap controls under Advanced, hours input, saved settings and realistic target fixtures. Final actual review approval remains required.
- Actual B Opus review at930e8131a requested changes (2 high,5 medium,8 low); B is remediating. Final combined actual Opus review will inspect both reports on the pushed integrated candidate before release.
- Eighteen A screenshots committed under tasks/evidence/2026-10-26-github-trigger-queue. Full combined browser run passes14 cases; no staging mutation or deployment yet.
- Staging harness uses existing smoke principal, normal APIs and existing CI-held signer. Bounded acceptance: sequential different issues, same-PR comments, sleeping wake, expiry and same-event inline burst; cleanup only owned fixtures. No independent staging deployment by B.
- #2419 expression/regex scope remains Idea01M5WE2TEWEBMCRF6YKCGE3EDT. #2420 mixed review/inline across separate triggers remains Idea01M5WKCK7431DQ4FKBWENZV9QJ and belongs to later shared PR ownership work; neither issue will be closed by this partial foundation. #2421 watches are excluded.
- No PR, staging acceptance, merge or production smoke has occurred yet. Release checklist remains open until evidence exists.

## Recovery I/O budget

The existing operations sweep additionally selects at most GITHUB_TRIGGER_RECOVERY_BATCH_SIZE pending executions (default25), ordered by attempted time for fairness. Expected new volume is bounded by per-trigger pending caps (default50); overflow is terminal audited immediately. Expiry cleanup is also bounded25. The drain's configurable20s default is a BETWEEN-candidate budget, not a hard wall-clock timeout: total cost is setup D1 work + approximately20s + one in-flight candidate. This is additional to the existing inbox recovery budget. Routing uses D1 and ProjectData durable acceptance/alarm work; VM waking runs through existing asynchronous operations. New admission reuses reserved submission: title generation (default5s timeout), repository authorization and ProjectData/TaskRunner RPCs, so one candidate has no newly asserted strict total bound. Do not abort an uncertain submission and retarget it. Waiting/tasklessqueued leave through submission, absolute TTL expiry or definite audited rejection; routing leaves through receipt reconciliation or TTL-bounded unconfirmed disposition for orphan targets. Task-bound admission keeps stable identity and follows existing task lifecycle rather than re-creating an agent.

## Final integration checkpoint

Current source9abcf9519 includes B3a2d77e2c and mainb73cfe50f. Full baseline47/47tasksPASS, API13929tests/web4769; later backend RPC-expiry regression17PASS and related63PASS, independent queue reviewPASS, APIlint/typecheckPASS. Final UI delta typecheck/lintPASS,80focusedwebtestsPASS and24desktop/mobilebrowsercasesPASS with60freshPNGs. Actual combined Opus report01M5WPE4XVPAFCJ2D3PPS1M1H0 verified all priorHIGH/MEDIUMfixed, then requested2MEDIUM9LOW changes. Those are fixed or explicitly justified in the evidence README; exactTTL display polish is Idea01M5WPPXJJ508RTDEW8NHZSC1F. Actual delta re-review required beforemerge. All four B original/recovered specialist reviewers completed; ledger in docs/audits/2026-10-26-github-trigger-controls.md.

Staging preflight18:01UTC: migration0208, one enabled platform compute credential, no active deployment, same3sleeping+1error pre-existingnodes. No staging mutations yet. Live sequential/wake/expiry/inline/review acceptance, task archive validation, PR/CI/CodeRabbit, merge and basic production smoke remain open. Final Opus delta review may run alongside the coordinated staging deployment; merge still waits for its approval.
