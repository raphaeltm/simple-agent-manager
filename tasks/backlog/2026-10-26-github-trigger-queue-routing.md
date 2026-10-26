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
- [ ] Agree schema ownership on feature.github-automation-2418 with sister/coordinator.
- [ ] Add configurable bounded FIFO queue/TTL, immutable prompt/snapshot, atomic admission and stable identities.
- [ ] Add opt-in repository+issue/PR affinity using existing durable prompt path, with persisted target audit.
- [ ] Handle duplicate/concurrent intake, retries, missing/terminal targets, overflow, expiry and recovery fairness.
- [ ] Expose queued/routed/dropped counts and audit target in trigger API and page.
- [ ] Add real SQLite tests for sequential different issues, same-PR comments, expiry, concurrency and retries.
- [ ] Update docs/config references.
- [ ] Validate lint/typecheck/test/build, independent specialist review, task completion.
- [ ] Push branch; actual Opus 5.5 Chat review for any UI with desktop/mobile Playwright evidence.
- [ ] Coordinate staging ownership and validate final candidate before PR.
- [ ] PR, CI, CodeRabbit request/wait/findings, merge, basic production smoke.

## Acceptance
Two different issues at concurrency 1 both execute sequentially. Same-PR comments with affinity reach one run and sleeping sessions wake. Expiry/overflow are visible; retries/duplicates/concurrent admission create no duplicate agents and lose no accepted event.

## Scope
No PR watches (#2421). Sister owns #2419/#2420/#2422 filters/review events/MCP context. Optional cross-trigger PR ownership routing is excluded unless separately agreed. Never close #2418 with unmet agreed acceptance.
