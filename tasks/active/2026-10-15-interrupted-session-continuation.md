# Continue interrupted work after eviction in every session mode

## Problem and evidence
Production chat 5d4e32b6-4831-4f98-84d9-292e32330d95 was evicted for memory pressure at 14:18:15 UTC, restored on another node at 14:25:11, and did not generate until the user's 14:36 follow-up. Its saved taskMode was conversation; recoveryNextStep only continues task-mode work.

## Research
- session-recovery-task.ts and session-sleep-fallback-messages.ts already supply durable restoredSessionPrompt delivery (PR #2300).
- VM eviction_delivery.go writes a durable intent before Docker stop, then upgrades the same callback record after stop. Capture work state there, retain it through retries/restarts; never infer idleness after stop.
- ACP SessionHost knows prompt ownership and harness background work. Idle requires both prompt ended and no in-flight work. Child tasks do not keep the parent active.
- Callback auth/generation fencing and existing recovery claims must remain intact. Older agents need additive protocol compatibility.
- Rules: 49 capture prerequisites, 53 liveness/idleness, VM 54 rollout compatibility, 23/35 cross-boundary coverage.

## Checklist and acceptance
- [x] Capture pre-stop agent work state without taskMode and persist with eviction intent.
- [x] Carry state through authenticated callback and recovery; active conversational/task sessions receive durable continuation, known idle sessions do not.
- [x] Define legacy/missing evidence behavior explicitly; preserve queued-message wakes.
- [x] Test active/idle/background work, persistence restart and retries, fresh and restored recovery, generation fencing and ordinary follow-up.
- [x] Update affected architecture documentation.
- [x] Run appropriate lint/typecheck/tests/build and local specialist reviews.
- [ ] Deploy staging; verify real VM heartbeat/access and recovery behavior; clean up resources.
- [ ] PR, green CI, CodeRabbit request/wait, merge and production deployment verification.

## Verification and review
- TDD before fix: active conversation and idle task controls failed (2 failed, 7 passed).
- Targeted API suite: 40 passed. Real Workers/DO suite: 19 passed, including both modes restored/fresh and idle controls.
- Go eviction suites pass with race detector for ACP, persistence and HTTP callback server.
- Root lint 13/13, typecheck 19/19, build 9/9 tasks passed. Full repository suite passed 21/21 tasks (12,383 API, 4,057 web tests).
- Go/security review found and resolved lock inversion and prompt-after-capture race: capture takes mu then promptMu and closes admission; precommit failure rolls it back, preserving a prior fence. Re-review PASS.
- Cloudflare/constitution PASS; completion/test/docs PASS. Newer human directions take priority in continuation wording.
- Task-only push to main was rejected by required Workers check; task travels in this feature PR without bypass.

- Full Go ACP/server suites pass; persistence passes after updating the existing v18 fixture to rewind v19 as well (review PASS). Legacy v18 eviction migration test passes.
- Staging deployment 38764663063 at runtime SHA 7a1e927da passed including smoke tests. Live bounded verification in progress; bb70b6732 changes only the test fixture.

## Post-mortem
The runtime-loss continuation added in PR #2300 used task mode as a proxy for unfinished work. Conversational sessions can perform implementation work, while task sessions can already have returned control. Regression coverage now crosses both modes with active/idle ownership and tests the persisted callback evidence, migration, restart, retries, and real DO restored/fresh prompt paths. Existing capture-before-teardown guidance applies; no new standing instruction needed.
