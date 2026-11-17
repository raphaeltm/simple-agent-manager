# Insights slice P: People tab

Task 01M7KNQ0DC1TGYTM00GA32ZZ0V. Spec idea 01M7HTS38KX2G78JD0ESAGMKKH (slice P). Branch
`sam/build-insights-slice-p-32zz0v`. Channel `feature.insights`.

## Problem

The project Insights page has a People tab that still shows F's "coming soon" placeholder. Slice P
shows where work waits on people, never how much each person produced (spec rule: **flow, not
people, no per-person output counts**):

1. **Waiting on:** open asks (questions, reviews) and human tasks grouped by assignee, oldest first,
   with ages, including unassigned team items. Reassign from the list through the Inbox H1 path.
2. **Review pickup time:** median and p90 from "review requested" to the first review, per project.
   Review-requested events are not stored today: add a small additive record written by the GitHub
   webhook ingest. History before it reads "not recorded", never estimated.
3. **Asks answered by the first person asked:** the share of closed asks answered by the original
   assignee with no reassignment.

## Research findings

- Insights pattern: `packages/operations/src/insights-accounts.ts` (authorize, settings, one
  `runInsightsBatch`, per-row `parseInsightsRows`, `unavailable` sections). REST adapters in
  `apps/api/src/routes/project-insights.ts`. Web tabs in `apps/web/src/pages/insights/`, routes in
  `apps/web/src/App.tsx` (`people` → `InsightsComingSoonTab`), query options in
  `apps/web/src/lib/query-options/insights.ts`, client in `apps/web/src/lib/api/insights.ts`.
  Settings registry: `packages/operations/src/insights-page-settings.ts`.
- `ComingSoonTab.tsx` serves both agent-setups (slice S, PR #2826 open) and people. Whichever slice
  merges last deletes the file; the other narrows it.
- Asks (`0245_asks.sql`, `0247`, `0254`): `assignee_kind` user|team, `assignee_user_id`,
  `claimed_by_user_id`, kinds question|review|task|error, statuses open|answered|done|archived|
  expired|cancelled, `resolved_by_user_id`, `resolved_at`, `expires_at`. `idx_asks_project_status`.
- Read visibility (`inbox-item-core.ts readStoreRow`): a user ask is readable by its assignee, a
  team ask by every member, a task also by its filer (`TASK_FILER_SQL`). People must not show the
  title of an item the viewer could not open in the Inbox: other people's items show kind + age only.
- Reassign exists only for human tasks: `reassignTask` (`inbox-task-core.ts`), REST
  `POST /api/projects/:projectId/inbox/items/:ref/reassign` (`routes/inbox-tasks.ts`), body
  `{assigneeUserId}` or `{team:true}`, authorization `task:write` + `TASK_WRITABLE_SQL`. Questions
  have no reassign path; the tab does not invent one (rule 24). No web client calls the route yet.
- Writers of `asks.assignee_*` (rule 44): `reassignTask` (writes `ask_activity` kind `reassigned`,
  detail `fromKind/fromUserId/toKind/toUserId`) and `departed-member-tasks.ts` (same activity row,
  same transaction). Creation (`inbox-ask-create-core.ts`) sets the original assignee. So "original
  assignee kind" = first `reassigned` row's `fromKind`, else the current kind; "answered by first
  person" = no `reassigned` row and `resolved_by_user_id = assignee_user_id`.
- Only the assignee can answer a user ask (`inbox-write-core.ts` CAS), errors are system items
  (`inbox-error-core.ts`) and are excluded from both people reads.
- GitHub webhook: `routes/github-webhook.ts` → `services/github-pull-request-events.ts`
  (`ingestPullRequestWebhook`, events pull_request/check_run/check_suite). The App already subscribes
  to `pull_request` (action `review_requested`, `review_request_removed`) and `pull_request_review`
  (`scripts/deploy/utils/github.ts` default_events), so no App permission change.
- `pull_request_heads` is per head commit and `pull_requests` one row per PR; neither carries
  per-reviewer request cycles, so a new small table is needed (spec allows "review-requested
  events (slice P)").
- Members for the picker: `apps/web/src/hooks/useProjectMembers.ts` (existing, reuse).

## Design

- Table `pull_request_review_requests` (migration 0257 or next free): one row per request cycle
  (project, repository, pr, reviewer kind user|team, reviewer key, requested_at), `first_review_at`,
  `removed_at`. FK projects ON DELETE CASCADE (child only, not a parent). Index
  `(project_id, requested_at)`.
  - `pull_request.review_requested`: insert a cycle unless an open one (no review, not removed)
    exists for that reviewer; requested_at = PR `updated_at` (GitHub's time, not delivery time).
  - `pull_request.review_request_removed`: stamp `removed_at` on the open cycle.
  - `pull_request_review.submitted` by login L (not the PR author): stamp `first_review_at` on the
    open user cycle for L, and on open team cycles of that PR, where requested_at <= submitted_at.
  - Idempotent on redelivery; project scope in every statement.
- `projectPeople(ctx, {projectId, range})` in `packages/operations/src/insights-people*.ts`: auth 1,
  settings 0-1, one batch of 4 statements 1 → at most 3 round trips (budget 4).
- REST `GET /api/projects/:projectId/insights/people?range=7d|30d|90d`, `private, no-store`.
- Waiting-on is "now" (not range-bound); pickup and first-person use the range.

## Implementation checklist

- [x] Migration + drizzle schema for `pull_request_review_requests`
- [x] Webhook ingest: review_requested, review_request_removed, pull_request_review.submitted
- [x] Shared types `packages/shared/src/types/insights-people.ts` + exports
- [x] Settings `insights.peopleWaitingItemsListed`, `insights.peopleReviewScanCap`
- [x] `projectPeople` op + SQL module, rows validated per row (rule 50)
- [x] REST route + tests (range 400, foreign/missing project 404, no-store)
- [x] Real-SQL op tests: foreign-project attack + owner control per statement; privacy (no title of
      unreadable items); first-person with reassigned/departed rows; pickup median/p90 and
      not-recorded; malformed rows skipped; round-trip count
- [x] Webhook ingest tests through `ingestPullRequestWebhook` with production-shaped payloads
- [x] Web: `reassignInboxTask` client (existing route), query options, `PeopleTab`, route swap,
      remove the People placeholder (narrow or delete `ComingSoonTab`)
- [x] Web tests (render, reassign calls the route and invalidates)
- [x] Playwright audit 375/1280: realistic, empty, stress
- [x] Docs: Insights section of the project guide
- [x] Post migration number + interface on feature.insights; files on feature.inbox

## Acceptance criteria

- [x] People tab shows Waiting on grouped by assignee (oldest first, ages, unassigned group)
- [x] Reassign of a human task from the tab works through the Inbox route and refreshes the list
- [x] Review pickup median/p90 per project from webhook-recorded events; before recording: "not
      recorded"
- [x] First-person share is correct for never-reassigned, reassigned and team-origin asks
- [x] No per-person output counts anywhere; other people's private items show no titles
- [x] ≤ 4 round trips; project predicate in every statement, attack tests on real SQL
- [ ] Staging: real asks/tasks, reassign end to end, real PR review request via webhook (or stated
      plainly if the staging App cannot)

## Implementation notes

- Migration 0257: `pull_request_review_requests` plus `idx_asks_project_status_resolved` (review: D1
  plan for the first-person read).
- Private waiting items carry only their age (security review); departed assignees read as
  "A former member"; review cycles close on `pull_request.closed`.
- staging2 has no GitHub App, so the webhook-delivered review request cannot be exercised there;
  the real ingest is covered by unit tests with production-shaped payloads, and production D1 is
  checked after deploy.
