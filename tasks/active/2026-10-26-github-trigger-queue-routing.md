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

- Pushed candidate21e6bd0ab730561a1be30b8c855f0c92bf529f63 includes final B3a2d77e2c and mainb73cfe50f; field ownership preserved.
- Full integrated baseline47/47 quality tasks PASS: API13929tests and web4769tests. Later backend RPC-expiry regression17PASS, related63PASS, APItypecheck/lintPASS. Final UI80focusedtests and24desktop/mobilebrowsercasesPASS;60fresh captures committed together.
- Workerd durable prompt regressions5PASS; bounded replay signer37PASS. Real requested review subscriptions are checked before signing.
- All local queue/Cloudflare/security/completion reviewers PASS/ADDRESSED. All four B original/recovered reviewers finished; detailed lineage in docs/audits/2026-10-26-github-trigger-controls.md.
- Actual combined Opus report01M5WPE4XVPAFCJ2D3PPS1M1H0 verified all prior HIGH/MEDIUM fixes and requested2MEDIUM9LOW deltas. Final dispositions are in the queue evidence README. Actual delta review task01M5WQWV8QGFQV7EM3AWQHG239 uses exact required profile; approval still pending and blocks merge.
- Coordinated staging claimed channel41. Deployment40379145843 pinned to21e is running; migration0209 and safety gates PASS. No fixture mutation yet. Pre-existing3sleeping+1errornodes preserved; enabled platform compute credential confirmed.
- Live harness uses normal authenticated APIs and existing CI-held signer: sequential different issues, same-PR comments, sleeping wake, expiry, inline burst and review context; cleanup only owned fixtures.
- #2419 expressions/regex remain Idea01M5WE2TEWEBMCRF6YKCGE3EDT. #2420 mixed review/inline across separate triggers remains Idea01M5WKCK7431DQ4FKBWENZV9QJ for later canonical PR ownership. Both issues stay open; #2421 watches excluded. Exact TTL input polish remains LOW Idea01M5WPPXJJ508RTDEW8NHZSC1F; no expiry acceptance deferred.
- No PR, completed live acceptance, merge or production smoke yet. Release checklist stays open until evidence exists.

## Recovery I/O budget

The existing operations sweep additionally selects at most GITHUB_TRIGGER_RECOVERY_BATCH_SIZE pending executions (default25), ordered by attempted time for fairness. Expected new volume is bounded by per-trigger pending caps (default50); overflow is terminal audited immediately. Expiry cleanup is also bounded25. The drain's configurable20s default is a BETWEEN-candidate budget, not a hard wall-clock timeout: total cost is setup D1 work + approximately20s + one in-flight candidate. This is additional to the existing inbox recovery budget. Routing uses D1 and ProjectData durable acceptance/alarm work; VM waking runs through existing asynchronous operations. New admission reuses reserved submission: title generation (default5s timeout), repository authorization and ProjectData/TaskRunner RPCs, so one candidate has no newly asserted strict total bound. Do not abort an uncertain submission and retarget it. Waiting/tasklessqueued leave through submission, absolute TTL expiry or definite audited rejection; routing leaves through receipt reconciliation or TTL-bounded unconfirmed disposition for orphan targets. Task-bound admission keeps stable identity and follows existing task lifecycle rather than re-creating an agent.
