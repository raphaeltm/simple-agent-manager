# Durable event-wait workflow steps

## Problem
Agent-created workflows need to wait for matching project events while the parent sleeps, then continue a DAG or fail on a finite timeout.

## Research
Foundation state is in D1 mission_steps, reconciled by ProjectOrchestrator. ProjectData already owns event admission, filtered subscriptions and match deduplication. The UI/read owner has published the wait projection contract on feature.workflows and owns PR #2405.

## Checklist
- [x] Extend validated workflow plans with event wait definitions and finite timeouts.
- [x] Persist subscription correlation, registration/listening/timeout and matched identity.
- [x] Reconcile waits through ProjectData record-only subscriptions and existing orchestrator.
- [x] Cover match, nonmatch, duplicate/replay, registration, timeout race, downstream progression and authorization in Workers tests.
- [x] Integrate UI read contract after PR #2405 lands, without editing UI.
- [x] Update documentation and tool schema.
- [x] Run Cloudflare, security, test, constitution and documentation specialist reviews.
- [x] Verify nonmatch, timeout, match, stable replay identity, downstream progression and zero fixture VMs in staging.
- [x] Pass final CI and CodeRabbit gates, merge and run basic production smoke. (reconciled 2026-10-26: #2406 final-head CI 39715890412 and E2E 39715890422 success on `8b29d5e3f`; CodeRabbit CHANGES_REQUESTED fixed in `397e859c8`, both threads resolved; merged as `e063961fb`; main CI 39717873907 on the merge failed on a flaky web test fixed by #2407; production runs 39725139516 and 39727603722 success; SAM task `01M5GDAPF26FWN45V4JBBPC6FK` records `/health` 200 healthy and app 200 at 2026-10-22 05:39 UTC)

## Acceptance
Waits require no task or VM; first canonical match before timeout wins; duplicates are safe; restarts replay registration; timeout blocks dependents; owner/project auth and event visibility hold; no payload instructions enter prompts; staged scenarios pass; release reaches production.

## References
`docs/guides/durable-workflows.md`; `apps/api/src/services/workflow-{plan,runs,reconcile,waits}.ts`; `apps/api/src/durable-objects/project-data/project-events*`.

## Reconciliation 2026-10-26

- Shipped by #2406 (merge commit `e063961fb`, merged 2026-10-22); first successful production
  deploy: run 39725139516 (head `1b99904ce`, 2026-10-22). Main CI on `e063961fb` itself failed on
  a flaky web test, fixed by #2407, so the first deploy came from that later commit.
- Unticked: 0 — none.
- Verdict: ARCHIVE. Event waits are on `main`, deployed and smoke-checked; nothing material left.
