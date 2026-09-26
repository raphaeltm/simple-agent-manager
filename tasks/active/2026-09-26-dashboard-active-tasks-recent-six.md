# Dashboard Active Tasks: Show the Six Most Recently Active

**Created**: 2026-09-26
**SAM task**: 01M3FB2AJH0XF1N67PMQAAF11S (branch `sam/active-task-list-home-aaf11s`)

## Problem Statement

Raphaël: "The active task list on the home page, the dashboard, when I log in, should have a maximum of six
things, maybe, and the six things with the most recent messages. Right now, I'm getting like a list of, I don't
know, like 20 different things that some of them are definitely not active. Like they haven't done anything in
many, many hours, maybe over a day in some cases."

He authorized shipping directly: "create a PR get it green and ship it", and explicitly waived staging
("you have permission to skip staging").

## Research Findings

### Production evidence (read-only `sam-prod` D1, 2026-09-26 ~17:15Z)

- His account has **36** tasks that `/api/dashboard/active-tasks` treats as active (`status IN
  ('queued','delegated','in_progress') AND superseded_by_task_id IS NULL`). All are conversation-mode
  `in_progress` tasks: **2** are running, **34** are sleeping sessions whose last activity ranges back to
  2026-09-20. A conversation task stays `in_progress` while asleep (7-day snapshot retention), so the
  "active" set is mostly dormant work.

### Current code path

- `apps/api/src/routes/dashboard.ts` — `GET /api/dashboard/active-tasks`:
  1. `listAgentActivityTasks(env, { userId, activeOnly: true, limit: DASHBOARD_ACTIVE_TASK_LIMIT })`
     (default **100**). The shared SQL orders by `COALESCE(t.started_at, t.created_at) DESC, t.id ASC`.
  2. One `getSessionsByTaskIds` ProjectData DO RPC per project to read each task's session
     (`lastMessageAt` = `chat_sessions.updated_at`, which every persisted message bumps).
  3. Sorts by `lastMessageAt` DESC — tasks **with** messages first, tasks without messages last by `createdAt`.
  4. Returns **every** row. There is no display cap.
- `apps/web/src/pages/Dashboard.tsx` renders every returned task in a 1/2/3-column grid via
  `ActiveTaskCard`; the card shows "Last msg Xm ago" from the same `lastMessageAt`. No client-side cap.
- `DASHBOARD_ACTIVE_TASK_LIMIT` is documented as "Maximum active tasks returned" but is applied to the D1
  read **before** ranking.

### Why the naive fix is wrong (`apps/api/.claude/rules/65-capped-selection-must-rank-and-disclose.md`)

Setting the existing limit to 6 would cap the D1 read, which is ordered by **start time**, before the
recency data (in per-project DOs) is known — returning the six most recently *started* tasks, not the six most
recently *active*. A conversation started days ago that is still being used would vanish. The cap must be
applied **after** ranking by the purpose (recency).

### Second ranking defect

The current comparator ranks every task that has ever had a message above every task that has none. With a
six-item cap, a task submitted a moment ago (queued/provisioning, no messages yet) would be buried below six
dormant sessions — invisible on the dashboard exactly when the user expects to see it. A task with no messages
must rank by when it started (or was submitted), i.e. the same `COALESCE(started_at, created_at)` key the
candidate query already uses.

### Other constraints checked

- **Config overrides (rule 70)**: no `DASHBOARD_*` variable in the GitHub `production` (43 vars) or `staging`
  (16 vars) Environments and none in `apps/api/wrangler.toml`, so the shared default governs the deployed value.
- **Bind ceiling (rule 69)**: each project's candidate ids travel in ONE `IN (...)` list to its DO
  (`sessions.ts:getSessionsByTaskIds`); Cloudflare SQL rejects the 101st bound parameter. Candidates must stay
  ≤ `D1_MAX_BOUND_PARAMETERS` (100) — true today only because the default happens to be 100.
- **Shared query (rule 67)**: `listAgentActivityTasks` also serves `account-map.ts` and the MCP
  `workspace-tools-direct.ts`; its ordering is left unchanged. Ranking happens in the dashboard route.
- **I/O budget (rule 60)**: unchanged — 1 D1 query + 1 DO RPC per project with active tasks.
- **No UI change needed**: the page renders whatever the API returns; six cards fill a 3-column grid.
- **Disclosure (rule 65)**: the dashboard is a "most recent" summary; every hidden session remains reachable
  from its project chat list. `/chats` was considered as a "view all" target but it filters to recently active
  sessions itself, so it would not show what the dashboard hid. No UI count/link is added (not requested).
- Public docs do not describe the Active Tasks list or its env vars; env docs live in
  `.claude/skills/env-reference/SKILL.md` and `apps/api/.env.example`.

## Implementation Checklist

- [ ] `packages/shared/src/constants/defaults.ts`: `DEFAULT_DASHBOARD_ACTIVE_TASK_LIMIT` 100 → 6 (display cap);
      add `DEFAULT_DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT = 100`; export it from `constants/index.ts`
- [ ] `apps/api/src/env.ts`: add `DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT`
- [ ] `apps/api/src/routes/dashboard.ts`: read candidates with the candidate limit (clamped to
      `D1_MAX_BOUND_PARAMETERS`), rank every enriched candidate by most recent activity (newest message, else
      `startedAt ?? createdAt`; ties break on id), then return the first `DASHBOARD_ACTIVE_TASK_LIMIT`
- [ ] `packages/shared/src/types/task.ts`: document the response contract (most recent first, capped)
- [ ] Docs: `.claude/skills/env-reference/SKILL.md`, `apps/api/.env.example`
- [ ] Tests (`apps/api/tests/unit/routes/dashboard.test.ts`): display cap default + env override, candidate
      limit default + env override + clamp, "just-submitted task ranks by submit time", deterministic ties
- [ ] Real-SQL vertical slice (`apps/api/tests/unit/routes/dashboard-active-tasks-real-sql.test.ts`): real
      `listAgentActivityTasks` over in-memory SQLite + mocked DO; more than six active tasks whose start order
      differs from their recency order; assert exactly the six most recently active come back, newest first
- [ ] Prove the vertical slice discriminating: applying the cap in the D1 read (naive fix) must turn it red

## Acceptance Criteria

- [ ] `GET /api/dashboard/active-tasks` returns at most 6 tasks by default (`DASHBOARD_ACTIVE_TASK_LIMIT`)
- [ ] The returned tasks are the most recently active of ALL candidates, newest first — not the most recently
      started
- [ ] A just-submitted task with no messages yet ranks by its submit/start time, not below every dormant session
- [ ] Both limits are env-configurable with `DEFAULT_*` constants; the candidate limit never exceeds the
      platform bind ceiling
- [ ] Other consumers of `listAgentActivityTasks` are unaffected
- [ ] CI green; merged; production deploy succeeded

## References

- `apps/api/.claude/rules/65-capped-selection-must-rank-and-disclose.md`
- `apps/api/.claude/rules/69-emergency-config-paths-need-their-own-coverage.md` (harness/bind ceiling)
- `apps/api/.claude/rules/67-shared-predicates-that-trigger-actions.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`
- Original feature: `tasks/archive/2026-03-03-dashboard-active-tasks-grid.md` ("ordered by most recent message")
