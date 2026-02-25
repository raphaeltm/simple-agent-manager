# Tasks: Simplified Chat-First UX

**Input**: Design documents from `/specs/022-simplified-chat-ux/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story. US4 (Branch Naming) is merged into US1 (Chat) since the branch name service is consumed directly by the submit endpoint. Tests are included inline where critical paths require them (infrastructure stability, Principle II).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Shared types and schema definitions needed across multiple stories.

- [x] T001 Add `awaiting_followup` value to TaskExecutionStep type in packages/shared/src/types.ts (or wherever TaskExecutionStep is defined)
- [x] T002 [P] Add `finalizedAt` field to Task type and Drizzle schema `tasks` table in apps/api/src/db/schema.ts
- [x] T003 [P] Add `GitPushResult` type definition (pushed, commitSha, branchName, prUrl, prNumber, hasUncommittedChanges, error) in packages/shared/src/types.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database migration and Durable Object schema changes that MUST be complete before any user story implementation.

- [x] T004 Create D1 migration file `NNNN_add_finalized_at.sql` with `ALTER TABLE tasks ADD COLUMN finalized_at TEXT` in apps/api/src/db/migrations/
- [x] T005 [P] Add `agent_completed_at TEXT` column to chat_sessions table in ProjectData DO init SQL in apps/api/src/durable-objects/project-data.ts (auto-migration pattern: ALTER TABLE IF column not exists)
- [x] T006 [P] Create `idle_cleanup_schedule` table (session_id, workspace_id, task_id, cleanup_at, created_at) in ProjectData DO init SQL in apps/api/src/durable-objects/project-data.ts
- [x] T007 [P] Export enhanced ChatSessionResponse type with computed fields (isIdle, isTerminated, workspaceUrl, agentCompletedAt) from packages/shared/src/types.ts

**Checkpoint**: Foundation ready — all schema changes applied, shared types available. User story implementation can begin.

---

## Phase 3: User Story 1 — Chat With a Project + User Story 4 — Branch Naming (Priority: P1)

**Goal**: Users click a project and land in a chat interface. They type a message, hit enter, and the system creates a task with a human-readable branch name, provisions infrastructure, and starts an agent. Sessions show active/idle/terminated states. Follow-up messages go directly to the running agent.

**Independent Test**: Navigate to a project, type a task description, verify task is created with a descriptive branch name, infrastructure provisions, and messages start streaming. Switch between sessions and verify visual state indicators (green/amber/gray). Send a follow-up in an active session and verify it reaches the agent.

### Backend — API

- [x] T008 [P] [US1] Create branch name generation service with slugification algorithm (lowercase, strip special chars, filter stop words, take first 4 words, append 6-char task ID suffix, prefix with configurable BRANCH_NAME_PREFIX, truncate to BRANCH_NAME_MAX_LENGTH) in apps/api/src/services/branch-name.ts
- [x] T009 [P] [US1] Write unit tests for branch name generation (long messages, special chars, unicode, empty input, stop-word-only messages, max length truncation, valid git ref names) in apps/api/tests/unit/branch-name.test.ts
- [x] T010 [US1] Implement POST /api/projects/:projectId/tasks/submit endpoint per contracts/task-submit.md: validate request, generate branch name, insert task as queued, create chat session in DO, record first user message, kick off executeTaskRun via waitUntil, return 202 in apps/api/src/routes/task-submit.ts
- [ ] T010a [US1] Write integration tests for submit endpoint: valid submission creates task+session+message, missing credentials returns 403, invalid message returns 400, branch name appears in response in apps/api/tests/integration/task-submit.test.ts
- [x] T011 [US1] Register task-submit route in apps/api/src/routes/index.ts
- [x] T012 [US1] Enhance session list response with computed fields: derive isIdle (status=active AND agentCompletedAt!=null), isTerminated (status=stopped), workspaceUrl (from workspaceId + BASE_DOMAIN env var) in apps/api/src/durable-objects/project-data.ts
- [x] T013 [US1] Add task embed (id, status, executionStep, outputBranch, outputPrUrl, finalizedAt) to session detail response via D1 lookup in apps/api/src/routes/chat.ts (or project-data.ts RPC)

### Frontend — Chat-First Layout

- [x] T014 [US1] Restructure Project page: remove PROJECT_TABS array and Tabs component, replace with minimal header (project name, repo link, settings gear icon placeholder, breadcrumb) in apps/web/src/pages/Project.tsx
- [x] T015 [US1] Update routing so /projects/:id defaults to chat interface (remove /overview default, merge ProjectChat content into Project outlet or make chat the index route) in apps/web/src/App.tsx
- [x] T016 [US1] Add submitTask(projectId, message, options?) function to API client that calls POST /tasks/submit in apps/web/src/lib/api.ts

### Frontend — Chat Experience

- [x] T017 [US1] Simplify task input: replace TaskSubmitForm split-button with single text field, enter-to-submit, no visible "Save to Backlog" or advanced options by default in apps/web/src/pages/ProjectChat.tsx
- [x] T018 [US1] Update SessionSidebar with visual state indicators (green dot for active, amber for idle, gray for terminated) and ensure "New Chat" button is prominent at the top, clearing the message area and presenting a fresh input on click in apps/web/src/components/chat/SessionSidebar.tsx
- [x] T019 [US1] Handle session lifecycle states in ProjectMessageView: active shows input with "Send a message..." placeholder, idle shows input with "Send a follow-up..." placeholder, terminated disables input and shows "Start a new chat" button in apps/web/src/components/chat/ProjectMessageView.tsx
- [x] T020 [US1] Implement direct WebSocket connection to VM agent (wss://ws-{workspaceId}.{BASE_DOMAIN}/acp/{sessionId}) for active/idle sessions; user messages sent via WebSocket not HTTP; preserve existing cancel/pause button from ACP chat protocol so users can interrupt agent execution in apps/web/src/components/chat/ProjectMessageView.tsx
- [x] T021 [US1] Display branch name and PR link in session header area when task has outputBranch/outputPrUrl (clickable link to GitHub) in apps/web/src/components/chat/ProjectMessageView.tsx
- [x] T022 [US1] Show inline non-technical provisioning progress (spinner + "Setting up...") in chat area while task is queued/delegated, replacing TaskExecutionProgress banner with a more integrated chat-native indicator in apps/web/src/pages/ProjectChat.tsx

**Checkpoint**: Users can navigate to a project, see a chat interface, submit tasks via single message, see descriptive branch names, view session states, and send follow-ups to active sessions via WebSocket.

---

## Phase 4: User Story 2 — Simplified Dashboard (Priority: P1)

**Goal**: Dashboard shows only project cards. Click project goes directly to chat. No workspace cards, node lists, or onboarding checklist clutter.

**Independent Test**: Log in, verify dashboard shows project cards with name/repo/last activity. Click a project card and verify it navigates to /projects/:id (chat interface). Verify no workspace or node elements are visible.

- [x] T023 [P] [US2] Remove workspace cards, unlinked workspaces section, and node-related elements from Dashboard in apps/web/src/pages/Dashboard.tsx
- [x] T024 [P] [US2] Update project card click handler to navigate to /projects/:id (chat) instead of /projects/:id/overview in apps/web/src/pages/Dashboard.tsx
- [x] T025 [US2] Simplify empty state: replace onboarding checklist with a clean "Import your first project" call-to-action with prominent Import Project button in apps/web/src/pages/Dashboard.tsx

**Checkpoint**: Dashboard is clean and project-focused. Users go from login to chat in two clicks.

---

## Phase 5: User Story 6 — Reliable GitHub Credentials (Priority: P1)

**Goal**: gh CLI works in all workspaces (including custom devcontainers), tokens refresh automatically for sessions > 1 hour, git identity has a noreply fallback, and the agent pushes changes before session ends.

**Independent Test**: Start a workspace with a custom devcontainer, verify `gh --version` works. Wait > 1 hour in a session, verify `gh pr create` succeeds. Start a workspace for a user with no public email, verify `git commit` works. Let an agent finish work, verify changes are committed and pushed.

- [x] T026 [P] [US6] Implement ensureGitHubCLI() function: run `docker exec <container> which gh` after devcontainer build, if not found install via official install script for detected OS in packages/vm-agent/internal/bootstrap/bootstrap.go
- [x] T027 [P] [US6] Implement gh wrapper script installation in ensureGitCredentialHelper: move existing gh to gh.real, install wrapper that sets GH_TOKEN via git credential fill before exec gh.real in packages/vm-agent/internal/bootstrap/bootstrap.go
- [x] T028 [US6] Add githubId field to CreateWorkspaceRequest payload (API side: include in workspace creation call; VM agent side: read and pass to bootstrap) in apps/api/src/services/task-runner.ts and packages/vm-agent/internal/ types
- [x] T029 [US6] Add git identity noreply email fallback: when gitUserEmail is empty, use {githubId}+{sanitized-name}@users.noreply.github.com in ensureGitIdentity in packages/vm-agent/internal/bootstrap/bootstrap.go
- [x] T029a [US6] Enhance task status callback to accept executionStep field: when executionStep='awaiting_followup', update task executionStep without changing status and save gitPushResult outputs on the task record. This MUST be deployed before T030 so the API can handle the new callback payload. in apps/api/src/routes/tasks.ts
- [x] T030 [US6] Implement agent completion git push flow: on ACP session end, run git status --porcelain, if changes exist git add/commit/push, optionally create PR via gh, then POST callback with executionStep=awaiting_followup and gitPushResult — do NOT stop the container in packages/vm-agent/internal/acp/ (session handler)

**Checkpoint**: GitHub credentials are reliable across all workspace types. Agent pushes changes on completion. Git identity always configured. API accepts the new callback payload.

---

## Phase 6: User Story 5 — Idle Auto-Push Safety Net (Priority: P2)

**Goal**: After the agent finishes and no user follow-up for 15 minutes, the system auto-cleans up the workspace. The idle timer resets if the user sends a follow-up. The finalization guard prevents duplicate git push/PR operations.

**Independent Test**: Start a task, let the agent complete, verify idle timer starts (session shows amber/idle). Send a follow-up before 15 min, verify timer resets. Wait 15 min without responding, verify workspace is cleaned up and session becomes terminated/gray.

### Backend — Idle Timer

- [x] T031 [US5] Implement scheduleIdleCleanup(sessionId, workspaceId, taskId) method in ProjectData DO: insert into idle_cleanup_schedule, find MIN(cleanup_at), set DO alarm in apps/api/src/durable-objects/project-data.ts
- [x] T032 [US5] Implement cancelIdleCleanup(sessionId) and resetIdleCleanup(sessionId) methods in ProjectData DO: delete/update schedule rows, recalculate alarm in apps/api/src/durable-objects/project-data.ts
- [x] T033 [US5] Implement alarm() handler in ProjectData DO: find expired cleanup rows, check task.finalizedAt — if null retry git push via VM agent before cleanup, then trigger workspace cleanup (task → completed, session → stopped, cleanupTaskRun), retry on failure with IDLE_CLEANUP_RETRY_DELAY_MS, notify user via system message if push fails after retry in apps/api/src/durable-objects/project-data.ts
- [ ] T033a [US5] Write integration tests for idle cleanup alarm lifecycle: schedule fires at correct time, reset extends deadline, cancel removes schedule, concurrent sessions use earliest-alarm pattern, failed cleanup retries in apps/api/tests/integration/idle-cleanup.test.ts

### Backend — Enhanced Callback

- [x] T034 [US5] Extend the awaiting_followup callback handler (from T029a) to signal ProjectData DO to start idle cleanup timer: set agent_completed_at on chat session, call scheduleIdleCleanup, record 'task.agent_completed' activity event in apps/api/src/routes/tasks.ts
- [ ] T034a [P] [US5] Write unit tests for finalization guard: verify finalizedAt set only once, verify skip when already finalized, verify set when gitPushResult.pushed=true in apps/api/tests/unit/finalization-guard.test.ts
- [ ] T034b [US5] Write integration tests for enhanced callback: awaiting_followup keeps task in running status, starts idle timer in DO, backward-compatible toStatus:completed still works in apps/api/tests/integration/task-callback.test.ts
- [x] T035 [US5] Implement finalization guard in callback handler: check task.finalizedAt IS NULL before saving git push results, set finalizedAt=now if gitPushResult.pushed is true in apps/api/src/routes/tasks.ts

### Backend — Idle Reset

- [x] T036 [US5] Implement POST /api/projects/:projectId/sessions/:sessionId/idle-reset endpoint: validate auth, call DO resetIdleCleanup, return new cleanup timestamp in apps/api/src/routes/chat.ts

### Frontend — Idle Integration

- [x] T037 [US5] Add resetIdle(projectId, sessionId) API function in apps/web/src/lib/api.ts and call it from ProjectMessageView when user sends a follow-up message in an idle session in apps/web/src/components/chat/ProjectMessageView.tsx

**Checkpoint**: Idle safety net is active. Agent work is preserved via auto-push. Follow-ups reset the timer. Finalization is idempotent.

---

## Phase 7: User Story 3 — Project Settings as Drawer (Priority: P2)

**Goal**: Settings accessible via gear icon in project header, opening a slide-over drawer. No separate settings page/tab.

**Independent Test**: Click gear icon on project chat page, verify drawer slides in with node size, env vars, runtime files settings. Change a setting, save, close drawer. Reopen and verify persistence. Attempt to close with unsaved changes, verify confirmation prompt.

- [x] T038 [P] [US3] Create SettingsDrawer component: extract default node size selector, env vars editor, and runtime files editor from existing ProjectSettings page content into a slide-over panel component in apps/web/src/components/project/SettingsDrawer.tsx
- [x] T039 [US3] Integrate SettingsDrawer into Project page: wire gear icon in header to open/close drawer, pass project context in apps/web/src/pages/Project.tsx
- [x] T040 [US3] Add unsaved changes confirmation: track dirty state, prompt save/discard on close or click-outside in apps/web/src/components/project/SettingsDrawer.tsx

**Checkpoint**: Settings are accessible in-context without leaving the chat page.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Clean up old navigation, ensure type safety, verify no regressions.

- [x] T041 Hide old project tab routes from navigation: keep route handlers in App.tsx for direct URL access but remove tab UI and default redirects to old tabs in apps/web/src/App.tsx
- [x] T042 [P] Update CLAUDE.md Recent Changes section with 022-simplified-chat-ux feature summary in CLAUDE.md
- [x] T043 [P] Run pnpm typecheck across all packages and fix any type errors introduced by the changes
- [x] T044 Run pnpm test and pnpm lint across all packages and fix any regressions

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup) ──────────────────────────┐
                                           ▼
Phase 2 (Foundational) ──────────────┬─────┤
                                     │     │
              ┌──────────────────────┼─────┼──────────────────┐
              ▼                      ▼     ▼                  ▼
Phase 3 (US1+US4)    Phase 4 (US2)  Phase 5 (US6)   Phase 7 (US3)
  Chat + Branches      Dashboard     GH Credentials    Settings
              │                      │
              ▼                      ▼
         Phase 6 (US5)
         Idle Auto-Push
              │
              ▼
         Phase 8 (Polish)
```

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1+US4 (Phase 3)**: Depends on Phase 2 — core chat experience
- **US2 (Phase 4)**: Depends on Phase 2 — can run parallel with Phase 3
- **US6 (Phase 5)**: Depends on Phase 2 (for types) — can run parallel with Phases 3-4 (separate package: vm-agent)
- **US5 (Phase 6)**: Depends on Phase 3 (submit endpoint, session responses) and Phase 5 (agent completion callback) — the idle timer operates on sessions created by the submit flow
- **US3 (Phase 7)**: Depends on Phase 3 (project page restructure) — needs the new header layout
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1+US4 (P1)**: After Foundational — no dependency on other stories
- **US2 (P1)**: After Foundational — independent of all other stories
- **US6 (P1)**: After Foundational — independent (VM agent only, separate package)
- **US5 (P2)**: After US1 + US6 — needs submit flow (US1) and the callback handler base (T029a in US6)
- **US3 (P2)**: After US1 — needs the restructured project page header from Phase 3

### Within Each User Story

- Backend tasks before frontend tasks (APIs must exist before UI can consume them)
- Types/models before services before endpoints
- Core flow before enhancements (e.g., submit before WebSocket, sidebar before session header)

### Parallel Opportunities

**Cross-phase parallelism** (different packages/layers):
- Phases 3, 4, 5 can all run in parallel after Phase 2 (API, Web, VM Agent respectively)
- Phase 7 can run in parallel with Phase 6

**Within-phase parallelism** (marked [P]):
- Phase 1: T002, T003 parallel
- Phase 2: T005, T006, T007 parallel
- Phase 3: T008, T009 parallel (branch name service + tests); T014, T015 parallel (page restructure + routing)
- Phase 4: T023, T024 parallel
- Phase 5: T026, T027 parallel (different bootstrap functions)
- Phase 8: T042, T043 parallel

---

## Parallel Example: Phase 3 (US1+US4)

```text
# Backend — run these in parallel:
Task T008: "Create branch name generation service in apps/api/src/services/branch-name.ts"
Task T009: "Write unit tests for branch name generation in apps/api/tests/unit/branch-name.test.ts"

# After T008 completes — submit endpoint needs the service:
Task T010: "Implement POST /tasks/submit endpoint in apps/api/src/routes/task-submit.ts"

# After T010 — session enhancements and route registration:
Task T011: "Register submit route in apps/api/src/routes/index.ts"
Task T012: "Enhance session responses in project-data.ts"

# Frontend — can start once backend APIs exist (T010-T012):
Task T014: "Restructure project page in Project.tsx"
Task T015: "Update routing in App.tsx"
Task T016: "Add submitTask() to api.ts"

# After layout is done:
Task T017: "Simplify chat input in ProjectChat.tsx"
Task T018: "Session sidebar visual states in SessionSidebar.tsx"
Task T019: "Session lifecycle in ProjectMessageView.tsx"
Task T020: "WebSocket connection in ProjectMessageView.tsx"
```

---

## Implementation Strategy

### MVP First (US1 + US2 Only)

1. Complete Phase 1: Setup (types)
2. Complete Phase 2: Foundational (migration, DO schema)
3. Complete Phase 3: US1+US4 — Chat interface with branch naming
4. Complete Phase 4: US2 — Dashboard simplification
5. **STOP AND VALIDATE**: Full chat flow works end-to-end, dashboard is clean
6. Deploy to staging for user testing

This delivers the core value proposition: "click project → chat → agent works."

### Full Delivery (All Stories)

1. MVP (above)
2. Phase 5: US6 — GitHub credential reliability (can start during MVP validation)
3. Phase 6: US5 — Idle auto-push safety net
4. Phase 7: US3 — Settings drawer
5. Phase 8: Polish
6. Deploy to production

### Parallel Team Strategy

With 3 developers after Foundational:
- **Dev A**: Phase 3 (US1+US4) — API + frontend chat
- **Dev B**: Phase 5 (US6) — VM agent Go changes
- **Dev C**: Phase 4 (US2) → Phase 7 (US3) — Frontend simplification

After Phase 3+5 complete:
- **Dev A**: Phase 6 (US5) — Idle timer (needs both API and agent)
- **Dev B+C**: Phase 8 (Polish)

---

## Notes

- US4 (Branch Naming) is merged into US1 because the branch name service is consumed by the submit endpoint — they share the same implementation path
- The existing 3-call task creation flow (POST /tasks → status → run) is preserved for programmatic/advanced use. The submit endpoint is the chat UI's simplified path
- Old tab routes are kept in the router for direct URL access but hidden from project navigation (Phase 8, T041)
- The callback handler base (T029a in Phase 5) MUST be deployed before the VM agent sends `awaiting_followup` (T030). Phase 6 (T034) then extends the handler to start idle timers. The existing `toStatus: 'completed'` callback path remains available as fallback
- Commit after each task or logical group. Push after each phase checkpoint.
