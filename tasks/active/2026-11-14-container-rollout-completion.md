# Wait for exact container rollout completion

Owner: task 01M714W8FWH3CT5H1TDKJK749M. Idea: 01M7BQJ14BKVMPMKRA2GCSP8MJ.
Separate follow-up to merged #2605. Draft PR with needs-human-review; coordinator must approve PR number and exact head before readiness or merge. No direct main commits.

## Problem and research

Cloudflare activates the Worker and starts a gradual container rollout before wrangler deploy returns. #2605's first Instant trial entered during that window and ran the previous binary. Its guarded retry succeeded after checking the exact rollout completed. Deployment workflows must wait before reporting success. Instant sessions must remain available during rollout; only log version mismatch.

- Shared deploy path: .github/workflows/deploy-reusable.yml, used by staging and production.
- Container definitions: generated wrangler config; app names derive from worker name, class and environment.
- API: /containers/applications and per-application /rollouts; target_version is pending until final step completes. Application GET can still show the old image/version during rollout.
- Readiness: apps/api/src/services/node-agent-readiness.ts accepts response.ok. Expected version is env.VM_AGENT_REQUIRED_VERSION; authenticated /ready callback reports compiled agentVersion; /health only reports liveness.
- Official reference: https://developers.cloudflare.com/containers/configuration/rollouts/
- Prior evidence: library01M7BQXDBP92M5HAS9JJ6B28XW; final guarded proof01M7BVQ3A3TPDNBTX8FQ87ARXX.

## Checklist and acceptance

- [x] Compare all rollout IDs/target versions before and after deploy on both engine paths, pin the unique new rollout; never accept an older completed rollout for a newer pending target.
- [x] Shared staging/production deploy waits for target rollout100%, with DEFAULT_* and env overrides for bounded timeout/poll.
- [x] API errors, unreadable status, failed rollout, superseded target and timeout fail deployment with safe app/rollout/status diagnostics.
- [x] First deployment and unchanged-container deployment succeed without inventing a rollout.
- [x] Log structured expected/reported agentVersion and nodeId on readiness mismatch without blocking sessions.
- [x] Tests cover complete, pending→complete, timeout, errors, malformed state, identity changes, no-op and mismatch nonblocking behavior.
- [x] Update staging verification and deployment configuration docs.
- [ ] Lint/typecheck/tests/build, specialist reviews and completion validator.
- [ ] Explicit staging slot; exact-head deploy success includes rollout completion, one bounded Claude Instant node reports expected version, cleanup and late audit.
- [ ] Draft PR, CI, best-effort CodeRabbit wait, exact-SHA coordinator approval before merge.
- [ ] After approved merge monitor production rollout-wait completion.

## Validation progress — 2026-11-14

- Full build:18/18 tasks passed; full lint:22/22; full typecheck:36/36.
- Deployment-script TypeScript check passed.
- Deployment engine/workflow/rollout suite:113 tests passed across9 files after review corrections.
- Ready callback route suite:20 tests passed, including Instant mismatch warning with HTTP200 and normal readiness persistence.
- Agent-context budget measured successfully after updating the staging reference.
- Read-only live Cloudflare snapshot/wait compatibility check passed for staging's existing completed Sandbox1900 and VmAgent1615 rollouts. This is not an exact-head deployment trial.
- Full repository test run timed out at540s (13 package suites passed). Six remaining non-web/API package suites subsequently passed. Full API run also timed out at540s without a summary; finishing API in bounded shards and web separately; specialist review, explicit staging slot, live verification and PR gates remain open.
- Prior workspace broad concurrent checks timed out; the lower-concurrency retries above passed. No known flaky Node-feature integration retry was used here.

## Review corrections — 2026-11-14

- Initial local specialist reviews requested changes: first-poll supersession could be accepted; shared engine had no Wrangler stdout evidence; metadata-only changes were wrongly required to create a rollout. Completion review also found the readiness mock ignored selected columns.
- Coordinator explicitly rejected patching Wrangler. Revised implementation uses only Containers API records: baseline all rollout IDs/targets, require at most one new rollout, pin it, reject later supersession. No stdout coupling on either deploy path. Pre-existing pending rollout still waits on no-op; metadata-only version advancement without a new rollout is allowed.
- Application version equality cannot classify no-op: original live evidence had active1612 with pending target1613 until01:38:07Z. Exact proof library01M7BVQ3A3TPDNBTX8FQ87ARXX. Both deployment entry workflows serialize using deploy-staging/deploy-production concurrency groups with cancel-in-progress:false.
- New HTTP-boundary regression snapshots an old rollout, presents new pending target while application version remains old, then completes. Unit regressions cover multiple first-poll targets and metadata-only updates. Readiness mock now projects selected schema columns.

## Specialist review evidence

| Reviewer | Status | Outcome |
| --- | --- | --- |
| rollout_review | PASS | Cloudflare identity, environment, security, constitution; prior first-poll ambiguity, shared-engine and metadata-only findings fixed; API-only visibility assumption noted without a concrete consistency failure. |
| completion_review | PASS | Task implementation, test engineering and docs; HTTP-boundary regression and readiness projection mock resolve prior findings. Operational staging/PR/release gates remain open. |

## Additional validation and runtime evidence

- Full API run and API shard1/4 each reached the540s command ceiling without a completion summary. Full web run also reached540s; its observed Comments-page failure reproduced in one isolated rerun (17/18 passed). This is already tracked in idea01M7C1Z68PR1AST8TW6PXJQSZZ on an unchanged main-based branch; this branch has no apps/web or packages diff. Added evidence there; no UI changes here.
- API shard2/4 reported one deployment-error-recovery assertion under concurrent load; the one isolated rerun passed all34 tests. Shard2 also reached540s without a completion summary. No local test commands remain in flight; full-suite completion is not established. No claim of full-suite green.
- Another staging owner reported completed rollout1616 before its sole Instant fixture, callback-persisted version6d797 initially, then expectedba3ba01 after recovery before termination. Sanitized evidence library01M7C6AWCAGTM75XQY2Y1E2JH0. Initial runtime image/incarnation was not captured, so the precise cause remains unproven. Application/rollout metadata is not independent running-binary evidence; our staging verification retains the actual agent-reported version check. No mutation or extra fixture was performed during this read-only coordination.

## Coordinator disposition — 2026-11-14 04:56Z

Event822f36fe-69c0-45ff-bb1c-f5137d1badd6 accepts local540s workspace ceilings with CI as the authoritative full-suite gate, and accepts the tracked Comments failure as unrelated. Directed opening a DRAFT PR now with needs-human-review before staging, then take the queued staging slot only after CI is green apart from the intentional hold and the Shepherd explicitly grants it. No unrelated UI patch. List timeout/retry evidence in PR; report if CI fails on the same Comments case.

Scope: this gate closes deploy-success-mid-rollout, not every running binary discrepancy. Keep authenticated readiness mismatch logging nonblocking. Idea01M7BQJ14BKVMPMKRA2GCSP8MJ remains OPEN for the unexplained completed-rollout1616 callback transition; do not mark that root cause solved. Exact PR-number/full-SHA coordinator approval is still required before readiness/merge.
