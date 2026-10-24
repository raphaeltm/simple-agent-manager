# T2: GitHub pull request tracking

## Problem

SAM stores a task's PR URL but not the PR number, lifecycle state, or checks. Linked work needs durable, project scoped PR state.

## Research

- Verified GitHub webhooks enter through `routes/github-webhook.ts`; the project event producer already resolves all projects matching a repository.
- The task callback drops `gitPushResult.prNumber` and `commitSha` while storing the URL.
- `complete_task` and `associate_pull_request` have separate writers.
- D1 schema and migrations live in `apps/api/src/db/`; runtime tunables live in the typed admin settings registry.
- T1 owns shared link types, including `PullRequestRef` and `PullRequestState`.

## Checklist

- [x] Add additive D1 migration and Drizzle schema for PR rows and task output number/SHA.
- [x] Build project scoped PR upsert/read operation, canonical repository guard, stale ordering, and bounded lazy refresh.
- [x] Ingest verified pull_request and check webhooks for every matching project.
- [x] Persist callback number/SHA and PR rows; integrate complete_task and associate_pull_request.
- [x] Add PR state to chat session detail; T1 link reads depend on merge order.
- [x] Test real webhook and callback routes, ordering, project isolation, refresh budget, failure behavior, and migration safety.
- [x] Update public docs and complete specialist review.
- [ ] Complete staging, PR, CI, CodeRabbit, and production gates.

## Acceptance criteria

PR rows stay current through callbacks and GitHub webhooks; wrong-repository callback URLs cannot write project PR state. Read operation returns stored state and bounded single-context refresh. Chat task detail includes PR number, state, and checks. Verified on staging and production.

## References

Ideas `01M5NG5KPW7PXY272F2SVCB1SN` and `01M5NG3W2ZMDFD797SQF8DWNHR`; `.claude/rules/31-migration-safety.md` and `apps/api/.claude/rules/31-migration-safety.md`.
