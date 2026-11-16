# Insights slice F: Flow tab, Insights nav, Overview "This week" pane

SAM task 01M7HVVXN621MQR9XDVT2Z1GPD. Spec: idea 01M7HTS38KX2G78JD0ESAGMKKH. Coordinator
01M7H0X3PMHK6WT29B1BSSCGWW, channel `feature.insights`. Prototype: Library
`/product/analytics/analytics-prototypes.html` (`?s=flow`, `?s=overview`). Deck slides 5, 7, 19, 20.

## Problem

A project has no page that says how work moves from idea to merged. Raphaël decided Insights is a
project nav item with four tabs (Flow, Agent setups, Accounts, People) and the Project Overview
shows a small "This week" pane linking into it. This slice ships the route, the nav item, the Flow
tab and the pane. The other three tabs show "coming soon" until slices S, A and P ship (the one
placeholder the spec allows; tracked by those slices in the spec, rule 42).

## Research findings

- `pull_request_checks` is keyed `(project_id, repository, head_sha, check_key)` and keeps only the
  latest state per check. A rerun overwrites a failure. Rows for a PR's previous head are deleted
  when the head moves (`upsertPullRequestSnapshot`, `packages/operations/src/pull-request-core.ts`)
  or pruned as orphans (`ingestChecksWebhook`, `apps/api/src/services/github-pull-request-events.ts`).
  So first-try CI and flaky checks are not derivable today (slice R finding, seq 6; coordinator
  approved a PR head record, seq 7).
- Only `upsertPullRequestSnapshot` writes `pull_requests.head_sha` (webhook lifecycle + GitHub
  refresh). `ensurePullRequest` writes URL-only placeholders with no head.
- Checks have no file paths, so "the same check failing on PRs that did not touch its path" cannot
  be measured. The direct evidence that a failure was not caused by the change is the same check
  failing and then passing on the same commit. Flaky = that. Announced on the channel.
- `tasks.terminal_reason` is almost never set (only `snapshot_expired`). Production
  (`sam` project, 30 days): stop causes live in `error_message` text (`Stopped by parent: …`,
  `No capacity …`, `Workspace build timed out …`, `Task runtime is no longer live …`,
  `agent_prompt_failed`, `… limit …`), and in `provider_limit_wait_json` /
  `credential_blocked_reason`, session attention markers (`session_summaries.attention_json`) and
  open asks.
- Conversation-mode tasks (archived chats) are not runs: 168 of 249 conversation tasks ended
  `cancelled` normally. Runs = `task_mode = 'task'`, non-idea.
- 330 PRs merged in 30 days, only 182 linked via `tasks.output_pr_url`: "merged" counts read
  `pull_requests`, not tasks.
- Idea ↔ chat ↔ PR links live in the ProjectData link store; `collectEvidence`
  (`idea-list-core.ts`) is the existing batched read (one DO RPC). Reuse it, don't fork it.
- Asks (`asks` table) are new; production has none yet, so "waiting on a person" may say "No asks".
- D1 `batch()` sends several statements in one round trip.
- Project Overview (`apps/web/src/pages/project-overview/`) rail holds Budgets + Automations;
  Inbox F2 and G also edit the page (F2: main column; G: `RUNNING_SQL`). This slice takes the rail
  top only. The pane reads `projectFlow` through its own query (shared query key with Insights 7d),
  so the Overview aggregated read keeps its ~10 round trips untouched.
- Nav: `PROJECT_NAV_ITEMS` (`NavSidebar.tsx`) feeds both desktop sidebar and mobile drawer via
  `AppShell`, so one entry gives parity (rule 15).

## Design

- Migration (additive): `pull_request_heads (project_id, repository, pr_number, head_sha,
  first_seen_at, from_open)` PK `(project_id, repository, pr_number, head_sha)`; column
  `pull_request_checks.first_failed_at`.
- `from_open = 1` only for the head GitHub's `pull_request.opened` event carried (changed after
  review from "no earlier head in SAM", which could mislabel a later commit). PRs whose opened
  event SAM never received say "not recorded". Late check results for the opening commit are kept
  after a push.
- Old-head deletes keep checks of a PR's first recorded head.
- `projectFlow(ctx, {projectId, range})` in `packages/operations/src/insights-flow*.ts`; REST
  `GET /api/projects/:projectId/insights/flow?range=7d|30d|90d`.
- Round trips: authorization 1, one D1 batch of aggregates 1, idea evidence ≤ 7, idea-rework 1:
  ≤ 10 (budget 12).

## Implementation checklist

- [x] Migration + drizzle schema for `pull_request_heads` and `first_failed_at`
- [x] `upsertPullRequestSnapshot` records heads; previous-head delete preserves first-head checks
- [x] `ingestChecksWebhook` records `first_failed_at` (out-of-order safe) and prune preserves first-head checks
- [x] Shared types `ProjectFlowResponse` etc. in `packages/shared`
- [x] `insights-flow` op: tiles (idea→merged median, CI first try, waiting on a person, rework 7d), runs per bucket by outcome, stop reasons, flaky checks, ideas waiting longest, merged count, top blocker; deltas vs previous period
- [x] Stop-reason vocabulary derived at read time; rework definition in code comments
- [x] Admin settings `insights.flow*` for caps
- [x] REST route + mount
- [x] Real-SQL tests: foreign-project attack + owner control, first-try, flaky, rework, stop reasons, not-recorded
- [x] Web: route `/projects/:id/insights` (React.lazy), nav item, tabs, range control, Flow tab (TanStack Query, SWR)
- [x] Web: "This week" pane in Overview rail
- [x] Web unit tests; Playwright audit 375/1280 with realistic + empty data
- [x] Public docs: project guide section for Insights
- [ ] After merge: wire first-try into `runReceipt` if slice R merged (follow-up PR, by design after this merges)

## Acceptance criteria

- [x] Insights nav item on desktop and phone opens `/projects/:id/insights`, Flow tab shows real data
- [x] Other tabs show a short coming-soon state
- [x] Range control switches 7/30/90 days without blanking the page
- [x] Overview rail shows This week (merged, idea→merged, CI first try, top blocker) linking to Insights
- [x] A foreign project's rows never appear (tested on a real SQL engine)
- [x] First try reads "not recorded" when no PR in range was recorded from its first head
- [x] projectFlow ≤ 12 round trips
- [ ] Verified on staging with real tasks and PRs

## Review outcome (Phase 5)

task-completion-validator, cloudflare-specialist, security-auditor, ui-ux-specialist,
performance-reviewer, doc-sync-validator: no CRITICAL. HIGH (no round-trip test) fixed with a
measured test (8 trips with 120 linked tasks). MEDIUMs fixed: exact from_open, late opening-commit
checks, json_each idea reads (no 96-id chunking), vertical slice ingest → projectFlow,
cross-project placeholder data, amber misuse, API reference entry. Accepted with reasons: This week
runs the full read (5-minute shared cache, within budget); pull_request_heads has one small row per
push with no retention, like pull_requests itself; tabs drop ?range= (other tabs are placeholders).
