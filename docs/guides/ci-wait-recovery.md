# CI waits and PR shepherd recovery

GitHub event types include their action. Subscription matching is exact, including
commit subjects. Obtain `headRefOid` using `gh pr view <PR> --json headRefOid`;
never copy an abbreviated SHA from a log. A CI completion filter looks like:

```json
{
  "version": 1,
  "source": "github",
  "eventType": ["check_run.completed", "check_suite.completed", "workflow_run.completed"],
  "subjectType": "commit",
  "subjectId": "0123456789abcdef0123456789abcdef01234567"
}
```

Replace the example SHA with the current PR's full 40-character head SHA. Bare
`check_run`, `check_suite`, and `workflow_run` do not match completion events.

## Owner: check, subscribe, reconcile

1. Read current PR state/head and checks (`gh pr view`, `gh pr checks`); record
   pending check names and run URLs. If terminal, continue the existing gates;
   completion includes failures and is not permission to merge.
2. Subscribe only while relevant checks are pending. Check GitHub again immediately
   after subscribing to catch completion between the first read and registration.
3. Before yielding, persist PR URL, full SHA, subscription ID/expiry and a concrete
   fallback deadline chosen for the pending runs. Use `create_project_schedule`
   with `action.kind = "message_session"` and your current session ID for one
   bounded reconciliation, independent of the subscription expiry. Confirm creation
   and retain the schedule ID. Scheduling is not proof the recipient executed.
   If unavailable/rejected, report the precise blocker to the coordinator; do not
   leave an unbounded wait. Expiry alone does not wake the session.
4. On any resume, read GitHub again and list your subscriptions with `state: "any"`.
   An expired/cancelled subscription, a changed head, or terminal checks invalidates
   the old wait. Cancel only your obsolete subscriptions/schedules. A changed
   filter needs a new idempotency key; retrying the same create keeps its key.
5. Renew only for genuinely pending current-head checks. After one fallback with
   no progress, report pending runs, subscription and schedule delivery status,
   and the next explicit recovery action to the coordinator. Do not repeatedly
   recreate the same wait. Cancel your redundant fallback when work progresses.

## Shepherd: preserve ownership without preserving a dead wait

First use the existing branch/PR owner lookup and inspect its returned filter
scope. An error or missing scope is inconclusive, not evidence of no owner.
Check current PR head/checks and the owner's latest persisted status before
classifying it as waiting. A sleeping task or stale continuation alone does not
prove an active subscription or a future wake. Subscription tools are caller
scoped: do not claim to inspect another owner's subscriptions with your own token.

If checks finished, the recorded head changed, or the recorded wait/fallback
expired, send the existing owner one durable reconciliation request with PR URL,
full current SHA and check/run evidence. Record delivery ID and a bounded follow-up
deadline. At that follow-up inspect delivery/execution evidence; accepted delivery
is not proof of processing. If the owner cannot resume, report its exact task,
session and platform error to the coordinator for supported recovery or an explicit
single-owner handoff. Do not repeatedly wake a broken session, silently defer each
sweep, create a competing implementation owner, or change credentials/state in a DB.

This guidance changes no matching, expiry, ownership or release-gate semantics.
It does not update a deployed shepherd schedule's prompt; operators maintaining
that prompt should incorporate this procedure through the supported interface.
