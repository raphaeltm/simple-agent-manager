# Tasks: Worktree Context Switching

**Input**: Design documents from `/specs/015-worktree-context/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: Shared types, constants, and configuration needed by all layers

- [x] T001 Add worktree shared types (`WorktreeInfo`, `WorktreeCreateRequest`, `WorktreeListResponse`, `WorktreeCreateResponse`, `WorktreeRemoveResponse`) in `packages/shared/src/types.ts`
- [x] T002 [P] Extend `AgentSession` type with optional `worktreePath` field and extend `CreateAgentSessionRequest` with optional `worktreePath` field in `packages/shared/src/types.ts`
- [x] T003 [P] Add `DEFAULT_MAX_WORKTREES_PER_WORKSPACE` constant in `packages/shared/src/constants.ts`
- [x] T004 Build shared package: `pnpm --filter @simple-agent-manager/shared build`

---

## Phase 2: Foundational — VM Agent Backend (Blocking Prerequisites)

**Purpose**: Worktree config, validation, and CRUD endpoints that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Add `MAX_WORKTREES_PER_WORKSPACE`, `WORKTREE_CACHE_TTL_SECONDS`, `WORKTREE_EXEC_TIMEOUT` env vars with `DEFAULT_*` fallbacks in `packages/vm-agent/internal/config/config.go`
- [x] T006 Create worktree porcelain parser — parse `git worktree list --porcelain` output into `[]WorktreeInfo` structs in `packages/vm-agent/internal/server/worktree_validation.go`
- [x] T007 Create worktree validation cache — per-workspace cache with configurable TTL, `ValidateWorktreePath()` function, cache invalidation on mutations in `packages/vm-agent/internal/server/worktree_validation.go`
- [x] T008 Create worktree directory name sanitizer — `<repo>-wt-<sanitized-branch>` naming with `/`→`-` replacement, truncation to 50 chars in `packages/vm-agent/internal/server/worktree_validation.go`
- [x] T009 [P] Add unit tests for porcelain parser, path validation, and directory name sanitizer in `packages/vm-agent/internal/server/worktree_validation_test.go`
- [x] T010 Create `GET /workspaces/:workspaceId/worktrees` handler — list worktrees using cached validation, execute via `docker exec`, return `WorktreeListResponse` in `packages/vm-agent/internal/server/worktrees.go`
- [x] T011 Create `POST /workspaces/:workspaceId/worktrees` handler — create worktree with branch validation, max count enforcement, directory naming, cache invalidation in `packages/vm-agent/internal/server/worktrees.go`
- [x] T012 Create `DELETE /workspaces/:workspaceId/worktrees` handler — remove worktree with primary protection, dirty check, force flag, stop bound sessions, cache invalidation in `packages/vm-agent/internal/server/worktrees.go`
- [x] T013 Register worktree CRUD routes in `packages/vm-agent/internal/server/server.go`
- [ ] T014 [P] Add unit tests for worktree CRUD handlers (mock docker exec) in `packages/vm-agent/tests/worktrees_test.go`

**Checkpoint**: Worktree CRUD endpoints functional — foundation ready for user story work

---

## Phase 3: User Story 1 — View and Switch Between Worktrees (Priority: P1) MVP

**Goal**: Users can see all worktrees in a selector, switch between them, and have the file browser and git viewer reflect the selected worktree's context

**Independent Test**: Open worktree selector, see all worktrees listed with branch names. Switch worktrees and verify file browser and git viewer update to reflect the new worktree. Reload page and verify selected worktree persists via URL param.

### VM Agent — Worktree param on existing endpoints

- [ ] T015 [US1] Add optional `worktree` query param to `GET /workspaces/:workspaceId/git/status` — validate path, pass as workDir to `docker exec -w` in `packages/vm-agent/internal/server/git.go`
- [ ] T016 [P] [US1] Add optional `worktree` query param to `GET /workspaces/:workspaceId/git/diff` in `packages/vm-agent/internal/server/git.go`
- [ ] T017 [P] [US1] Add optional `worktree` query param to `GET /workspaces/:workspaceId/git/file` in `packages/vm-agent/internal/server/git.go`
- [ ] T018 [P] [US1] Add optional `worktree` query param to `GET /workspaces/:workspaceId/files/list` — validate and use as root for find command in `packages/vm-agent/internal/server/files.go`
- [ ] T019 [P] [US1] Add optional `worktree` query param to `GET /workspaces/:workspaceId/files/find` in `packages/vm-agent/internal/server/files.go`
- [ ] T020 [P] [US1] Add unit tests for worktree query param handling on git and files endpoints in `packages/vm-agent/tests/worktree_endpoints_test.go`

### Frontend — API client and hook

- [ ] T021 [US1] Add `listWorktrees(workspaceUrl, workspaceId, token)` API client function in `apps/web/src/lib/api.ts`
- [ ] T022 [P] [US1] Add `createWorktree(workspaceUrl, workspaceId, token, request)` API client function in `apps/web/src/lib/api.ts`
- [ ] T023 [P] [US1] Add `removeWorktree(workspaceUrl, workspaceId, token, path, force)` API client function in `apps/web/src/lib/api.ts`
- [ ] T024 [US1] Create `useWorktrees` hook — fetch worktree list with refresh, active worktree from URL `?worktree=` param, create/remove actions, auto-select primary on load in `apps/web/src/hooks/useWorktrees.ts`
- [ ] T025 [US1] Create `WorktreeSelector` component — dropdown in workspace header showing all worktrees with branch names, primary marked distinctly, click to switch active worktree in `apps/web/src/components/WorktreeSelector.tsx`

### Frontend — Context propagation

- [ ] T026 [US1] Integrate `useWorktrees` hook and `WorktreeSelector` into workspace page, add `activeWorktreePath` state, update URL `?worktree=` param on switch in `apps/web/src/pages/Workspace.tsx`
- [ ] T027 [US1] Pass `worktree` prop to `FileBrowserPanel` — use worktree path in file list and file find API calls in `apps/web/src/components/FileBrowserPanel.tsx`
- [ ] T028 [P] [US1] Pass `worktree` prop to `GitChangesPanel` — use worktree path in git status API call in `apps/web/src/components/GitChangesPanel.tsx`
- [ ] T029 [P] [US1] Pass `worktree` prop to `GitDiffView` — use worktree path in git diff API call in `apps/web/src/components/GitDiffView.tsx`
- [ ] T030 [P] [US1] Pass `worktree` prop to `FileViewerPanel` — use worktree path in git file API call in `apps/web/src/components/FileViewerPanel.tsx`

### Tests

- [ ] T031 [P] [US1] Add unit tests for `useWorktrees` hook in `apps/web/tests/unit/useWorktrees.test.ts`
- [ ] T032 [P] [US1] Add unit tests for `WorktreeSelector` component rendering in `apps/web/tests/unit/WorktreeSelector.test.tsx`

**Checkpoint**: Users can view all worktrees, switch between them, and see file browser + git viewer update. URL state persists across reload. This is the MVP.

---

## Phase 4: User Story 2 — Create and Remove Worktrees (Priority: P1) MVP

**Goal**: Users can create new worktrees from existing or new branches, and remove worktrees with dirty-state warnings

**Independent Test**: Click "New worktree" in the selector, pick a branch, verify the worktree is created and appears in the selector. Remove a worktree and verify it disappears. Try removing a dirty worktree and verify the warning appears.

### Frontend — Create and remove UI

- [ ] T033 [US2] Create `WorktreeCreateDialog` component — branch picker for existing branches, "create new branch" toggle, base branch selector, loading state, error display in `apps/web/src/components/WorktreeCreateDialog.tsx`
- [ ] T034 [US2] Add "New worktree" action to `WorktreeSelector` that opens `WorktreeCreateDialog` in `apps/web/src/components/WorktreeSelector.tsx`
- [ ] T035 [US2] Add context menu to worktree entries in `WorktreeSelector` with "Remove" action — show dirty warning with file count, disable remove for primary worktree in `apps/web/src/components/WorktreeSelector.tsx`
- [ ] T036 [US2] Handle worktree removal of active worktree — auto-switch to primary worktree after removal in `apps/web/src/hooks/useWorktrees.ts`

### Tests

- [ ] T037 [P] [US2] Add unit tests for `WorktreeCreateDialog` component in `apps/web/tests/unit/WorktreeCreateDialog.test.tsx`
- [ ] T038 [P] [US2] Add unit tests for worktree removal flow (dirty warning, primary protection, auto-switch) in `apps/web/tests/unit/useWorktrees.test.ts`

**Checkpoint**: Users can create and remove worktrees. Combined with US1, this delivers the full P1 MVP.

---

## Phase 5: User Story 3 — Worktree-Scoped Terminals (Priority: P2)

**Goal**: New terminal sessions open in the active worktree's directory. Existing terminals keep their original CWD. Terminal tabs show which worktree they belong to.

**Independent Test**: Select a worktree, open a new terminal, run `pwd` and verify it shows the worktree path. Switch worktree, open another terminal, verify different CWD. Existing terminal tabs retain original worktree.

### VM Agent — Terminal worktree support

- [ ] T039 [US3] Add `CreateSessionWithWorkDir(sessionID, userID string, rows, cols int, workDir string)` method to PTY Manager that overrides default workDir in `packages/vm-agent/internal/pty/manager.go`
- [ ] T040 [US3] Extract optional `worktree` query param from terminal WebSocket URL, validate path, use as CWD for new PTY sessions on this connection in `packages/vm-agent/internal/server/websocket.go`
- [ ] T041 [P] [US3] Add unit tests for terminal worktree CWD behavior in `packages/vm-agent/tests/terminal_worktree_test.go`

### Frontend — Terminal worktree propagation

- [ ] T042 [US3] Pass active worktree path in terminal WebSocket URL as `?worktree=` query param when creating new terminal connections in `apps/web/src/components/MultiTerminal.tsx`

**Checkpoint**: New terminals open in the selected worktree's directory. Existing terminals unaffected.

---

## Phase 6: User Story 4 — Worktree-Scoped Agent Chat Sessions (Priority: P2)

**Goal**: New agent sessions are bound to the active worktree at creation time. The agent CWD is the worktree directory. Sessions retain their binding for their lifetime.

**Independent Test**: Select a worktree, create a new agent session, ask the agent to run `pwd` — verify it outputs the worktree path. Switch worktrees, create another session, verify different CWD. Reload page and verify sessions retain worktree association.

### Control Plane API — Persist worktree path

- [ ] T043 [US4] Create D1 migration to add `worktree_path TEXT` column to `agent_sessions` table in `apps/api/src/db/migrations/`
- [ ] T044 [US4] Update Drizzle schema to include `worktreePath` column on `agentSessions` table in `apps/api/src/db/schema.ts`
- [ ] T045 [US4] Accept `worktreePath` in `POST /api/workspaces/:id/agent-sessions` request body, store in D1, include in all agent session responses in `apps/api/src/routes/workspaces.ts`
- [ ] T046 [P] [US4] Add integration tests for agent session creation with worktree path (Miniflare) in `apps/api/tests/integration/agent-sessions-worktree.test.ts`

### VM Agent — Agent session worktree support

- [ ] T047 [US4] Extract optional `worktree` query param from agent WebSocket URL, validate path, pass as `ContainerWorkDir` in `GatewayConfig` for new SessionHosts in `packages/vm-agent/internal/server/agent_ws.go`
- [ ] T048 [US4] Add `worktree_path` column to VM Agent local SQLite `tabs` table migration in `packages/vm-agent/internal/acp/session_host.go`
- [ ] T049 [P] [US4] Add unit tests for agent session worktree CWD behavior in `packages/vm-agent/tests/agent_worktree_test.go`

### Frontend — Agent session worktree propagation

- [ ] T050 [US4] Pass active worktree path in agent session creation — include `worktreePath` in `POST /api/workspaces/:id/agent-sessions` body and `?worktree=` param on agent WebSocket URL in `apps/web/src/components/ChatSession.tsx`

**Checkpoint**: Agent sessions are worktree-scoped. CWD is correct, and worktree association persists across page reload.

---

## Phase 7: User Story 5 — Worktree-Aware File Browser and Git Viewer (Priority: P2)

**Goal**: File browser and git viewer are already scoped via US1 context propagation. This story covers edge cases: auto-refresh on worktree switch, clearing stale state.

**Independent Test**: Switch worktrees and verify the file browser resets to root of the new worktree. Verify git changes panel clears and re-fetches for the new worktree. Open a diff in one worktree, switch to another, verify the diff panel clears or refreshes.

### Frontend — Stale state handling

- [ ] T051 [US5] Reset file browser navigation state (path, breadcrumbs) to root when active worktree changes in `apps/web/src/components/FileBrowserPanel.tsx`
- [ ] T052 [P] [US5] Reset git changes panel state (clear cached status) and re-fetch when active worktree changes in `apps/web/src/components/GitChangesPanel.tsx`
- [ ] T053 [P] [US5] Close or refresh diff view when active worktree changes — prevent showing stale diff from previous worktree in `apps/web/src/components/GitDiffView.tsx`
- [ ] T054 [P] [US5] Close or reset file viewer when active worktree changes in `apps/web/src/components/FileViewerPanel.tsx`

### Tests

- [ ] T055 [P] [US5] Add unit tests for file browser and git viewer worktree switch behavior (stale state reset) in `apps/web/tests/unit/worktree-switch-reset.test.ts`

**Checkpoint**: File browser and git viewer correctly handle worktree switches without stale data.

---

## Phase 8: Tab Badging (Cross-Cutting — US3, US4)

**Purpose**: Show worktree association on terminal and chat tabs

- [ ] T056 Add worktree badge to terminal and chat tabs in `WorkspaceTabStrip` — derive short label from branch name, show badge for non-primary worktrees, no badge for primary in `apps/web/src/components/WorkspaceTabStrip.tsx`
- [ ] T057 Include worktree info in tab metadata — agent session tabs use `AgentSession.worktreePath`, terminal tabs use worktree path from connection metadata in `apps/web/src/pages/Workspace.tsx`
- [ ] T058 [P] Add unit tests for worktree badge rendering in WorkspaceTabStrip in `apps/web/tests/unit/WorkspaceTabStrip.test.tsx`

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, cleanup, and validation

- [ ] T059 [P] Update `CLAUDE.md` and `AGENTS.md` — add worktree env vars (`MAX_WORKTREES_PER_WORKSPACE`, `WORKTREE_CACHE_TTL_SECONDS`, `WORKTREE_EXEC_TIMEOUT`), new API endpoints, and recent changes entry
- [ ] T060 [P] Update `apps/api/.env.example` — add `MAX_WORKTREES_PER_WORKSPACE` with default value comment
- [ ] T061 [P] Run `pnpm typecheck` and `pnpm lint` across all packages and fix any issues
- [ ] T062 [P] Run `pnpm test` across all packages and fix any failures
- [ ] T063 Run quickstart.md validation — verify all phases were implemented per the quickstart guide
- [ ] T064 Mobile viewport visual verification — verify WorktreeSelector and WorktreeCreateDialog on 375px viewport via Playwright, save screenshots to `.codex/tmp/playwright-screenshots/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (shared types) — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 (CRUD endpoints + validation)
- **US2 (Phase 4)**: Depends on Phase 3 (selector component + useWorktrees hook)
- **US3 (Phase 5)**: Depends on Phase 2 (validation) — can run in parallel with US1/US2
- **US4 (Phase 6)**: Depends on Phase 2 (validation) — can run in parallel with US1/US2/US3
- **US5 (Phase 7)**: Depends on Phase 3 (context propagation from US1)
- **Tab Badging (Phase 8)**: Depends on US3 + US4 (terminal/agent worktree metadata)
- **Polish (Phase 9)**: Depends on all prior phases

### User Story Dependencies

- **US1 (View & Switch)**: Depends on Foundational only — no other story dependencies
- **US2 (Create & Remove)**: Depends on US1 (WorktreeSelector is extended, useWorktrees hook is extended)
- **US3 (Scoped Terminals)**: Depends on Foundational only — independent of US1/US2
- **US4 (Scoped Agent Chat)**: Depends on Foundational only — independent of US1/US2/US3
- **US5 (File Browser/Git)**: Depends on US1 (needs context propagation in place)

### Within Each User Story

- VM Agent changes before frontend changes (backend-first)
- Types/constants before implementation
- Core implementation before tests
- Tests verify the feature works independently

### Parallel Opportunities

**Phase 2 (Foundational)**:
- T009 (validation tests) can run in parallel with T010-T012 (CRUD handlers)
- T014 (CRUD tests) can run in parallel once handlers are written

**Phase 3 (US1)**:
- T015-T019 (worktree params on existing endpoints) can all run in parallel
- T027-T030 (frontend context propagation) can run in parallel after T026
- T031-T032 (tests) can run in parallel with other US1 work

**Cross-Story Parallelism**:
- US3 (terminals) and US4 (agent sessions) can be implemented in parallel
- US3 and US4 are independent of US1/US2 at the VM Agent layer

---

## Parallel Example: Phase 3 (US1)

```bash
# VM Agent — all endpoint modifications in parallel:
Task: "T015 Add worktree param to git/status in git.go"
Task: "T016 Add worktree param to git/diff in git.go"
Task: "T017 Add worktree param to git/file in git.go"
Task: "T018 Add worktree param to files/list in files.go"
Task: "T019 Add worktree param to files/find in files.go"

# Frontend — all context propagation in parallel (after T026):
Task: "T027 Pass worktree to FileBrowserPanel"
Task: "T028 Pass worktree to GitChangesPanel"
Task: "T029 Pass worktree to GitDiffView"
Task: "T030 Pass worktree to FileViewerPanel"
```

---

## Implementation Strategy

### MVP First (US1 + US2 — View, Switch, Create, Remove)

1. Complete Phase 1: Setup (shared types)
2. Complete Phase 2: Foundational (VM Agent CRUD + validation)
3. Complete Phase 3: US1 (view and switch worktrees)
4. Complete Phase 4: US2 (create and remove worktrees)
5. **STOP and VALIDATE**: Full worktree management works end-to-end
6. Deploy/demo MVP

### Incremental Delivery

1. Setup + Foundational → CRUD endpoints ready
2. US1 → View and switch worktrees → Deploy (basic context switching)
3. US2 → Create and remove → Deploy (full management MVP)
4. US3 → Scoped terminals → Deploy (parallel terminal work)
5. US4 → Scoped agent sessions → Deploy (parallel AI work)
6. US5 → File browser/git stale state handling → Deploy (polish)
7. Tab Badging → Visual worktree identification → Deploy (UX polish)
8. Polish → Documentation, tests, mobile verification → Final release

### Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently testable after its checkpoint
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
