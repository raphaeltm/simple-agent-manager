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
- [ ] Capture pre-stop agent work state without taskMode and persist with eviction intent.
- [ ] Carry state through authenticated callback and recovery; active conversational/task sessions receive durable continuation, known idle sessions do not.
- [ ] Define legacy/missing evidence behavior explicitly; preserve queued-message wakes.
- [ ] Test active/idle/background work, persistence restart and retries, fresh and restored recovery, generation fencing and ordinary follow-up.
- [ ] Update affected architecture documentation.
- [ ] Run appropriate lint/typecheck/tests/build and local specialist reviews.
- [ ] Deploy staging; verify real VM heartbeat/access and recovery behavior; clean up resources.
- [ ] PR, green CI, CodeRabbit request/wait, merge and production deployment verification.
