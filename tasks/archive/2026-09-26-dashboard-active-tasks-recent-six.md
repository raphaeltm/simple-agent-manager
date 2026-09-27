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

### Third ranking defect: a task with several sessions used its oldest

`getSessionsByTaskIds` returns sessions `ORDER BY updated_at DESC`, but the route's `sessionMap.set` let each
later (older) row overwrite the first, so a task linked to several `chat_sessions` rows was ranked by — and
linked to — its OLDEST session. `chat_sessions.task_id` is not unique; production has 9 such tasks (none active
today). Found independently by the author and the cloudflare-specialist review. Fix: keep the first session per
task, the same convention `project-orchestrator/stall-detection.ts:resolveActiveSessionIdsForTaskIds` uses.

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

- [x] `packages/shared/src/constants/defaults.ts`: `DEFAULT_DASHBOARD_ACTIVE_TASK_LIMIT` 100 → 6 (display cap);
      add `DEFAULT_DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT = 100`; export it from `constants/index.ts`
- [x] `apps/api/src/env.ts`: add `DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT`
- [x] `apps/api/src/routes/dashboard.ts`: read candidates with the candidate limit (clamped to
      `D1_MAX_BOUND_PARAMETERS`), rank every enriched candidate by most recent activity (newest message, else
      `startedAt ?? createdAt`; ties break on id), then return the first `DASHBOARD_ACTIVE_TASK_LIMIT`
- [x] `packages/shared/src/types/task.ts`: document the response contract (most recent first, capped)
- [x] Docs: `.claude/skills/env-reference/SKILL.md`, `apps/api/.env.example`
- [x] Tests (`apps/api/tests/unit/routes/dashboard.test.ts`): display cap default + env override, candidate
      limit default + env override + clamp, "just-submitted task ranks by submit time", deterministic ties
- [x] Real-SQL vertical slice (`apps/api/tests/unit/routes/dashboard-active-tasks-real-sql.test.ts`): real
      `listAgentActivityTasks` over in-memory SQLite + mocked DO; more than six active tasks whose start order
      differs from their recency order; assert exactly the six most recently active come back, newest first
- [x] Prove the vertical slice discriminating: applying the cap in the D1 read (naive fix) must turn it red
- [x] Keep the most recently updated session per task (first in the DO's `updated_at DESC` order) + test
- [x] Review follow-ups (test-engineer): failed project lookup × rank + cap with more than six candidates;
      unparseable timestamp ranks last without failing the request

## Acceptance Criteria

- [x] `GET /api/dashboard/active-tasks` returns at most 6 tasks by default (`DASHBOARD_ACTIVE_TASK_LIMIT`)
- [x] The returned tasks are the most recently active of ALL candidates, newest first — not the most recently
      started
- [x] A just-submitted task with no messages yet ranks by its submit/start time, not below every dormant session
- [x] Both limits are env-configurable with `DEFAULT_*` constants; the candidate limit never exceeds the
      platform bind ceiling
- [x] Other consumers of `listAgentActivityTasks` are unaffected
- [ ] CI green; merged; production deploy succeeded (verified after merge — see the PR)

## References

- `apps/api/.claude/rules/65-capped-selection-must-rank-and-disclose.md`
- `apps/api/.claude/rules/69-emergency-config-paths-need-their-own-coverage.md` (harness/bind ceiling)
- `apps/api/.claude/rules/67-shared-predicates-that-trigger-actions.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`
- Original feature: `tasks/archive/2026-03-03-dashboard-active-tasks-grid.md` ("ordered by most recent message")

## Implementation Notes

### Discrimination proof (surgical reverts of `apps/api/src/routes/dashboard.ts`, 29 tests)

| Revert | Tests that went red |
| --- | --- |
| A: cap the D1 read at the display limit (the naive fix) | real-SQL "returns the six most recently active tasks, not the six most recently started"; unit: empty-array candidate limit, "caps the response … without shrinking the candidate read", candidate env override, bind-ceiling clamp |
| B: old comparator (messages always first) | all 3 real-SQL tests; unit: failed-lookup × cap, "ranks a task without messages by when it was submitted", "… by when it started", id tie-break, unparseable timestamp |
| C: ignore `startedAt` | unit: failed-lookup × cap, "ranks a started task without messages by when it started" |
| D: drop the id tie-break | unit: "breaks activity ties on task id …" |
| E: drop the bind-ceiling clamp | unit: "clamps the candidate read to the SQL bind ceiling …" |
| F: let a later (older) session overwrite the first | unit: "ranks and links a task by its most recently updated session when it has several" |
| G: drop the unparseable-timestamp guard | unit: "ranks a task with an unparseable timestamp last instead of failing the request" |

Source restored after each run. The test-engineer reviewer independently re-ran reverts A–E with identical results.

### Review outcomes (Phase 5, local subagents)

- task-completion-validator: PASS (LOW: tick verified criteria — done; LOW: 100-candidate ceiling — documented)
- cloudflare-specialist: PASS (LOW: multi-session overwrite — fixed; INFO: disclosure/I-O shape unchanged)
- test-engineer: PASS (MEDIUM: failed lookup × cap test — added; LOW: unparseable timestamp test — added)
- constitution-validator: PASS · env-validator: PASS (LOW pre-existing: no GitHub-Environment override path for
  any `DASHBOARD_*` var) · doc-sync-validator: PASS
