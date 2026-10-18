# CI waits and PR ownership recovery

GitHub subscription filters are exact/set matches. For CI completion, use source `github`, eventType `["check_run.completed", "check_suite.completed", "workflow_run.completed"]`, subjectType `commit`, and subjectId equal to the current full 40-character PR head SHA. Bare event names and abbreviated SHAs do not match.

1. Read the current PR head, required checks, and conclusions. Do not wait on checks that already finished.
2. Create the subscription, inspect its returned expiry and wake instructions, then re-read current head/check state to close the subscription race. If the head changed, cancel the obsolete subscription and reconcile against the new head.
3. Before ending the turn, record the PR, full head SHA, subscription ID, pending checks, expiry, and a supported bounded fallback/recovery mechanism. Expiry alone does not wake the owner. If no independent recovery wake is available, report that limitation rather than claiming a guaranteed continuation.
4. On an event or fallback, fetch and acknowledge relevant deliveries and re-read current head/check state. One completed check is not evidence that all required checks passed. Cancel subscriptions when no longer needed. Use `list_project_event_subscriptions` with `state: "any"` to detect an expired/cancelled wait; renew only after reconciliation confirms remaining work, with a new documented recovery bound.

A supported independent fallback is `create_project_schedule` with a one-off
`message_session` action targeting your own session, a concrete `dueAt` deadline
and a stable retry idempotency key. Persist the returned schedule ID and inspect
creation errors; acceptance is not execution. Cancel your redundant schedule when
checks finish. After one fallback without progress, report pending run URLs and
the delivery/owner blocker rather than blindly renewing the same wait.

## Shepherd reconciliation

Preserve legitimate active ownership, but do not treat a historical subscription or recorded continuation as proof of a live wait. Verify fresh owner/task/session state, the current PR head and checks, and available subscription expiry/recovery evidence. When own-scope APIs cannot inspect another agent's subscription, record the gap and request a bounded owner reconciliation through supported messaging; do not bypass scope or infer liveness.

For an expired or invalid wait, or when checks are already terminal, request one owner reconciliation and verify its delivery/start outcome. A queued message is not proof that the owner resumed. If the wake remains blocked, record the exact blocker and escalate or transfer ownership only through the authorized workflow. Avoid repeated wake loops, duplicate owners, and automatic takeovers based solely on elapsed time. Merge only after the normal review and check gates pass for the current head.
