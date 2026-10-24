# T2: GitHub pull request tracking

## Problem

SAM stores a task's PR URL but not the PR number, lifecycle state, or checks. Linked work needs durable, project scoped PR state.

## Research

- Verified GitHub webhooks enter through `routes/github-webhook.ts`; the project event producer already resolves all projects matching a repository.
- The task callback drops `gitPushResult.prNumber` and `commitSha` while storing the URL.
- `complete_task` and `associate_pull_request` have separate writers.
- D1 schema and migrations live in `apps/api/src/db/`; runtime tunables live in the typed admin settings registry.
- T1 owns shared link types; T2 owns `PullRequestRef` and `PullRequestState` in `types/pull-requests.ts`, re-exported by T1's link types.

## Checklist

- [x] Add additive D1 migration and Drizzle schema for PR rows and task output number/SHA.
- [x] Build project scoped PR upsert/read operation, canonical repository guard, stale ordering, and bounded lazy refresh.
- [x] Ingest verified pull_request and check webhooks for every matching project.
- [x] Persist callback number/SHA and PR rows; integrate complete_task and associate_pull_request.
- [x] Add PR state to chat session detail and T1 Idea/Session link read models in one batched lookup.
- [x] Test real webhook and callback routes, ordering, project isolation, refresh budget, failure behavior, and migration safety.
- [x] Update public docs and complete specialist review.
- [x] Complete staging, PR, CI, CodeRabbit, and specialist gates.
- [x] Merge after coordinator feedback window and watch production deploy.

## Verification evidence

- PR #2428 final rebased head `63b87dd91` passed full CI and all three specialist delta reviews. CodeRabbit's seven findings were addressed; the requested review wait elapsed.
- Staging deploy #40061605472 and smoke passed. Migration 0206 created `pull_requests` and `pull_request_checks` in live D1. Authenticated Playwright navigation passed 3/3 without page errors.
- A real GitHub webhook for unmerged throwaway PR `serverspresentation2025/crewai#5` created an open, project scoped D1 row with the correct number, head SHA and sync time. Closing the PR updated the row to `closed`; the branch was deleted. The repository reported no checks, so aggregate checks remained null. Real check payload fixtures and callback route tests cover those paths locally.
- Temporary workspace and its newly created node were deleted; postflight found zero active nodes and workspaces.
- PR #2428 merged as `e75d6e179` after the coordinator feedback window. Main CI #40065197144 passed. Deploy Production #40066061994 attempt 2 succeeded for that exact SHA, including migration safety, API Worker publication, health check and deployment record.
- The first production attempt was blocked after migration 0206 applied because `vm_provisioning_leases` changed from one row to zero during the postflight count window. The same unmodified gate passed on one failed-job rerun. No D1 restore or safety bypass was used; the migration SQL does not touch leases.

## Acceptance criteria

PR rows stay current through callbacks and GitHub webhooks; wrong-repository callback URLs cannot write project PR state. Read operation returns stored state and bounded single-context refresh. Chat task detail includes PR number, state, and checks. Live PR lifecycle verified on staging; exact merged SHA deployed successfully to production with health check.

## References

Ideas `01M5NG5KPW7PXY272F2SVCB1SN` and `01M5NG3W2ZMDFD797SQF8DWNHR`; `.claude/rules/31-migration-safety.md` and `apps/api/.claude/rules/31-migration-safety.md`.
