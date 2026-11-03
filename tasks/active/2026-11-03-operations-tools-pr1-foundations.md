# Operations tools PR1 — foundations (rename, switch, access gate, tool-list filtering, override fix, audit)

Task: `01M6GN63FR1V4063V7RVXMDT3X` · Orchestrator: `01M6GGJJAYQBEZXX2E93C9Y4WW` · Idea: `01M6GGY1QPGG4D40HG0PVGQS3R` · Policy: `a35180d5` (amended 2026-11-03)
Branch: `sam/operations-tools-pr1-3-xmdt3x` · Channel: `feature.operations-tools` · Merges first (PR1 → PR2 → PR3).

## Problem

Debugger ("operations") tools need one trust boundary that every sibling PR codes against: a per-installation
switch, an Operations-project + task-token + current-superadmin gate checked on every call, an audit log, and a
tool registry/listing pattern. Two existing gaps are fixed in the same effort: incident tools are listed to every
project, and `override_task_state` lacks the current-capability re-check and task-token requirement that
`stop_subtask` has.

## Research findings

- Feedback project id: `configuredFeedbackProjectId(env)` (`services/platform-feedback-incident-config.ts:172`),
  runtime `platform_settings` key `feedback.projectId`, env fallback `PLATFORM_FEEDBACK_PROJECT_ID`. One uncached D1 read.
- Admin settings registry already supports `type: 'enum'` with `choices` (`connector.clientRegistration`), and the
  admin UI already renders enums as a `<select>` (`apps/web/src/pages/AdminSettings.tsx:108`). A small
  `choiceDefinition` helper is enough. Settings outage → `outageValue` returns `defaultValue` (`off`) = fail closed.
- `adminSettingCacheMs` caches up to 60 s; `operations.samOperatorDisabled` uses 0 so a stop is observed at once.
  The debugger switch is a security boundary, so it also gets 0 (one `platform_settings` read per gated call).
- Superadmin = `users.role = 'superadmin'` AND `users.status = 'active'` (`middleware/settings-admin.ts:11`).
- Task owner = `tasks.user_id`; task-scoped token = non-empty `tokenData.taskId` (`services/mcp-token.ts:41`).
- `tools/list` returns the static `MCP_TOOLS` to every token (`routes/mcp/index.ts:171`), incl. `INCIDENT_TOOLS`.
- Generic tool errors thrown inside `tools/call` become `INTERNAL_ERROR` in `index.ts` catch — need a typed
  `OperationsAccessError` mapped to `INVALID_PARAMS` there.
- `stop_subtask` gate: `denyWhenMcpActorLacksCurrentProjectCapability(..., 'task:write', ...)`
  (`orchestration-authority.ts`) + `resolveAgentTarget` rejects `!tokenData.taskId`.
- Daily cron `0 3 * * *` exists (`scheduled/handler.ts`, analytics forward); policy b0950dd6 wants storage cleanup
  at most daily → audit purge runs there, bounded batch, retention from an admin setting (policy 9017df94: tunables are
  admin settings, not env vars).
- Latest D1 migration: `0216_…`. New table is additive (no FK parents touched).
- `operations.projectId` alias: NOT trivial (platform-config status/write/UI paths all key on `feedback.projectId`) → skipped.
- Only the workspace MCP route exposes incident/override tools (no second runtime/surface to cover; rule 61).

## Implementation checklist

- [ ] `choiceDefinition` helper + `operations.debuggerTools` (enum, default `off`) and
      `operations.auditRetentionDays` (integer, default 90) settings; cache 0 for `operations.debuggerTools`
- [ ] `services/operations-access.ts`: `OperationsToolsMode`, `resolveOperationsToolsMode`, `isOperationsProject`,
      `evaluateOperationsAccess`, `requireOperationsAccess`, `OperationsAccessError`, `recordOperationsAudit`,
      `purgeExpiredOperationsAudit`
- [ ] Migration `0217_operations_audit_log.sql` + drizzle schema
- [ ] `routes/mcp/tool-definitions-operations-tools.ts` (`OPERATIONS_TOOLS`) + `operations-tools.ts` handlers +
      `OPERATIONS_TOOL_HANDLERS` registration in `tool-handler-table.ts`
- [ ] `ops_get_access_status` tool
- [ ] Map `OperationsAccessError` → JSON-RPC `INVALID_PARAMS` in `routes/mcp/index.ts` catch
- [ ] tools/list filtering: `listMcpToolsForToken(env, tokenData)` — incidents only to Operations project; ops tools
      only to Operations project when mode ≠ off; fail closed (hide) on read failure without failing tools/list
- [ ] `override_task_state`: require task-scoped token + current `task:write` re-check
- [ ] Daily audit purge wired into the `0 3 * * *` cron, isolated from analytics forward
- [ ] Rename "feedback project" → "Operations project" in UI (`PlatformIntegrationConfigForm.tsx`), API messages,
      MCP descriptions/errors, public docs
- [ ] Docs: admin-settings guide, self-hosting guide, configuration reference, agents tool table, api reference
- [ ] Tests (real SQL): gate attack cases + owner control, demotion mid-task, mode off / read+act, discriminating
      deletions; tools/list per project & mode; override_task_state stale capability / non-task token / legit path;
      audit write + failure tolerance + purge
- [ ] Playwright visual audit of the renamed admin section + the new setting (375 / 1280)
- [ ] Publish `contract-ready` on the channel after the contract push

## Acceptance criteria

- [ ] `requireOperationsAccess` denies each of: non-Operations project, user-scoped token, non-superadmin owner,
      demoted superadmin, mode `off`, mode `read` with `act`; allows the happy path
- [ ] Each guard proven discriminating by deleting it once (record which test went red)
- [ ] tools/list: Operations project sees incident tools (+ ops tools when mode ≠ off); other projects see neither
- [ ] `override_task_state` rejects stale capability and non-task tokens; legitimate path works
- [ ] Superadmin can edit `operations.debuggerTools` in Admin → Settings
- [ ] Staging: `ops_get_access_status` + tools/list verified for superadmin and non-superadmin tokens in the
      Operations project vs another project

## Notes

- D1 I/O: tools/list +1 read for every token (feedback project id), +1 for the Operations project (mode).
  A gated call: mode (1) + feedback project id (1) + task/user join (1) + audit insert (1) = 4.
