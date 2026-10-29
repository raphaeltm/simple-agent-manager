# Reduce D1 overload and verify control-plane recovery

SAM task 01M639S5DPKVA388FKA53QBWY8; parent 01M6364S1M4WHNR1JJZ062B82Y.
Branch: sam/reduce-d1-overload-verify-3qbwy8. SAM already provisioned isolated branch/workspace.

## Evidence and scope

Oct 28 12:40–17:00 Cloudflare d1QueriesAdaptiveGroups independently confirms: archive candidates 27 executions / 14,473,782 rows; PR orphan cleanup 2,529 / 5,944,676 rows / zero writes; active tasks 40 / 343,834 rows / 19.19 seconds. This identifies optimization targets, not a sole initiating cause. Production D1 size ~303 MB; ProjectData 84% warning is separate.
Production EXPLAIN: active tasks full scan + sort; archive refusal uses project/state/time index per candidate and ranking sorts; workspace node/project/status uses project-only index. Runtime identity CTE and metadata require representative plan checks.
Webhook acknowledges before project-event/PR ingestion completes, while swallowing their failures. Existing trigger inbox does not cover all events or these effects. Settings cache already single-flights, expires snapshots, clears failures; retain fail-closed policies and prove recovery.

## Checklist and acceptance

- [x] Reconcile current main, open PRs, coordination channel and production insights/plans.
- [x] Add only proven query/index changes; test actual SQL with realistic cardinality and EXPLAIN; additive migration preserves existing data and clean installs.
- [x] Avoid PR orphan scans when tracked check updates cannot grow unmatched set; preserve per-project cap and tracked check rows.
- [x] Make webhook success wait for canonical event and PR ingestion; failure is visible, redelivery idempotent; trigger acceptance remains durable.
- [x] Prove settings outage/recovery, concurrency coalescing and fail-closed behavior without stale permissive settings or retry loops.
- [x] Inspect existing failed archive/runtime-asset state read-only; recover safely through existing paths if possible; report missing payload/authority honestly.
- [ ] Run meaningful focused regressions, lint/typecheck/test/build and specialist/task completion reviews.
- [ ] Green non-draft PR; best-effort CodeRabbit; merge, successful production deployment and basic smoke.

Staging explicitly waived by user for this task. No production lifecycle/stress tests, fixtures, blanket deletion or relaxed ownership/termination/preservation safeguards.

## Implementation and verification evidence

Five additive indexes address the measured paths. Active task pagination now uses equivalent row-value bounds to permit index seeks across equal timestamps. Runtime attribution retains every project/user/task predicate and fixes SQLite join order with a one-workspace CROSS JOIN; production read-only EXPLAIN verified task ID/chat index searches instead of the prior outer scan. PR orphan cleanup runs only for associated untracked-head observations; tracked-head updates cannot grow the orphan set. Webhook 200 now waits for throwing canonical event admission, applicable PR ingestion and durable trigger intake; only trigger processing remains background work.

Recorded focused results before workspace replacement: query-plan4, lifecycle/PR67, webhook/settings/intake70, workerd8 passing. No settings/auth fallback changes and no added retry loop. Settings tests prove fresh persisted restrictive values after an outage without invalidation and single-flight concurrent failures.

## Existing affected state and limits

Read-only production audit after resume: task `01M61H0MTJF5DBKW726EPTA2E3` failed at15:20 with conclusively terminal runtime; task `01M61J5WM47VXNSYQ7QC33ES69` failed at15:31 fetching runtime assets (HTTP2 response-header timeout). No linked recovery successor or later matching event-archive task was found. Their branches/chats remain retained. Replaying publishing tasks would repeat user side effects; do not blindly reset terminal state. Previously acknowledged lost webhook data needs explicit provider redelivery where payloads remain available. This fix prevents new false acceptance but cannot recreate absent historical payloads.

## Post-mortem

Measured query pressure and synchronous D1 contention coincided with overload; initiating cause is not established. Missing representative query-plan regression coverage allowed table/project-wide scans in global/keyed operations. Separately, background ingestion with swallowed errors allowed successful webhook acknowledgement before persistence. New real-SQL representative-cardinality tests and signed route/workerd redelivery coverage protect these failure classes; existing operational guidance already requires real boundary tests, so no new standing rule is needed.
