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

- [x] Capture target application/rollout identity around deploy; never accept an older completed rollout for a newer pending target.
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
- Deployment engine/workflow/rollout suite:108 tests passed across9 files.
- Ready callback route suite:20 tests passed, including Instant mismatch warning with HTTP200 and normal readiness persistence.
- Agent-context budget measured successfully after updating the staging reference.
- Read-only live Cloudflare snapshot/wait compatibility check passed for staging's existing completed Sandbox1900 and VmAgent1615 rollouts. This is not an exact-head deployment trial.
- Full repository test run remains bounded and in progress; specialist review, explicit staging slot, live verification and PR gates remain open.
- Prior workspace broad concurrent checks timed out; the lower-concurrency retries above passed. No known flaky Node-feature integration retry was used here.
