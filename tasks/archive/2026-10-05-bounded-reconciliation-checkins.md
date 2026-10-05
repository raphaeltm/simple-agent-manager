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
- [x] Durable per-session retry episode, idempotent delivered-attempt counting, explicit reset on human input or real tool progress.
- [x] Suppress known unsupported-model runtime errors before another check-in; bounded detection also handles legacy transcript errors.
- [x] One bounded Clef assessment at three unsuccessful check-ins; no fourth nudge, including unavailable/uncertain classifier; visible pause notice and attention marker.
- [x] Fence classifier completion against intervening human input/progress; survive restart and avoid repeated classifications/notice spam.
- [x] Candidate selection and alarm exclude paused episodes without blocking other sessions.
- [x] Regression tests through real SQLite, message persistence and reconciliation; cover duplicate callbacks, restart, errors, real progress, human reset, classifier races/outage, and saturation.
- [x] Config/env/docs synchronization and local checks.
- [x] Local specialist review and task-completion validation.
- Delivery gates (staging, PR/CI/CodeRabbit, merge and production deploy) tracked in `.do-state.md` and PR evidence.

## Acceptance
No more than three automatic nudges per no-progress episode. Permanent unsupported-model errors pause immediately. Automated messages/errors do not replenish budget. Human input or real tool progress may start a new episode. Classifier failures cannot restore retries; no destructive cleanup. One visible actionable notice. Tests prove repeated ticks do not re-arm paused candidates and other work remains reachable.

## References
`apps/api/.claude/rules/47-control-loop-io-budget.md`, `45-durable-object-concurrency-mutex.md`, `72-error-categories-must-match-the-recovery-action.md`.

## Review and validation evidence
Local Cloudflare/constitution, task-completion/test, env/docs/security reviewers passed after fixes for first-error ingress, nonconsecutive completed-tool replay, same-batch human/error ordering, and opaque auth-token redaction. Tool progress uses existing transcript insertion order as the replay ledger; the local lookup runs only after a check-in or during a pause, bounded by that session's retained transcript (no new per-tool records). The classifier reads at most the configured 200 messages / 24,000 characters and runs once with the existing 10-second timeout. Candidate volume narrows: paused sessions are excluded before D1 or remote work.

Focused reconciliation tests pass; real Workers RPC/SQLite pause-and-retry test passes. Surgical bypasses prove both fourth-nudge and A/B/A replay tests discriminate. Full lint/typecheck/build passed. Initial full tests: 812 API files passed, one unrelated dynamic-import timeout in session-sleep; complete sleep file passed on rerun. Final root lint, typecheck, test (21 tasks), and build (9 tasks) all passed. Staging run 37321174383 is underway; remaining delivery gates are tracked in .do-state.md.

## Post-mortem
The check-in continuation path introduced in `f41136e3d` cleared its candidate gate after each successful delivery, while assistant error messages resolved the check-in marker. Together these treated an error response as another opportunity to retry without an episode-level ceiling. Existing tests checked one delivery and acknowledgement rather than repeated errors across multiple alarm ticks. This PR adds durable episode accounting, genuine-progress reset rules, and multi-iteration/negative tests. Existing control-loop and error-category rules already require bounded work; no additional standing instruction is needed.

## Staging-discovered compatibility correction
First staging deployment37321174383 passed, including smoke tests. The deliberate invalid-model session showed that current Codex emits the exact unsupported-model message as bare text, separately from its warning, instead of the parent session JSON envelope. A new ingress regression failed before the fix; the parser now accepts that exact anchored runtime sentence as well as the legacy envelope. Added actual Workers batch-RPC coverage. All three reviewers passed the delta. A second staging deployment verifies the correction before merge.
