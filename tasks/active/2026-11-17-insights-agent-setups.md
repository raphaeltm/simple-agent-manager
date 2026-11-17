# Insights slice S: Agent setups tab

SAM task 01M7KCCAJ3D5XYVD37SZH7B4ZJ · coordinator 01M7JK6W6PRQN64GD2MVMFZKBX · spec idea
01M7HTS38KX2G78JD0ESAGMKKH · channel `feature.insights` · branch `sam/build-insights-slice-s-h7b4zj`.

## Problem

The project Insights page (`/projects/:id/insights`) shows "coming soon" on its Agent setups tab.
Slice S replaces it: per profile, skill or model, how runs went (runs, merged without rework,
median to PR, human nudges, tokens per merged PR, memory p90 against the request), plus one-tap
suggestions (a default profile for a skill, a memory request for a skill) applied through the
existing skill update API.

## Research findings

- Run population: Flow's `runsCte` (`packages/operations/src/insights-flow-sql.ts`), shared with
  Accounts through an option flag. Rework rule: `reworkStatement` (same head branch, or same idea,
  within `insights.flowReworkWindowDays`). The idea half needs `ideaItemsWithPullRequests`
  (up to 6 round trips), over the setups budget of 6. Setups reuses the same-branch half through a
  shared SQL fragment and says so in the response (`rework.rule = 'same_branch'`) and on the page.
- Batch pattern: `runInsightsBatch` / `parseInsightsRows` (`insights-batch.ts`).
- Settings: `INSIGHTS_PAGE_SETTINGS` (`insights-page-settings.ts`).
- Profile/skill per run: `agent_sessions.agent_profile_id` (resolved) else `tasks.agent_profile_hint`
  (a profile id), `tasks.skill_id`. Indexes from migration 0252 serve per-skill/profile reads.
- Model per run: `agent_sessions.runtime_contract_json` `$.model` (null = the harness default).
- Memory: `workspace_resource_summaries` (`memory_peak_bytes`, `oom_count`, index
  `(project_id, task_id, ended_at)`); requested = workspace else task `resolved_reservation_json`,
  parsed by receipt's `reservationOf`.
- Tokens: `agent_run_usage` (U, #2811), keyed `(project_id, chat_session_id, source, …)`; read
  prefers `ai_proxy` rows when a session has any (same rule as `readRunUsage`).
- Nudges: messages live in the ProjectData DO. A person's follow-up is a `chat_messages` row with
  `role='user'` whose `tool_metadata.source` is `user_followup` (send-chat) or `comment_directive`
  (`HUMAN_PROMPT_DELIVERY_TRIGGERS`). Durable delivery is on by default; the legacy non-durable
  path writes no marker, so it is not counted (documented). Partial index
  `idx_chat_messages_user_content (session_id, content) WHERE role='user'` bounds each probe to the
  chat's user messages.
- Suggestions: `skills.default_profile_id` and `skills.resource_requirements_json`; PATCH
  `/api/projects/:projectId/skills/:skillId` (capability `project:update`, `requireProjectProfile`
  accepts project profiles or the caller's own). Web client `updateSkill` in `lib/api/agents.ts`.
- Web: `pages/insights/` (AccountsTab pattern, `useInsightsRange`, `projectAccountsQueryOptions`),
  `ComingSoonTab` still serves People.

## Checklist

- [ ] Shared types `packages/shared/src/types/insights-setups.ts` + exports
- [ ] Settings: run scan cap, suggestion minimum runs, gap, memory headroom
- [ ] `runsCte({ setup: true })` columns; `run_prs` carries the URL; shared same-branch rework SQL
- [ ] `insights-setups-sql.ts` (one statement), `insights-setups-compute.ts` (groups),
      `insights-setups-suggestions.ts`, `insights-setups.ts` (`projectSetups`)
- [ ] DO RPC `countRunNudges` + client + port + operation-ports wiring
- [ ] REST `GET /api/projects/:projectId/insights/setups?range&groupBy`
- [ ] Tests: real-SQL foreign-project attack + owner control, malformed rows, round-trip budget,
      suggestions thresholds, DO nudges (workers), route
- [ ] Web: AgentSetupsTab, group-by control in `?groupBy=`, table/cards, Compared, suggestions
      applied via `updateSkill`; remove agent-setups from ComingSoonTab
- [ ] Playwright visual audit 375/1280 realistic/empty/stress
- [ ] Docs: Insights section of the project guide
- [ ] Staging: real runs across ≥2 profiles or skills; one suggestion end to end if data allows

## Acceptance criteria

- Setups reads ≤ 6 round trips; project id bound in every predicate (attack test + owner control).
- Every metric is measured or marked missing (tokens "not reported", nudges/memory "not recorded").
- Suggestions only appear above the stated minimum sample and apply through PATCH skill.
- Agent setups tab live on staging with real data; production deploy succeeds.
