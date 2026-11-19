# CI waits and PR shepherd recovery

GitHub event types include their action. Subscription matching is exact, including
commit subjects. Obtain `headRefOid` using `gh pr view <PR> --json headRefOid`;
never copy an abbreviated SHA from a log. For ordinary all-CI waits, default to terminal suite/workflow events:

```json
{
  "version": 1,
  "source": "github",
  "eventType": ["check_suite.completed", "workflow_run.completed"],
  "subjectType": "commit",
  "subjectId": "0123456789abcdef0123456789abcdef01234567"
}
```

Replace the example SHA with the current PR's full 40-character head SHA. Bare
`check_run`, `check_suite`, and `workflow_run` do not match completion events.

Opt in to `check_run.completed` only for early per-job failure or job-specific
progress. Add it to the terminal event set when those notifications are needed;
ordinary all-CI waits avoid per-job storage and wakes.

A `check_suite.completed` summarizes the checks from one GitHub App for a commit
(for example CodeRabbit or Sonar when they publish Checks API runs).
`workflow_run.completed` covers one GitHub Actions workflow run, including this
repository's CI. Both carry failure conclusions: completion is not success.
A commit usually has several workflows and suites (CI, CodeRabbit request, Sonar,
deploy); each terminal completion can cause a separate wake. Neither says every
workflow, app or rerun on the SHA has finished. Reconcile all
current checks and required review/release gates before proceeding.

SAM's GitHub producer uses `head_sha` for commit subjects and retains conclusions
(`apps/api/src/services/github-project-event-producer.ts`, `resolveSubject` and
`buildMetadata`); the matcher uses exact event type sets and subjects
(`packages/project-data/src/do/project-events-normalization.ts`,
`filterMatchesProjectEvent`). The generated App manifest subscribes to both types
with Checks/Actions read access (`scripts/deploy/utils/github.ts`). GitHub documents
[per-app suites and their conclusions](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks)
and [workflow completion, including failures](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run).

A usable terminal event is not guaranteed: status-only providers have no Checks
suite, an app may never finish its suite, webhook configuration/permissions or
delivery may be missing, and fork/merge-commit setups may report a different SHA.
Keep the bounded fallback below and **reconcile GitHub on every resume**, including
checks, statuses and reviews. Do not rely on subscription expiry or add per-job
subscriptions as a substitute for reconciliation.

This is product-wide agent guidance, not a matcher change. Existing active
subscriptions are not migrated; they expire naturally. Savings ramp in as new
sessions pick up the instructions and create narrower subscriptions.

Draft pull requests run only the quick CI checks (`.github/workflows/ci.yml`: every
full-suite job is skipped when `github.event.pull_request.draft` is true). A green
draft run says nothing about the test suites, and the required `Durable Object
Workers` check is not reported for it. Mark the PR ready (`gh pr ready <PR>`) to start
the full run, then wait on that run's head SHA.

## Owner: check, subscribe, reconcile

1. Read current PR state/head and checks (`gh pr view`, `gh pr checks`); record
   pending check names and run URLs. If terminal, continue the existing gates;
   completion includes failures and is not permission to merge.
2. Subscribe only while relevant checks are pending. Check GitHub again immediately
   after subscribing to catch completion between the first read and registration.
3. Before yielding, persist PR URL, full SHA, subscription ID/expiry and a concrete
   fallback deadline chosen for the pending runs. Use `schedules_write` method `create`
   with `action.kind = "message_session"` and your current session ID for one
   bounded reconciliation, independent of the subscription expiry. Confirm creation
   and retain the schedule ID. Scheduling is not proof the recipient executed.
   If unavailable/rejected, report the precise blocker to the coordinator; do not
   leave an unbounded wait. Expiry alone does not wake the session.
4. On any resume, read GitHub again and list your subscriptions with `state: "any"`.
   An expired/cancelled subscription, a changed head, or terminal checks invalidates
   the old wait. Cancel only your obsolete subscriptions/schedules. A changed
   filter needs a new idempotency key; retrying the same create keeps its key.
5. Subscriptions remain active after delivery, until cancelled or expired. If
   required checks are still pending on the same SHA, keep the existing active
   subscription and bounded fallback, then end your turn again. Do not create a
   new subscription or fallback for each workflow wake. Proceed only when required
   checks are complete and their results satisfy the existing gates. Renew only
   an expired subscription for genuinely pending current-head checks. After one fallback with
   no progress, report pending runs, subscription and schedule delivery status,
   and the next explicit recovery action to the coordinator. Do not repeatedly
   recreate the same wait. Cancel your fallback when the wait ends, not when only one workflow finishes.

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
