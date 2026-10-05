# Bound repeated reconciliation check-ins

## Problem
The weekly production review chat_01M45MRD2N4KTMCCXHVB9B5AK2 produced 24 identical unsupported-model errors and 23 automated check-ins without doing the review. User authorized a durable three-check-in limit, immediate permanent-error suppression, and Clef escalation.

## Research
- `message-persistence.ts` resolves reconciliation markers for every assistant message, including runtime errors.
- `reconciliation.ts` clears candidate gates after accepted check-ins; probe counters therefore do not bound delivered check-ins.
- Candidate selection and alarm scheduling must agree on stopped episodes; use existing attention markers and durable DO metadata.
- Existing `scheduled/stalled-task-classifier.ts` supplies bounded, sanitized Clef calls, but its hour-long inactivity gate cannot classify this fast retry loop.
- Preserve work and model selection; no runtime teardown or model downgrade. Compatibility fix/health review execution is separate.

## Checklist
- [ ] Durable per-session retry episode, idempotent delivered-attempt counting, explicit reset on human input or real tool progress.
- [ ] Suppress known unsupported-model runtime errors before another check-in; bounded detection also handles legacy transcript errors.
- [ ] One bounded Clef assessment at three unsuccessful check-ins; no fourth nudge, including unavailable/uncertain classifier; visible pause notice and attention marker.
- [ ] Fence classifier completion against intervening human input/progress; survive restart and avoid repeated classifications/notice spam.
- [ ] Candidate selection and alarm exclude paused episodes without blocking other sessions.
- [ ] Regression tests through real SQLite, message persistence and reconciliation; cover duplicate callbacks, restart, errors, real progress, human reset, classifier races/outage, and saturation.
- [ ] Config/env/docs synchronization and local checks.
- [ ] Local specialist review, staging verification, PR/CI/CodeRabbit, merge and production deploy.

## Acceptance
No more than three automatic nudges per no-progress episode. Permanent unsupported-model errors pause immediately. Automated messages/errors do not replenish budget. Human input or real tool progress may start a new episode. Classifier failures cannot restore retries; no destructive cleanup. One visible actionable notice. Tests prove repeated ticks do not re-arm paused candidates and other work remains reachable.

## References
`apps/api/.claude/rules/47-control-loop-io-budget.md`, `45-durable-object-concurrency-mutex.md`, `72-error-categories-must-match-the-recovery-action.md`.
