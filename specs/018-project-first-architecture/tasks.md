# Tasks: Project-First Architecture

**Input**: Design documents from `/specs/018-project-first-architecture/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.yaml

**Tests**: Included per Constitution Principle II (Infrastructure Stability) — TDD required for critical paths (DO class, migration logic, message persistence pipeline).

**Organization**: Tasks grouped by user story. Each story is independently implementable and testable after the Foundational phase.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US6)
- Exact file paths included in descriptions

---

## Phase 1: Setup

**Purpose**: Configure infrastructure for Durable Objects and new env vars

- [x] T001 Add Durable Object bindings and SQLite migration tags to `apps/api/wrangler.toml` (all environments: dev, staging, production)
- [x] T002 [P] Add new configurable env vars to `apps/api/wrangler.toml` vars: `MAX_PROJECTS_PER_USER`, `MAX_SESSIONS_PER_PROJECT`, `MAX_MESSAGES_PER_SESSION`, `MESSAGE_SIZE_THRESHOLD`, `ACTIVITY_RETENTION_DAYS`, `SESSION_IDLE_TIMEOUT_MINUTES`, `DO_SUMMARY_SYNC_DEBOUNCE_MS`
- [x] T003 [P] Add `PROJECT_DATA` Durable Object namespace to Pulumi stack in `infra/` and update teardown workflow to clean up DO namespace

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: D1 schema changes, DO class, shared types, and service layer that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Add shared types to `packages/shared/src/types.ts`: `ChatSession`, `ChatMessage`, `ActivityEvent`, `ProjectStatus`, `ChatSessionStatus`, `ProjectSummary` (with `githubRepoId`, `status`, `lastActivityAt`, `activeSessionCount` fields), `ProjectDetail` (with `recentSessions`, `recentActivity`)
- [x] T005 Build shared package: `pnpm --filter @simple-agent-manager/shared build`
- [x] T006 Create D1 migration in `apps/api/src/db/migrations/` adding columns to `projects` table: `github_repo_id INTEGER`, `github_repo_node_id TEXT`, `status TEXT DEFAULT 'active'`, `last_activity_at TEXT`, `active_session_count INTEGER DEFAULT 0`
- [x] T007 Update Drizzle schema in `apps/api/src/db/schema.ts`: add new columns to `projects` table, add `idx_projects_user_github_repo_id` unique index
- [x] T008 Create DO migration definitions in `apps/api/src/durable-objects/migrations.ts`: migration runner function + `001-initial-schema` migration (chat_sessions, chat_messages, task_status_events, activity_events tables with indexes per data-model.md)
- [x] T009 Create `ProjectData` Durable Object class in `apps/api/src/durable-objects/project-data.ts`: extend `DurableObject`, constructor with `blockConcurrencyWhile()` calling migration runner, Hibernatable WebSocket setup with ping/pong auto-response
- [x] T010 Add RPC methods to `ProjectData` DO in `apps/api/src/durable-objects/project-data.ts`: `createSession()`, `stopSession()`, `persistMessage()`, `listSessions()`, `getSession()`, `getMessages()`, `recordActivityEvent()`, `listActivityEvents()`, `getSummary()`
- [x] T011 Export `ProjectData` class from `apps/api/src/index.ts` and register `PROJECT_DATA` binding in the Env type
- [x] T012 Create project-data service layer in `apps/api/src/services/project-data.ts`: helper to get DO stub from projectId (`env.PROJECT_DATA.idFromName(projectId)`), typed wrapper methods for all DO RPC calls
- [x] T013 Write unit tests for DO migration runner and `ProjectData` class in `apps/api/tests/unit/durable-objects/migrations.test.ts`: test migration idempotency, session CRUD, message persistence, activity event recording

**Checkpoint**: DO class functional, D1 schema updated, service layer ready. User story implementation can begin.

---

## Phase 3: User Story 1 — Navigate by Project as Primary Unit (P1)

**Goal**: Projects are the primary landing page. Users see project summary cards and can drill into project detail showing workspaces, recent sessions, and activity.

**Independent Test**: User logs in, sees project list with summary cards, clicks into one, sees workspaces and recent sessions.

- [x] T014 [US1] Update `GET /api/projects` route in `apps/api/src/routes/projects.ts`: return `ProjectSummary` with `githubRepoId`, `status`, `lastActivityAt`, `activeSessionCount`, `activeWorkspaceCount` (computed from workspace query). Add `status`, `sort`, `limit`, `offset` query params per contracts/api.yaml
- [x] T015 [US1] Update `GET /api/projects/:id` route in `apps/api/src/routes/projects.ts`: return `ProjectDetail` with workspaces list, recent sessions (from DO via service), and recent activity (from DO via service)
- [x] T016 [P] [US1] Create `ProjectSummaryCard` component in `apps/web/src/components/ProjectSummaryCard.tsx`: displays repo name, last activity, active workspace count, active session count, project status badge
- [x] T017 [P] [US1] Create `useProjectData` hook in `apps/web/src/hooks/useProjectData.ts`: fetch project list with summaries, fetch project detail with sessions/activity
- [x] T018 [US1] Update `Dashboard.tsx` in `apps/web/src/pages/Dashboard.tsx`: replace workspace-centric landing with project-first view using `ProjectSummaryCard` grid sorted by last activity
- [x] T019 [US1] Update `Project.tsx` in `apps/web/src/pages/Project.tsx`: add tabs or sections for workspaces, recent chat sessions, activity feed. Add breadcrumb: Dashboard > Project Name

**Checkpoint**: User sees projects as landing page with summary cards and can drill into project detail.

---

## Phase 4: User Story 2 — Create Workspaces Within a Project (P1)

**Goal**: Workspaces always belong to a project. Creating a workspace from project context pre-fills repo/branch. Existing orphaned workspaces are migrated.

**Independent Test**: User opens a project, clicks "New Workspace," repo/branch are pre-filled, workspace appears under that project after creation.

- [x] T020 [US2] Update workspace creation validation in `apps/api/src/routes/workspaces.ts`: require `projectId` for new workspace creation (reject if missing), pre-fill `repository`, `branch`, `installationId` from project when `projectId` is provided
- [x] T021 [US2] Create orphaned workspace migration logic in `apps/api/src/services/workspace-migration.ts`: find workspaces with NULL `projectId`, match or create projects based on `repository` + `installationId` fields, update workspace records
- [x] T022 [US2] Add orphaned workspace migration trigger: run via cron or on first request after deployment in `apps/api/src/index.ts` scheduled handler
- [x] T023 [US2] Update `CreateWorkspace.tsx` in `apps/web/src/pages/CreateWorkspace.tsx`: when navigated from project context, pre-fill and lock repository/branch fields from project data
- [x] T024 [US2] Update workspace display in `apps/web/src/pages/Workspace.tsx`: show project association with navigable link back to project

**Checkpoint**: All new workspaces require a project. Existing orphaned workspaces are migrated. UI shows project context.

---

## Phase 5: User Story 3 — Persist Chat Sessions Beyond Workspace Lifecycle (P1)

**Goal**: Chat messages are persisted in real time to the project DO. Users can view full session history after workspace stops. Sessions can be resumed.

**Independent Test**: User sends messages in a workspace, stops the workspace, navigates to project session list, sees full conversation preserved.

- [ ] T025 [US3] Create chat persistence service in `apps/api/src/services/chat-persistence.ts`: intercept messages in the existing WebSocket proxy path, call `projectDO.persistMessage()` asynchronously (non-blocking), handle session create/stop lifecycle
- [ ] T026 [US3] Integrate chat persistence into the WebSocket proxy in `apps/api/src/index.ts` (or the existing workspace subdomain proxy handler): on message from browser → persist user message, on response from VM agent → persist assistant message
- [ ] T027 [US3] Create chat routes in `apps/api/src/routes/chat.ts`: `GET /api/projects/:projectId/sessions` (list sessions), `GET /api/projects/:projectId/sessions/:sessionId` (session with messages, cursor pagination), `POST /api/projects/:projectId/sessions/:sessionId/messages` (persist message). Register in `apps/api/src/index.ts`
- [ ] T028 [US3] Write unit tests for chat persistence pipeline in `apps/api/tests/unit/chat-persistence.test.ts`: test message interception, async DO write, error handling (non-blocking on failure), session lifecycle
- [ ] T029 [P] [US3] Create `ChatSessionList` component in `apps/web/src/components/ChatSessionList.tsx`: list of sessions with topic, status badge, message count, duration, timestamp. Sorted by recency
- [ ] T030 [P] [US3] Create `ChatSession.tsx` page in `apps/web/src/pages/ChatSession.tsx`: full message history view with role indicators (user/assistant/system/tool), tool call metadata display, cursor pagination for long sessions
- [ ] T031 [US3] Add chat session list to project detail page in `apps/web/src/pages/Project.tsx`: integrate `ChatSessionList` into the sessions tab, link each session to `ChatSession.tsx`
- [ ] T032 [US3] Add session resume flow: "Resume" button on stopped sessions that creates a new workspace with session context loaded (pass session ID to workspace creation)

**Checkpoint**: Chat messages persist through workspace stop. Users can browse and read full session history from project detail.

---

## Phase 6: User Story 4 — View Project Activity Feed (P2)

**Goal**: Projects show a chronological activity feed of workspace lifecycle events, session events, and task status changes.

**Independent Test**: User creates a workspace, runs a chat session, stops it — all events appear in the project activity feed with timestamps.

- [ ] T033 [US4] Add activity event recording calls to existing API routes: workspace creation/stop/restart in `apps/api/src/routes/workspaces.ts`, task status changes in `apps/api/src/routes/tasks.ts`, session start/stop in `apps/api/src/services/chat-persistence.ts` — each calls `projectDO.recordActivityEvent()`
- [ ] T034 [US4] Create activity routes in `apps/api/src/routes/activity.ts`: `GET /api/projects/:projectId/activity` with `eventType` filter, cursor pagination (`before` param), `limit`. Register in `apps/api/src/index.ts`
- [ ] T035 [P] [US4] Create `ActivityFeed` component in `apps/web/src/components/ActivityFeed.tsx`: reverse-chronological event timeline with event type icons, actor info, workspace/session links, relative timestamps, "load more" pagination
- [ ] T036 [US4] Integrate `ActivityFeed` into project detail page in `apps/web/src/pages/Project.tsx`: add activity tab with the feed component

**Checkpoint**: Project detail page shows activity feed with workspace, session, and task events.

---

## Phase 7: User Story 5 — Stable GitHub Repository Identity (P2)

**Goal**: Projects linked by stable numeric `github_repo_id`. Renames/transfers update display name without breaking the link. Deleted repos mark project as "detached."

**Independent Test**: Create a project for "user/repo-a", rename repo on GitHub, see project display updated name automatically.

- [ ] T037 [US5] Update project creation in `apps/api/src/routes/projects.ts`: require `githubRepoId` in `CreateProjectRequest`, store `github_repo_id` and `github_repo_node_id`, enforce unique constraint `(user_id, github_repo_id)`
- [ ] T038 [US5] Add GitHub webhook handlers for repository events in `apps/api/src/routes/github.ts`: handle `repository.renamed` (update `repository` field by `github_repo_id` lookup), `repository.transferred` (same), `repository.deleted` (set project `status = 'detached'`)
- [ ] T039 [US5] Update project creation UI in `apps/web/src/pages/Projects.tsx` (or the create project flow): pass `githubRepoId` from GitHub API repo data when user selects a repository
- [ ] T040 [US5] Add "detached" state indicator in project UI components: show warning badge on `ProjectSummaryCard` and project detail page when `status === 'detached'`, block new workspace creation for detached projects

**Checkpoint**: Projects survive repo renames/transfers. Deleted repos show detached state.

---

## Phase 8: User Story 6 — Isolated High-Throughput Data per Project (P3)

**Goal**: Validate that per-project DOs provide data isolation. Concurrent project operations don't interfere.

**Independent Test**: Two projects simultaneously receive chat messages; both maintain consistent response times.

- [ ] T041 [US6] Implement DO-to-D1 summary sync in `apps/api/src/durable-objects/project-data.ts`: on session create/stop and activity events, debounce and call back to update `projects.last_activity_at` and `projects.active_session_count` in D1 via the env DATABASE binding
- [ ] T042 [US6] Implement Hibernatable WebSocket handlers in `apps/api/src/durable-objects/project-data.ts`: `fetch()` for WebSocket upgrade, `webSocketMessage()` for incoming messages, `webSocketClose()` for cleanup. Broadcast new messages and activity events to connected clients
- [ ] T043 [US6] Create WebSocket route in `apps/api/src/routes/chat.ts` (or separate file): `GET /api/projects/:projectId/ws` — authenticate, get DO stub, forward upgrade request via `stub.fetch(c.req.raw)`
- [ ] T044 [US6] Write integration tests in `apps/api/tests/integration/project-data.test.ts`: test two project DOs operating concurrently via Miniflare, verify no cross-project data leakage, verify summary sync to D1

**Checkpoint**: Per-project data isolation validated. Real-time WebSocket streaming functional.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, deployment, and quality

- [ ] T045 [P] Create ADR for hybrid D1+DO storage decision in `docs/adr/` — document rationale, alternatives, self-hosting implications (Constitution Principle XII)
- [ ] T046 [P] Update self-hosting guide in `docs/guides/self-hosting.md`: document new `PROJECT_DATA` DO namespace requirement, new env vars, Pulumi stack changes (Constitution Principle XII)
- [ ] T047 [P] Update `apps/api/.env.example` with all new env vars and descriptions
- [ ] T048 Run `pnpm lint && pnpm typecheck && pnpm test` from repo root — fix any failures
- [ ] T049 Deploy to staging and run Playwright E2E tests: create project, create workspace from project, send chat messages, stop workspace, verify session history persists, verify activity feed
- [ ] T050 Update `CLAUDE.md` and `AGENTS.md` with Durable Object patterns and new project structure references

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 — project navigation
- **US2 (Phase 4)**: Depends on Phase 2 — can run in parallel with US1
- **US3 (Phase 5)**: Depends on Phase 2 + US1 (needs project detail page for session list)
- **US4 (Phase 6)**: Depends on Phase 2 + US1 (needs project detail page for activity tab)
- **US5 (Phase 7)**: Depends on Phase 2 — can run in parallel with US1/US2
- **US6 (Phase 8)**: Depends on Phase 2 + US3 (needs chat persistence for WebSocket/sync testing)
- **Polish (Phase 9)**: Depends on all desired user stories being complete

### User Story Dependencies

```
Phase 1 (Setup)
    │
    ▼
Phase 2 (Foundational) ──── BLOCKS ALL ────┐
    │                                       │
    ├──→ Phase 3 (US1: Navigation) ◄────────┤
    │         │                             │
    │         ├──→ Phase 5 (US3: Chat) ─────┤
    │         │                             │
    │         └──→ Phase 6 (US4: Activity)  │
    │                                       │
    ├──→ Phase 4 (US2: Workspace binding)   │
    │                                       │
    ├──→ Phase 7 (US5: Stable identity)     │
    │                                       │
    └──→ Phase 8 (US6: Isolation) ──────────┘
                                            │
                                            ▼
                                    Phase 9 (Polish)
```

### Parallel Opportunities

Within Phase 2 (Foundational):
- T004 (shared types) + T006 (D1 migration) + T008 (DO migrations) can start in parallel
- T009 (DO class) depends on T008
- T012 (service layer) depends on T009 + T011

Within user stories:
- US1, US2, US5 can all proceed in parallel after Foundational
- Within US1: T016 + T017 (UI components) can run in parallel
- Within US3: T029 + T030 (UI components) can run in parallel
- Within US4: T035 (ActivityFeed component) can run in parallel with T034 (API route)

---

## Implementation Strategy

### MVP First (US1 + US2 + US3)

1. Complete Phase 1: Setup (3 tasks)
2. Complete Phase 2: Foundational (10 tasks)
3. Complete Phase 3: US1 — Project Navigation (6 tasks)
4. Complete Phase 4: US2 — Workspace Binding (5 tasks)
5. Complete Phase 5: US3 — Chat Persistence (8 tasks)
6. **STOP and VALIDATE**: Projects are primary navigation, workspaces require projects, chat history persists beyond workspace lifecycle
7. Deploy MVP

### Incremental Delivery

8. Add Phase 6: US4 — Activity Feed (4 tasks)
9. Add Phase 7: US5 — Stable Identity (4 tasks)
10. Add Phase 8: US6 — Isolation Validation (4 tasks)
11. Complete Phase 9: Polish (6 tasks)

### Suggested MVP Scope

**US1 + US2 + US3** — These three P1 stories deliver the core value proposition: project-first navigation with persistent chat history. US4–US6 are important but can ship incrementally after the MVP is validated.

---

## Notes

- Constitution Principle II requires >90% test coverage for critical paths (DO class, persistence pipeline)
- Constitution Principle XII requires Pulumi stack + self-hosting docs updated in same PR
- All configurable limits must have env var overrides (Principle XI)
- DO class is exported from the same Worker entry point — no separate deployment
- Task status events migration from D1 to DO is included in the foundational DO schema but the actual data migration (copying existing D1 task_status_events to DOs) is deferred to a follow-up task after the core feature is validated
