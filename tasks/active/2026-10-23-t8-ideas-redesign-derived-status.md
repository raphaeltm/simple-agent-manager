# T8 · Ideas redesign: derived status, the Ideas list and the idea page

- Idea: `01M5NG712YTCNSBDWWQVR4F0A1` (program overview `01M5NG3W2ZMDFD797SQF8DWNHR`)
- Branch: `sam/t8-ideas-redesign-derived-zg8jea`
- Channel: `feature.linked-work`
- Design: library `/engineering/ux-audits/ideas-redesign-2026-10-23/` (story `01M5NA13SVX7YDBBPMNXM3D7YJ`,
  text `01M5NA160HAKFP0T4H4GPHQDZM`, screenshots in `screens/`); prototype code on
  `origin/sam/started-talking-how-reimagine-861qke` at `apps/web/src/pages/ideas-prototype/`
  (visual reference only, never merged).
- Ships as two PRs: **PR1** derived status + the Ideas list; **PR2** the idea page.

## Problem

Ideas never move. An idea is a `tasks` row with `status='draft'`; Execute creates a _separate_ task and
leaves the idea behind, so the status stays "Exploring" forever and people type status into titles. The
list is a flat search list with agent-filed error reports mixed in, and the idea page is the raw text plus
a conversations drawer. Nothing shows what needs a human.

## Research findings

### What exists on main (`f6b24ffbb`)

| Thing                     | Where                                                                                 | Notes                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ideas list                | `apps/web/src/pages/IdeasPage.tsx` (269 lines)                                        | `draftIdeasQueryOptions` pages `GET tasks?status=draft`; counts sessions client-side from a 200-session fetch                                                                                                                                                           |
| Idea page                 | `apps/web/src/pages/IdeaDetailPage.tsx` (515 lines)                                   | Status pill mapped from `TaskStatus`, `Execute` → `/chat?executeIdea=`, conversations side panel + mobile FAB/modal                                                                                                                                                     |
| Idea reads/writes         | `apps/api/src/operations/idea-core.ts`                                                | `searchIdeas` (defaults `status='draft'`), `getIdea`, `prepareIdeaCreate`, `prepareIdeaUpdate`                                                                                                                                                                          |
| Idea transitions          | `idea-core.ts:268-270` `IDEA_STATUS_TRANSITIONS`                                      | `draft→ready                                                                                                                                                                                                                                                            | cancelled`, `ready→draft                                                  | completed | cancelled` |
| Task transitions          | `services/task-status.ts:67-77` `TRANSITIONS`                                         | `draft→ready                                                                                                                                                                                                                                                            | cancelled`— **forbids`ready→completed`**, and `completed` has no way back |
| Generic task PATCH/status | `routes/tasks/crud.ts:437-468`                                                        | uses `canTransitionTaskStatus`, so an idea row routed through it disagrees with `update_idea`                                                                                                                                                                           |
| Session↔idea links        | DO `project-data/ideas.ts` (`chat_session_ideas`)                                     | `getSessionsForIdea(taskId)` is **per idea**; no batched read exists                                                                                                                                                                                                    |
| Needs-input markers       | DO `project-data/attention.ts`, table `session_attention_markers` (migration `020-…`) | `kind`, `resolved_at IS NULL`, `created_at`                                                                                                                                                                                                                             |
| Automation primitives     | `apps/web/src/pages/automation/ui.tsx`, `page.tsx`, `overview-sections.tsx`           | `Panel`, `SectionTitle`, `RowLink`, `Disclosure`, `TextLink`, `ButtonLink`, `Chips`, `PageHeader`, `Page`, `LoadError`, `Notice`, and the `NeedsAttention`/`AttentionPanel` pattern the design copies                                                                   |
| Markdown renderer         | `apps/web/src/components/MarkdownRenderer.tsx:255-265`                                | `ul`/`ol` set `paddingLeft: 22` but **no `list-style-type`**, and Tailwind preflight sets `list-style: none` → no bullets/numbers anywhere (idea `01M0JQBW9E0T5PJZXY0K72V9BX`). `packages/acp-client/src/components/MessageBubble.tsx` overrides no list element at all |
| Operation limits          | `apps/api/src/operations/limits.ts`                                                   | `getPlatformOperationLimits(env)`; `ideaListLimit/Max` already exist                                                                                                                                                                                                    |

### Finding 1 — an idea has no durable discriminator (blocking)

"Mark done" must move the row to `completed` and "Park" to `cancelled` (the design: "Done and Parked stay
human choices (the existing completed and cancelled statuses)"). But _every_ reader identifies an idea as
`status='draft'`. The moment an idea is marked done it is indistinguishable from an ordinary completed
task and vanishes from Ideas, so "Done recently" and the Done idea page cannot exist.

→ D1 migration `0207_tasks_idea_flag.sql`: `ALTER TABLE tasks ADD COLUMN is_idea INTEGER NOT NULL DEFAULT 0`,
backfill `UPDATE tasks SET is_idea = 1 WHERE status = 'draft'` (exactly today's definition, so lossless),
plus an index. Additive only — no `DROP`, no unscoped `UPDATE` (rule 31). **Announced on the channel for
coordinator ack before landing** (program rule: no unannounced migrations).

### Finding 2 — the list cannot use T1's per-idea `getIdeaContext`

T1 exposes `GET …/ideas/:ideaId/links → IdeaContext`, one idea at a time. A list of 100 ideas through that
is 100+ round trips against a ≤20 budget (rule 60). → one batched DO read of my own,
`getIdeaWorkSnapshots(taskIds[])` in a new sibling module, whose link source is repointed at T1's
`resource_links` table at integration while keeping T1's strength rules.

### Finding 3 — PR state must not be refreshed from the list

Cloudflare review of the program: list endpoints read **stored** PR state only. T2's
`getPullRequestStates(ctx, projectId, refs, { refresh })` defaults to stored D1 reads; only the detail route
passes `refresh: 'single'` (channel seq 10, 11). `canonicalProjectPullRequestUrl` comes from
`@simple-agent-manager/shared` (T2, channel seq 9).

### Finding 4 — "filed by agents" already has a signal

`tasks.triggered_by` is `'user' | 'connector' | <automation>`; `IdeasPage` already renders an `AUTO` chip
for `triggeredBy` not in `{user, connector}`. The design's "Filed by agents" group is exactly that set, so
no new column is needed for it.

### Finding 5 — scrolling wrapper

Policy `63006482`: the app deliberately does not scroll at `html`/`body`. Playwright overflow checks must
measure the page's own scroll container, and the list/idea pages must live inside the existing project
layout scroll container rather than introducing their own.

### Rules / post-mortems read

`00-rule-routing`, `02-quality-gates`, `06-technical-patterns` (interaction-effect analysis, UI→backend
data path), `11-fail-fast-patterns` (project-scoped read/write guards), `18-file-size-limits`,
`24-no-duplicate-ui-controls`, `25-review-merge-gate`, `30-never-ship-broken-features`,
`31-migration-safety` (apps/api scoped), `35-vertical-slice-testing`, `48-stale-while-revalidate-ui`,
`56-clipped-overflow`, `60-request-io-and-bundle-budgets`, `62-tests-must-observe-the-real-trigger`,
`64-unstable-prop-identity`, `74-proxy-signals-must-match-the-condition` (derived status is a _derivation_,
not a proxy: every rule reads the condition itself and carries its source), `76-cost-decisions`,
`17-ui-visual-testing` (apps/web scoped), `04-ui-standards` (apps/web scoped).

## Implementation checklist

### PR1 — derived status, the transition operation, the API and the Ideas list

- [x] `packages/shared/src/types/ideas.ts`: `IdeaDerivedState`, `IdeaAttentionKind`, `IdeaAttention`,
      `IdeaStatusSource`, `IdeaDerivedStatus`, `IdeaListItem`, `IdeaListResponse`, `IdeaCounts`;
      `IDEA_NEEDS_YOU_STATES`; exported from `types/index.ts`.
- [x] `apps/api/src/db/migrations/0207_tasks_idea_flag.sql` (+ `schema.ts` `isIdea` column) — **after
      channel ack**.
- [x] `prepareIdeaCreate` writes `is_idea = 1`; every idea reader filters on it (with the
      `status='draft'` legacy fallback removed only where the backfill covers it).
- [x] `apps/api/src/operations/idea-status.ts` — **pure** `deriveIdeaStatus(input)` implementing the
      precedence: done → parked → question → stuck → working → review → merged → not-started, each with
      its `source`.
- [x] `apps/api/src/operations/idea-transitions.ts` — one allowed-transition table for idea rows
      (`markIdeaDone`, `parkIdea`, `reopenIdea`), used by `update_idea`, the new status route and the
      generic task PATCH/status route when the row is an idea. Delete `IDEA_STATUS_TRANSITIONS` from
      `idea-core.ts`.
- [x] DO: `durable-objects/project-data/idea-work.ts` + a one-line delegating method
      `getIdeaWorkSnapshots(taskIds)` on the class.
- [x] `apps/api/src/operations/idea-list-core.ts` — batched aggregation (ideas → snapshots → tasks → PR
      state), ≤20 round trips, no per-idea queries.
- [x] `apps/api/src/routes/ideas.ts` mounted at `/api/projects/:projectId/ideas`: `GET /`,
      `GET /:ideaId`, `POST /:ideaId/status`. Project scoping on every read and write.
- [x] Fix markdown list markers: `MARKDOWN_COMPONENTS` `ul`/`ol` get `list-style-type`, and
      `MessageBubble`'s agent/user components get the same lists. Mark idea
      `01M0JQBW9E0T5PJZXY0K72V9BX` done.
- [x] `apps/web/src/pages/ideas/`: `IdeasListPage.tsx` + `parts.tsx` (`StateIcon`, `IdeaRow`,
      `AttentionCard`), `view-model.ts` (grouping, Needs-you cap, labels), `api`/`query-options`.
      Needs you (≤3 + "N more need you") → In progress → Not started; Done recently and Filed by agents
      folded; desktop side column.
- [x] Route `IdeasPage` → the new page; delete the old one (no dead code).
- [x] Tests: table-driven `deriveIdeaStatus` (every rule, weak links must not move status),
      transition operation against real SQL (allowed + rejected + PATCH/`update_idea` agreement),
      list route vertical slice with multi-session fixtures, foreign-project attack + owner control,
      list view-model + behavioural tests for each Needs-you action, markdown `ul`/`ol` rendered test.
- [x] Playwright 375×667 + 1280×800 with stress/empty data, `assertNoOverflow`, screenshots reviewed.
- [x] `pnpm quality:cloudflare-cost` before/after, noted in the PR.
- [x] Docs: `apps/www/src/content/docs/docs/` page for how idea status is derived.

### PR2 — the idea page

- [ ] `GET /api/projects/:projectId/ideas/:ideaId` returns idea + derived status + Work + Related
      (T1 `IdeaContext`, T2 PR state with `refresh: 'single'`).
- [ ] `apps/web/src/pages/ideas/IdeaPage.tsx` (+ parts): status card with the one status-dependent
      primary action, "The idea" (markdown, the current plan), Work, Updates (T3 notes + composer +
      quote + derived lifecycle entries), Related. Desktop two columns; the conversations drawer and
      mobile FAB go away.
- [ ] Keep Start work (T7) wired; whichever of T7/T8 merges second does the wiring.
- [ ] Tests: status-dependent primary action per state, Updates composer through the real POST,
      Mark done / Park through the real route, Playwright both viewports, ui-ux-specialist review.

## Every idea writer, and what it sets (coordinator condition, channel seq 133a)

An idea is `tasks.is_idea = 1`. Every path that creates one sets the flag; every path that
creates an ordinary task leaves it 0. Verified by reading each INSERT, 2026-10-24:

| Writer                                                                       | Sets `is_idea`                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `operations/idea-core.ts:231` (`createIdea`, the REST and MCP path)          | `1`, literal in the INSERT                                                                                                            |
| `durable-objects/sam-session/tools/create-idea.ts:97` (`/sam` `create_idea`) | `1`, literal in the INSERT                                                                                                            |
| `services/platform-feedback-incidents/user-report.ts:195` (Report an issue)  | `1`, literal in the INSERT                                                                                                            |
| `services/platform-feedback-triage/runner.ts:309` (hourly triage)            | `1`, literal in the INSERT                                                                                                            |
| `services/debug-agent.ts:748` (`saveDebugDiagnosisAsIdea`)                   | `isIdea: true` on the drizzle insert                                                                                                  |
| `services/report-issue.ts`                                                   | **Writes no task.** It delegates to `upsertUserReportIncident`, the row above; the only `tasks` INSERT for a user report is that one. |
| `routes/tasks/crud.ts:128` (`POST /api/projects/:projectId/tasks`)           | **`0`, deliberately.** An ordinary task also starts in `draft`, which is why the predicate is the flag; commented at the call site.   |

Every other `tasks` INSERT in `apps/api/src` creates work that is already dispatched and
leaves the column at its default. The full list, from `INSERT INTO tasks` and
`insert(schema.tasks)` across the tree: `routes/chat-start.ts`, `routes/chat.ts`,
`services/submit-task-implementation.ts`, `services/submit-instant-task.ts`,
`services/session-task-repair.ts`, `services/reserved-task-submission-storage.ts`,
`services/trial/trial-runner.ts`, `routes/mcp/dispatch-tool.ts`,
`routes/mcp/orchestration-tools.ts`, `routes/workspaces/workspace-create.ts`,
`durable-objects/sam-session/tools/dispatch-task.ts` and
`durable-objects/sam-session/tools/retry-subtask.ts`. The last two insert at
`status = 'queued'`, so they were never idea-like under either definition.

### Readers that had written their own predicate

The narrowing broke three queries that identified an idea as `status = 'draft'` without
asking the shared helper — correct before the flag, wrong after it, because an undispatched
ordinary task is also a draft. All three now call `ideaTaskPredicateSql`:

| Reader                                                                           | What it was doing                                                                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `durable-objects/sam-session/tools/find-related-ideas.ts`                        | Served ordinary draft tasks to the agent as "related ideas", and hid every idea that had left `draft`            |
| `durable-objects/sam-session/tools/create-idea.ts` (the per-project quota count) | Let unrelated draft tasks spend a project's idea quota — one line above the INSERT this work already had to edit |
| `operations/connector-read-core.ts` (`projectGet`'s `ideaCount`)                 | Reported a count that was neither the old nor the new definition                                                 |

Two more reads in `routes/mcp/idea-tools.ts` (the `link_idea` existence pre-check and the
`list_linked_ideas` enrichment) were not wrong — the write path behind them already enforces
the predicate — but went through it too, so an agent is never handed a non-idea row labelled
as a linked idea.

Migration `0207` backfills `is_idea = 1` for every row the old `status = 'draft'` definition
covered, so nothing that was in anyone's Ideas list has left it.

## Decision 16: the migration-to-rollout window (coordinator condition 1, seq 210)

`0207` runs before the new Worker is live. An idea the OLD Worker creates in that window —
one to three minutes — is written with `is_idea = 0` by a writer that did not yet set the flag,
and is invisible to every idea read afterwards. The backfill has already passed it.

- [ ] After the STAGING deploy, run the read-only D1 SELECT below and post the count on
      `feature.linked-work`.
- [ ] After the PRODUCTION deploy, run it again against production and post the count.
- [ ] If either is above zero: post the ids, and backfill by id ONLY after the coordinator's OK.

Run inside `exec_with_secrets` with `secretNames: ["CF_TOKEN"]` (program decision 13), against
`/accounts/c4e4aebd980b626f6af43ac6b1edcede/d1/database/1cfaf5d4-8226-47d8-bf26-6ba727ce5718/query`
for staging.

Two things about this query were wrong in its first draft and are worth keeping written down,
because both would have produced a confident, meaningless number:

1. **The two columns are not the same format.** `d1_migrations.applied_at` is a SQLite
   `TIMESTAMP` and holds `2026-10-24 04:22:28`; `tasks.created_at` is ISO 8601 and holds
   `2026-10-24T04:22:28.000Z`. Compared as strings, position 11 is `T` (0x54) against ` `
   (0x20), so EVERY task created that day sorts after the bookmark — including ones created
   hours before it. The comparison has to normalize the separator first. Verified against the
   real staging table rather than assumed (`PRAGMA table_info(d1_migrations)`).
2. **Nothing distinguishes the two kinds of row by column.** A person filing an idea on the web
   and `POST /tasks` creating an ordinary task both write `triggered_by = 'user'`,
   `task_mode = 'task'`, `status = 'draft'`. So the only thing that separates "an idea the old
   Worker wrote in the window" from "an ordinary task, correctly not an idea" is WHEN it was
   written: before the Worker swap, or after it. That is why the upper bound is not optional —
   without it the count grows with ordinary task creation forever and means nothing.

Take the upper bound from the deploy run's own completion time
(`gh run view <id> --json updatedAt`), as an ISO 8601 string.

```sql
-- Every draft the new definition does not cover, created between the migration and the
-- Worker swap. Rows after the swap are ordinary tasks by construction: every idea writer
-- sets the flag from that moment on.
SELECT id, title, triggered_by, task_mode, agent_profile_hint,
       description IS NOT NULL AS has_content, created_at
  FROM tasks
 WHERE status = 'draft'
   AND is_idea = 0
   AND created_at >= (
         -- ' ' -> 'T' so this compares against an ISO `created_at`. MAX, because a
         -- re-applied migration would leave two rows with the same name.
         SELECT replace(MAX(applied_at), ' ', 'T')
           FROM d1_migrations
          WHERE name = '0207_tasks_idea_flag.sql'
       )
   AND created_at <= '<worker swap, ISO 8601>'
 ORDER BY created_at;
```

Both halves proven on the real staging D1 engine before the deploy, rather than reasoned about
(`SELECT` of the comparison itself, 2026-10-24T07:47Z):

| Expression                                                          | Result                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `'2026-10-24T01:00:00.000Z' >= '2026-10-24 04:22:28'` (naive)       | `1` — admits a row written 3h22m BEFORE the bookmark |
| `'2026-10-24T01:00:00.000Z' >= replace(…,' ','T')` (fixed)          | `0` — rejects it                                     |
| `'2026-10-24T07:50:00.000Z' >= replace(…,' ','T')` (fixed, control) | `1` — still admits a genuine window row              |

The staging table could not have shown this on its own: it holds no `status='draft'` rows
created on 2026-10-24, so both predicates return the same count of zero there. A query whose
only evidence is "it returned zero" is indistinguishable from a query that cannot match
anything, which is the whole reason for the comparison above.

### Run it, and the answer, 2026-10-24

The window is **08:43:39 → 12:52:58Z** (migration applied, to the last Worker swap of the day),
which is about four hours across four deploys — not the "one to three minutes" estimated above.
The migration runs early in `Deploy to Cloudflare` and the Worker swaps at the end of it, and
each re-deploy reopens nothing: the migration is applied once, so the window closes at the
FIRST swap. The figure above is the conservative outer bound.

**Window rows: 0.**

That zero only means something because the predicate was shown to be capable of matching. It
was not, for most of the day: staging held no `status='draft' AND is_idea=0` row at all, so the
query would have returned 0 whether or not it worked. Proven against the deployed Worker at
13:00Z, with the row created and removed in the same job:

| step                                 | result                              |
| ------------------------------------ | ----------------------------------- |
| before                               | predicate matches **0**             |
| `POST /tasks` on the deployed Worker | `status='draft'`, **`is_idea = 0`** |
| after                                | predicate matches **1**             |
| `GET /api/projects/:id/ideas/<id>`   | **404** — the Ideas read refuses it |
| after delete                         | back to **0**                       |

That is also the live verification of this PR's documented claim that `POST /tasks` drafts are
no longer ideas — against deployed code rather than a fixture.

Count zero is the expected answer, and the window is one to three minutes wide. Anything in it
needs a human look at `has_content` and `agent_profile_hint` before a backfill by id, because
an ordinary task created in the same minute looks identical to the query.

**Accepted, and noted here because it is a real behaviour change**: the backfill marks every
row the old definition covered, which includes ordinary undispatched tasks that existed before
this migration. They become ideas. That is deliberate — leaving them out would make items
vanish from a page someone is already looking at — and it is bounded: no NEW ordinary task
joins them, and the only thing a person can now do to one through the idea surfaces is mark it
done, park it, or start work on it, never run it in place.

## What the five local reviews changed (2026-10-24)

Security found 0 CRITICAL and 0 HIGH. Everything below is from the other four, or is the one
CI failure, and all of it is fixed in `1f44320f5` except where noted.

| From                   | Finding                                                                     | Resolution                                                                                   |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| CI                     | `tests/workers/resource-links-routes.ts` built its idea with `POST /tasks`  | Uses `POST /ideas`; gained the reciprocal attack case through the composed router            |
| Security (MED x3)      | Three live readers still said `status = 'draft'`                            | All call `ideaTaskPredicateSql`; two more reads in `idea-tools.ts` joined them               |
| Security (LOW)         | A `ready` idea could be delegated, running an idea in place                 | `draft -> ready` refused (decision 1); exits from `ready` kept (rule 71)                     |
| UI/UX (HIGH)           | Needs you was ranked by recency, so a merged card could fold a blocked one  | Ranked question -> stuck -> merged, stably; mixed-severity tests, proven discriminating      |
| UI/UX (MED)            | The phone never showed the "N in total" hint the laptop did                 | One `doneHint` for both layouts                                                              |
| UI/UX (LOW x3)         | `Panel` tone override, `aria-label` mismatch, `ideaSourceLabel` unused here | `success` tone added; label matches the heading; the function moves to PR2 with its consumer |
| Cloudflare             | `listIdeaAssetLinksForTargets` lost its index seek without ANALYZE          | Rewritten to `IN (SELECT value FROM json_each(?))`, matching `listLinksForTargets`           |
| Cloudflare             | `projects.repository` read twice per page                                   | `getPullRequestStates` takes an optional `repository`                                        |
| Cloudflare             | The <=8 budget was proven only for a session-link-free page                 | Second case: 100 ideas x 2 chats, 200 task ids, three chunks                                 |
| Architecture (HIGH x2) | Duplicate cap resolver; duplicated PR-source rule                           | `resolveResourceLinkBatchCaps` and `canonicalPullRequestRefs` in `link-core.ts`              |
| Architecture (MED)     | `/sam` `create_idea` is a fourth idea-creation path                         | Deferred: idea `01M5PBGHYP4Q4CBDYRM707KWHT`                                                  |
| Completion (HIGH)      | Criterion 3's third surface was never tested                                | `tests/unit/routes/idea-status-surface-agreement.test.ts` drives all three                   |
| Completion (MED)       | Two writers missing from the enumeration                                    | Added above                                                                                  |
| Completion (MED)       | No single test crosses the real route -> DO RPC hop                         | Open; recorded as a gap in the PR                                                            |

## Acceptance criteria

1. An idea's state is derived from its linked work, never typed: a linked chat starting moves it to
   In progress, an open PR to In review, a merged PR into Needs you, a needs-input marker to
   Waiting for you, a failure to Stopped. Each state names where it came from.
2. Weak links (`read`, `viewed`, `discusses`) never change an idea's state.
3. "Mark done" and "Park" go through one server operation; `update_idea`, the ideas UI and the generic
   task status route agree, and a test proves the route and `update_idea` agree.
4. The Ideas list shows Needs you first (≤3 cards then "N more need you"), each with its fix as a
   button; In progress; Not started; Done recently and Filed by agents folded; desktop side column.
5. The idea page shows the status card with one primary action, the plan, Work, Updates and Related.
6. `GET /ideas` stays within 20 round trips for a 100-idea project and never refreshes PR state live.
7. Markdown lists render bullets and numbers on the idea page and in chat.
8. No horizontal overflow at 375×667 or 1280×800 with stress data; screenshots posted to each PR.
9. Verified on staging as a user, on phone and desktop widths.

## Round-trip cost of the Ideas list (rule 60)

Recorded here because the list is the page that scales with a project's history, so the next
person to add a read to it needs the current number rather than a guess.

A full page costs a fixed handful of round trips, never one per idea:

| Read                                                                | Round trips        |
| ------------------------------------------------------------------- | ------------------ |
| `readIdeaRows` open, `readIdeaRows` closed, `readIdeaTotals`        | 3 D1               |
| `getIdeaWorkSnapshots` (all ideas in one call)                      | 1 DO RPC           |
| `readSessionTasks`, `readAssociatedPullRequests` (96 ids per chunk) | 2 x ceil(chats/96) |
| `readAgentProfileNames`                                             | 1 D1               |

At 100 ideas and 300 linked chats that is about 13, inside the ≤20 aggregation budget, and
`ideas-routes.test.ts` pins it at a full 100-idea page. Two things would move it: T2's
pull-request-state operation replacing the stub (re-measure at integration), and an idea
accumulating linked chats without bound — tracked in
`tasks/backlog/2026-10-24-cap-linked-chats-per-idea.md`.

## One deliberate divergence from the approved design

The approved idea page has a single button on a not-started idea. This ships a quiet second
one, **Park**, because Parked is a state the page renders, the docs describe, and nothing else
in the app can enter — without it the state is unreachable. "Start work" is still the filled
primary and Park is the ghost beside it, so the one obvious next step is unchanged. Flagged in
PR2 for Raphaël to veto; removing it is one case in `ideaSecondaryAction`.

## Notes

- Nothing merges until T1, T2 and T3 are on `main` and this code uses their real operations.
- `.do-state.md` is the live tracker.
