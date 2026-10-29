# Reduce D1 overload and verify control-plane recovery

SAM task 01M639S5DPKVA388FKA53QBWY8; parent 01M6364S1M4WHNR1JJZ062B82Y.
Branch: sam/reduce-d1-overload-verify-3qbwy8. SAM already provisioned isolated branch/workspace.

## Evidence and scope

Oct 28 12:40–17:00 Cloudflare d1QueriesAdaptiveGroups independently confirms: archive candidates 27 executions / 14,473,782 rows; PR orphan cleanup 2,529 / 5,944,676 rows / zero writes; active tasks 40 / 343,834 rows / 19.19 seconds. This identifies optimization targets, not a sole initiating cause. Production D1 size ~303 MB; ProjectData 84% warning is separate.
Production EXPLAIN: active tasks full scan + sort; archive refusal uses project/state/time index per candidate and ranking sorts; workspace node/project/status uses project-only index. Runtime identity CTE and metadata require representative plan checks.
Webhook acknowledges before project-event/PR ingestion completes, while swallowing their failures. Existing trigger inbox does not cover all events or these effects. Settings cache already single-flights, expires snapshots, clears failures; retain fail-closed policies and prove recovery.

## Checklist and acceptance

- [x] Reconcile current main, open PRs, coordination channel and production insights/plans.
- [ ] Add only proven query/index changes; test actual SQL with realistic cardinality and EXPLAIN; additive migration preserves existing data and clean installs.
- [ ] Avoid PR orphan scans when tracked check updates cannot grow unmatched set; preserve per-project cap and tracked check rows.
- [ ] Make webhook success wait for canonical event and PR ingestion; failure is visible, redelivery idempotent; trigger acceptance remains durable.
- [ ] Prove settings outage/recovery, concurrency coalescing and fail-closed behavior without stale permissive settings or retry loops.
- [ ] Inspect existing failed archive/runtime-asset state read-only; recover safely through existing paths if possible; report missing payload/authority honestly.
- [ ] Run meaningful focused regressions, lint/typecheck/test/build and specialist/task completion reviews.
- [ ] Green non-draft PR; best-effort CodeRabbit; merge, successful production deployment and basic smoke.

Staging explicitly waived by user for this task. No production lifecycle/stress tests, fixtures, blanket deletion or relaxed ownership/termination/preservation safeguards.
