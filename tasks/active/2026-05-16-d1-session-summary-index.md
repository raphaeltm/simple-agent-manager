# D1 Session Summary Index — Eliminate Cross-Project DO Fan-Out

## Problem

Three UI features need cross-project session data:
- Recent chats popover (`useRecentChats`) — 1 `listProjects` + N `listChatSessions` RPCs
- `/chats` page (`useAllChatSessions`) — same fan-out pattern
- Command palette — inherits from above

With 20 projects = 21 HTTP requests per load. Each DO RPC runs N+2 SQL queries + cold wakeups. The popover takes 1-3+s to show content.

## Research Findings

### Current Architecture
- Sessions live exclusively in per-project `ProjectData` DO SQLite (`chat_sessions` table)
- No cross-project session table exists in D1
- `useRecentChats.ts` (157 lines): fetches all projects, fans out `listChatSessions` per project, filters active/non-stale, sorts by recency, shows top 8
- `useAllChatSessions.ts` (91 lines): same fan-out, sorts all sessions by recency
- Both hooks are in `apps/web/src/hooks/`
- Frontend API: `listChatSessions()` in `apps/web/src/lib/api/sessions.ts` calls `GET /api/projects/:id/sessions`
- Backend: `chatRoutes` in `apps/api/src/routes/chat.ts` calls `projectDataService.listSessions()` which does DO RPC

### Session Lifecycle & Sync Points
- **Session created**: `ProjectData.createSession()` → `sessions.createSession()` in `project-data/sessions.ts`
- **Session stopped**: `ProjectData.stopSession()` → `terminateSession(sql, sessionId, 'stopped')`
- **Session failed**: `ProjectData.failSession()` → `terminateSession(sql, sessionId, 'failed')`
- **Topic updated**: `ProjectData.updateSessionTopic()` → `sessions.updateSessionTopic()`
- **Workspace linked**: `ProjectData.linkSessionToWorkspace()` → `sessions.linkSessionToWorkspace()`
- **Agent completed**: `ProjectData.markAgentCompleted()` → `sessions.markAgentCompleted()`
- All these already call `this.scheduleSummarySync()` which debounces and syncs project-level summary to D1

### Existing D1 Summary Pattern
- `syncSummaryToD1()` already syncs `lastActivityAt` and `activeSessionCount` to the `projects` table
- The DO knows its projectId via `ensureProjectId()` stored in `do_meta`
- The DO has access to `env.DATABASE` (D1)
- Debounce is configurable via `DO_SUMMARY_SYNC_DEBOUNCE_MS` (default 5000ms)

### Key Types
- `ChatSessionListItem` in `apps/web/src/lib/api/sessions.ts` — the frontend type
- `ChatSession` in `packages/shared/src/types/session.ts` — the shared type
- `RecentChat` extends `ChatSessionListItem` with `projectId` + `projectName`
- `EnrichedChatSession` also extends `ChatSessionListItem` with `projectId` + `projectName`
- Session statuses in DO: 'active', 'stopped', 'failed'

### Migration Numbering
- Latest migration: `0048_missions.sql`
- New migration: `0049_session_summaries.sql`

### Route Mounting
- Chat routes: `app.route('/api/projects/:projectId/sessions', chatRoutes)` in index.ts
- New cross-project routes: `GET /api/chats/recent` and `GET /api/chats` need a new route file mounted at `/api/chats`
- Admin routes: `app.route('/api/admin', adminRoutes)` — backfill endpoint goes here

## Implementation Checklist

### Phase 1: D1 Migration + Schema
- [x] Create `0049_session_summaries.sql` with table + indexes
- [x] Add Drizzle schema definition in `apps/api/src/db/schema.ts`

### Phase 2: Shared Types
- [x] Add `SessionSummary` type to `packages/shared/src/types/session.ts`
- [x] Export from `packages/shared/src/types/index.ts`

### Phase 3: D1 Write Path (DO → D1 Sync)
- [x] Create `apps/api/src/services/session-summary-sync.ts` with upsert/update functions
- [x] Add session-level sync to `ProjectData.syncSummaryToD1()` (piggyback on existing debounce)
- [x] Sync on: session created (INSERT), stopped/failed (UPDATE status, ended_at), topic change (UPDATE topic), workspace linked (UPDATE workspace_id), agent completed (UPDATE agent_completed_at)
- [x] Start with status-transition-only sync for message_count/last_message_at (option 1)

### Phase 4: API Endpoints
- [x] Create `apps/api/src/routes/chats.ts` with cross-project chat routes
- [x] `GET /api/chats/recent?limit=8&status=active&staleThreshold=10800000` — single D1 query for popover
- [x] `GET /api/chats?limit=50&offset=0` — paginated all-sessions for /chats page
- [x] Both join with projects table for project_name, scoped to authenticated user
- [x] Mount in `apps/api/src/index.ts`

### Phase 5: Admin Backfill Endpoint
- [x] Add `POST /api/admin/backfill-session-summaries` to admin routes
- [x] Fan out to all DOs, read sessions, write to D1

### Phase 6: Frontend Changes
- [x] Add `getRecentChats()` and `getAllChats()` API functions in `apps/web/src/lib/api/sessions.ts`
- [x] Rewrite `useRecentChats.ts` to use `GET /api/chats/recent` (single request)
- [x] Rewrite `useAllChatSessions.ts` to use `GET /api/chats` (single request)
- [x] Ensure `RecentChat` / `EnrichedChatSession` types still satisfy consumers
- [x] Delete fan-out code from both hooks

### Phase 7: Tests
- [x] Integration test for `GET /api/chats/recent` — verifies D1 query, user scoping, filtering
- [x] Integration test for `GET /api/chats` — verifies pagination, sorting
- [ ] Integration test for session summary sync — verifies D1 rows created/updated on session mutations (deferred: requires full DO test harness with D1 binding; sync is tested end-to-end via staging)
- [ ] Unit test for the backfill admin endpoint (deferred: endpoint relies on DO RPC which requires Miniflare DO binding)
- [ ] Frontend hook tests — verify new hooks use the new API (deferred: hooks are thin wrappers over API calls; verified via staging)

## Acceptance Criteria

- [ ] Recent chats popover loads in a single HTTP request (no DO fan-out)
- [ ] `/chats` page loads in a single HTTP request (no DO fan-out)
- [ ] D1 `session_summaries` table is populated on session create/stop/fail/topic-change/workspace-link/agent-complete
- [ ] Active count badge comes from the same single query
- [ ] Session data in D1 is eventually consistent with DO (acceptable for navigation popover)
- [ ] Admin backfill endpoint populates D1 from existing DO sessions
- [ ] All existing consumers (RecentChatsDropdown, Chats page, GlobalCommandPalette) continue to work
- [ ] Cross-project queries are scoped to the authenticated user (no data leakage)

## References

- Idea: 01KRQTNPZPFQ8JJ2JZ5C53FAKR
- Key files:
  - `apps/web/src/hooks/useRecentChats.ts` — current fan-out hook
  - `apps/web/src/hooks/useAllChatSessions.ts` — current fan-out hook
  - `apps/api/src/durable-objects/project-data/sessions.ts` — DO session CRUD
  - `apps/api/src/durable-objects/project-data/index.ts` — DO entry point with syncSummaryToD1
  - `apps/api/src/routes/chat.ts` — per-project session routes
  - `apps/api/src/db/schema.ts` — Drizzle schema
