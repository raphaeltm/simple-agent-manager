# Make Codex rate-limit tests deterministic

## Problem
PR2722 CI43570510620 attempt2 failed the window rollover assertion with an exact60second discrepancy. Web5228/5228passed. Keep PR2722 unchanged at coordinator-approved5b86fdd85ad6a2451c0671532abf4afd7ae7c8f1; do not retry blindly.

## Research
`apps/api/tests/unit/durable-objects/codex-refresh-lock.test.ts` computes its expected minute before awaited SQLite/crypto setup. Production `enforceRateLimit` independently samples Date.now when handling the request. A wall-clock minute crossing changes the expected window. Production resets stale buckets correctly; no production boundary defect established. Adjacent429test shares the same clock race.

## Checklist
- [x] Inspect test setup and production rate-limit window selection.
- [ ] Freeze only Date within the rate-limit suite and restore it afterward; leave async timers real.
- [ ] Cover immediately before, exactly at, and immediately after a minute boundary with strict expected-window/count assertions.
- [ ] Run30repeat executions including boundary cases and the full file.
- [ ] Temporarily remove production rollover guard, prove regression tests fail, restore production source unchanged.
- [ ] Run affected lint/typecheck and review completion/testing/Cloudflare implications.
- [ ] Open separate DRAFT PR plus needs-human-review and hand coordinator exactSHA; no staging for test-only change per coordinator.

## Acceptance
Deterministic boundary tests retain strict429/200,count,window assertions and detect removal of rollover behavior. Production code unchanged. Validation/review evidence recorded. Coordinator exact-head approval required before readiness/merge; then refresh PR2722 once for new main merge ref.

## References
Coordinator event0c278241-6b90-4569-8b77-a3fc10d62102; `/do`; API AGENTS.md; test-engineer and task-completion-validator skills.
