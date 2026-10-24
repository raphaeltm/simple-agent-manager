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
- [ ] Merge after coordinator feedback window and watch production deploy.

## Verification evidence

- PR #2428 final rebased head `63b87dd91` passed full CI and all three specialist delta reviews. CodeRabbit's seven findings were addressed; the requested review wait elapsed.
- Staging deploy #40061605472 and smoke passed. Migration 0206 created `pull_requests` and `pull_request_checks` in live D1. Authenticated Playwright navigation passed 3/3 without page errors.
- A real GitHub webhook for unmerged throwaway PR `serverspresentation2025/crewai#5` created an open, project scoped D1 row with the correct number, head SHA and sync time. Closing the PR updated the row to `closed`; the branch was deleted. The repository reported no checks, so aggregate checks remained null. Real check payload fixtures and callback route tests cover those paths locally.
- Temporary workspace and its newly created node were deleted; postflight found zero active nodes and workspaces.

## Acceptance criteria

PR rows stay current through callbacks and GitHub webhooks; wrong-repository callback URLs cannot write project PR state. Read operation returns stored state and bounded single-context refresh. Chat task detail includes PR number, state, and checks. Verified on staging and production.

## References

Ideas `01M5NG5KPW7PXY272F2SVCB1SN` and `01M5NG3W2ZMDFD797SQF8DWNHR`; `.claude/rules/31-migration-safety.md` and `apps/api/.claude/rules/31-migration-safety.md`.
