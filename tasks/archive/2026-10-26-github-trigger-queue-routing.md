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
- [x] Push branch; actual Opus 5.5 Chat review for any UI with desktop/mobile Playwright evidence.
- [x] Coordinate staging ownership and validate final candidate before PR.
- [ ] PR, CI, CodeRabbit request/wait/findings, merge, basic production smoke.

## Acceptance

Two different issues at concurrency 1 both execute sequentially. Same-PR comments with affinity reach one run and sleeping sessions wake. Expiry/overflow are visible; retries/duplicates/concurrent admission create no duplicate agents and lose no accepted event.

## Scope

No PR watches (#2421). Sister owns #2419/#2420/#2422 filters/review events/MCP context. Optional cross-trigger PR ownership routing is excluded unless separately agreed. Never close #2418 with unmet agreed acceptance.

## Current evidence

- Pushed source f76e77369659c1cd6862c5c8936ded5c0dec0cbb includes final sister3a2d77e2c and current mainb73cfe50f (reconciled again20:51UTC). Shared schema ownership preserved.
- Full integrated baseline47/47lint/typecheck/test/build tasks PASS (API13929/web4769). Later RPC expiry17/related63 tests and APItypecheck/lint PASS; final UI111focused/24browser/typecheck/lint PASS; narrowed GitHub error-correction68tests/4browser PASS. Final PR CI remains a release gate.
- All local queue/Cloudflare/security/completion reviewers PASS/ADDRESSED. All four sister original/recovered reviews completed; lineage in docs/audits/2026-10-26-github-trigger-controls.md.
- Actual required-profile Opus task01M5WQWV8QGFQV7EM3AWQHG239 final PASS at exact f76, zero open findings, all rubric scores4; independent80unit/24browser/17probes including320px. Library01M5WTFTH01MST9PQNW5N7HRSS/channel47. No UI source changed afterward. TTL unit polish remains Idea01M5WPPXJJ508RTDEW8NHZSC1F, preserving exact values.
- Coordinated staging40385983738 SUCCESS,12browser smoke tests PASS; active Worker exact commit:f76 and migration0209 verified. Initial10021 upload failure did not recur on one actual upload retry (430ms startup); no speculative config/source change.
- Live sequential signer40389354679 PASS: two different issues plus replays create exactly2rows; first runs, second waits/taskless at cap1. Normal first completion admits original waiting execution; both reply sequentially on one owned node.
- Affinity signer40392018612 PASS: two same-PR comments plus replays, exactly2rows/ONEtask/ONEsession/two replies; immutable routed audit target confirmed.
- Sleeping wake signer40395075615 PASS: normal task/session/workspace sleep verified; one new follow-up plus replay wakes SAME original task/session, three replies/two routed rows. Existing predecessor deletion fence retries then restores normally on same node; no direct state writes or event resend. Client15s timeout left a bounded sleep claim; normal recovery completed it. Temporary harness joins streaming fragments and tolerates404 of a removed sleeping predecessor workspace.
- Expiry signer40396532269 PASS: TTL3 roundtrip; different issue waits taskless behind cap1, then dropped/queue_expired, no extra task.
- Inline40397144489 and same-trigger submitted review40398575145 PASS: exactly3rows/2routed/ONEtask/three replies with expanded file/line and changes_requested context. Sequential event-type editing of ONE trigger does not claim mixed-event cross-trigger ownership.
- Authenticated desktop1280/mobile375 dashboard/projects/settings/Automation/detail/editor PASS, no console errors or horizontal overflow. Saved queue7/0.25hours/affinity controls inspected at both widths; two fixture-only screenshots retained alongside60mock captures.
- All three owned triggers/task/workspace fixtures cleaned via normal APIs. Single owned node01M5WVWVB8AJMW1BY1VE13Z3FS removed20:52:47 after all tasks terminal and stopped-workspace deletion. Four pre-existing nodes untouched. Bounded raw observations: tasks/evidence/2026-10-26-github-trigger-queue/staging-acceptance.json.
- Nonblocking receipt-only reconciliation robustness Idea01M5WXKHJA7MMM9SSHFYE0DJR7; no observed event loss. Existing five-minute recovery audit latency is expected.
- #2419 expressions/regex Idea01M5WE2TEWEBMCRF6YKCGE3EDT remains open; #2420 mixed cross-trigger review/inline ownership Idea01M5WKCK7431DQ4FKBWENZV9QJ remains open for future canonical PR ownership; no #2421 watches.
- Remaining release gates: final archive validation, ONE PR/screenshots, CI, CodeRabbit request/wait/findings, merge, production deploy and BASIC smoke. No PR/merge/production smoke claimed yet.

## Recovery I/O budget

The existing operations sweep additionally selects at most GITHUB_TRIGGER_RECOVERY_BATCH_SIZE pending executions (default25), ordered by attempted time for fairness. Expected new volume is bounded by per-trigger pending caps (default50); overflow is terminal audited immediately. Expiry cleanup is also bounded25. The drain's configurable20s default is a BETWEEN-candidate budget, not a hard wall-clock timeout: total cost is setup D1 work + approximately20s + one in-flight candidate. This is additional to the existing inbox recovery budget. Routing uses D1 and ProjectData durable acceptance/alarm work; VM waking runs through existing asynchronous operations. New admission reuses reserved submission: title generation (default5s timeout), repository authorization and ProjectData/TaskRunner RPCs, so one candidate has no newly asserted strict total bound. Do not abort an uncertain submission and retarget it. Waiting/tasklessqueued leave through submission, absolute TTL expiry or definite audited rejection; routing leaves through receipt reconciliation or TTL-bounded unconfirmed disposition for orphan targets. Task-bound admission keeps stable identity and follows existing task lifecycle rather than re-creating an agent.

- Nonblocking receipt-only reconciliation robustness followup: Idea01M5WXKHJA7MMM9SSHFYE0DJR7. Existing acknowledged receipts currently pass through idempotent acceptance before classification; no staging event loss observed.

Final pre-archive task-completion/doc-sync review: PASS for BOTH combined tasks at f76 after all live acceptance and cleanup; no missing implementation acceptance. Release checkboxes intentionally remain pending until the combined PR completes CI, CodeRabbit, merge/deploy and basic production smoke.
