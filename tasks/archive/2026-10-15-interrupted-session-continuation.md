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

## Implementation archive and release handoff
Implementation completion re-reviewed PASS after merging main at 0b0dd3ce3 (PR #2359). All research, checklist implementation, acceptance regression, cross-boundary and docs checks passed. Integrated recovery/attachment delivery tests: 73 passed; real Workers recovery tests: 19 passed. The shared TTS startup prerequisite is upstream and absent from this PR's effective diff.

Staging deployment and smoke tests passed. Authenticated Playwright dashboard, projects and settings loaded real data without page errors. Configured-pool node 01M506FJ57AEH324BF1FJEZVFJ first heartbeat was 16:34:28 UTC, reporting implementation binary 3333ab9a0. Replacement smoke session b3211a64-47e5-403e-b8ce-531b4bee64a2 completed its ACP prompt at 16:38:36 and awaited follow-up. The first fixture used an invalid permission mode; it was corrected and its workspace deleted before reuse of the same node.

Operational gates above remain unchecked: exact response/sleep-wake readback, cleanup, CI/review and production verification. They are tracked in PR #2362 and `.do-state.md`; this archive records implementation completion, not completion of the user's shipping request. Cleanup resumes after the 17:00 UTC test-login rate window resets, using a reused authentication context. No shared pool mutation or forced node-wide memory pressure was used. Forced-eviction delivery is covered by Go race and real Workers tests; live verification does not claim that scenario.

Sonar follow-up: extracted the unchanged recovery decision and table-driven Go test bodies, centralized tri-state assertions, and documented the no-host rollback. All six reported maintainability findings addressed without changing behavior. API regression 10/10 and race suites across ACP/persistence/server pass; Go and API reviewers re-reviewed PASS. Final hosted analysis remains a release gate.

Final CI exposed an unrelated existing GCP credential-form test race: the API-call assertion could complete before React rendered secret removal. The test now waits for the existing callback and secret-removal assertions together. All 18 credential-form tests pass; completion reviewer PASS. No UI/product behavior changed.
