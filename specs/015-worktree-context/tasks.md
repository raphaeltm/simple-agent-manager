# Tasks: Worktree Context Switching

**Input**: Design documents from `/specs/015-worktree-context/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: Tests are included per project constitution (Principle II: Infrastructure Stability) — TDD required for critical paths.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **VM Agent (Go)**: `packages/vm-agent/internal/`
- **Control Plane API**: `apps/api/src/`
- **Web UI**: `apps/web/src/`
- **Shared Types**: `packages/shared/src/`
- **Terminal Package**: `packages/terminal/src/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Shared types, configuration, and database migration that all user stories depend on

- [x] T001 Add `WorktreeInfo`, `CreateWorktreeRequest`, `WorktreeListResponse`, `RemoveWorktreeResponse` types to `packages/shared/src/types.ts`
- [x] T002 Add `worktreePath` field to `AgentSession` and `CreateAgentSessionRequest` interfaces in `packages/shared/src/types.ts`
- [x] T003 [P] Add `MAX_WORKTREES_PER_WORKSPACE`, `WORKTREE_CACHE_TTL`, and `GIT_WORKTREE_TIMEOUT` env vars to `packages/vm-agent/internal/config/config.go`
- [x] T004 [P] Create D1 migration `apps/api/src/db/migrations/0010_agent_sessions_worktree_path.sql` adding `worktree_path TEXT` column to `agent_sessions`
- [x] T005 [P] Add `worktreePath: text('worktree_path')` to `agentSessions` table in `apps/api/src/db/schema.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: VM Agent worktree CRUD endpoints and path validation that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T006 Implement `parseWorktreeList()` function to parse `git worktree list --porcelain` output into `[]WorktreeInfo` structs in `packages/vm-agent/internal/server/worktrees.go`
- [x] T007 Implement `validateWorktreePath()` helper that cross-references a client-supplied path against `git worktree list` output with caching per `WORKTREE_CACHE_TTL` in `packages/vm-agent/internal/server/worktrees.go`
- [x] T008 Implement `sanitizeBranchToDirectoryName()` helper that converts branch names (e.g., `feature/auth`) to valid directory names (e.g., `feature-auth`) in `packages/vm-agent/internal/server/worktrees.go`
- [x] T009 Implement `resolveWorktreeWorkDir()` helper that extracts optional `worktree` query param, validates it via `validateWorktreePath()`, and returns the effective workDir (falling back to `ContainerWorkDir`) in `packages/vm-agent/internal/server/worktrees.go`
- [x] T010 Write unit tests for `parseWorktreeList()`, `validateWorktreePath()`, `sanitizeBranchToDirectoryName()`, and `resolveWorktreeWorkDir()` in `packages/vm-agent/internal/server/worktrees_test.go`
- [x] T011 Implement `handleListWorktrees` handler for `GET /workspaces/{workspaceId}/worktrees` that runs `git worktree list --porcelain` and `git status --porcelain` per worktree in `packages/vm-agent/internal/server/worktrees.go`
- [x] T012 Implement `handleCreateWorktree` handler for `POST /workspaces/{workspaceId}/worktrees` with branch validation, max worktree check, duplicate branch check, and `git worktree add` in `packages/vm-agent/internal/server/worktrees.go`
- [x] T013 Implement `handleRemoveWorktree` handler for `DELETE /workspaces/{workspaceId}/worktrees` with primary protection, dirty check, force option, agent session cleanup, and `git worktree remove` in `packages/vm-agent/internal/server/worktrees.go`
- [x] T014 Register worktree routes (`GET/POST/DELETE /workspaces/{workspaceId}/worktrees`) in `packages/vm-agent/internal/server/server.go` `setupRoutes()`
- [ ] T015 Write unit tests for `handleListWorktrees`, `handleCreateWorktree`, `handleRemoveWorktree` handlers covering success paths, validation errors (409 branch conflict, 422 max exceeded, 400 invalid branch, 400 primary removal), and force removal in `packages/vm-agent/internal/server/worktrees_test.go`

**Checkpoint**: Worktree CRUD endpoints functional. All downstream stories can now begin.

---

## Phase 3: User Story 1 — View and Switch Between Worktrees (Priority: P1) MVP

**Goal**: Worktree selector in workspace header with instant context switching. File browser and git viewer re-scope to the active worktree.

**Independent Test**: Open worktree selector, see primary worktree listed. Create worktrees via US2 (or manually via terminal). Switch between worktrees and verify file browser and git viewer show different content.

### Implementation for User Story 1

- [x] T016 [P] [US1] Add `getWorktrees(workspaceUrl, workspaceId, token)` function to `apps/web/src/lib/api.ts` calling `GET /workspaces/{id}/worktrees?token=...`
- [x] T017 [P] [US1] Add optional `worktree` parameter to `getGitStatus()`, `getGitDiff()`, `getGitFile()`, `getFileList()`, `getFileIndex()` functions in `apps/web/src/lib/api.ts`
- [x] T018 [US1] Add `worktree` query param support to `handleGitStatus`, `handleGitDiff`, `handleGitFile` handlers using `resolveWorktreeWorkDir()` in `packages/vm-agent/internal/server/git.go`
- [x] T019 [US1] Add `worktree` query param support to `handleFileList`, `handleFileFind` handlers using `resolveWorktreeWorkDir()` in `packages/vm-agent/internal/server/files.go`
- [x] T020 [US1] Write unit tests for worktree param parsing and workDir override in git and file handlers in `packages/vm-agent/internal/server/git_test.go` and `packages/vm-agent/internal/server/files_test.go`
- [x] T021 [US1] Create `WorktreeSelector` component in `apps/web/src/components/WorktreeSelector.tsx` — dropdown listing worktrees by branch name, primary distinguished with badge, mobile-responsive with 56px touch targets
- [x] T022 [US1] Add `worktrees`, `activeWorktree` state and `?worktree=` URL search param to `apps/web/src/pages/Workspace.tsx` — fetch worktree list on mount, restore active worktree from URL on reload
- [x] T023 [US1] Integrate `WorktreeSelector` into workspace header in `apps/web/src/pages/Workspace.tsx` — show when workspace is running, wire `onSelect` to update `activeWorktree` state and URL param
- [x] T024 [US1] Pass `activeWorktree` as `worktree` prop to `FileBrowserPanel` in `apps/web/src/pages/Workspace.tsx` and thread it through to `getFileList()` / `getFileIndex()` calls in `apps/web/src/components/FileBrowserPanel.tsx`
- [x] T025 [US1] Pass `activeWorktree` as `worktree` prop to `GitChangesPanel` and `GitDiffView` in `apps/web/src/pages/Workspace.tsx` and thread it through to `getGitStatus()` / `getGitDiff()` / `getGitFile()` calls in `apps/web/src/components/GitChangesPanel.tsx` and `apps/web/src/components/GitDiffView.tsx`
- [x] T026 [US1] Close or refresh git panel / file browser when active worktree changes to prevent stale data display in `apps/web/src/pages/Workspace.tsx`
- [x] T027 [US1] Write unit tests for `WorktreeSelector` component (render with worktrees, select callback, primary badge) in `apps/web/src/components/__tests__/WorktreeSelector.test.tsx`
- [x] T028 [US1] Write unit tests for worktree URL param persistence and restoration in `apps/web/src/pages/__tests__/Workspace.test.tsx`

**Checkpoint**: Users can see worktrees in a selector, switch between them, and the file browser + git viewer re-scope instantly. URL param survives reload.

---

## Phase 4: User Story 2 — Create and Remove Worktrees (Priority: P1) MVP

**Goal**: Users can create new worktrees from the selector (existing or new branch) and remove them with dirty-state warnings.

**Independent Test**: Click "New worktree" in selector, pick a branch, verify it appears. Try creating a duplicate (should error). Remove a worktree, verify it disappears. Remove a dirty worktree with force confirmation.

### Implementation for User Story 2

- [x] T029 [P] [US2] Add `createWorktree(workspaceUrl, workspaceId, token, request)` and `removeWorktree(workspaceUrl, workspaceId, token, path, force)` functions to `apps/web/src/lib/api.ts`
- [x] T030 [US2] Add "New worktree" action to `WorktreeSelector` in `apps/web/src/components/WorktreeSelector.tsx` — inline form or modal with branch name input, create-branch toggle, loading state, error display (409 duplicate, 422 max exceeded)
- [x] T031 [US2] Add "Remove" context action to each non-primary worktree entry in `WorktreeSelector` in `apps/web/src/components/WorktreeSelector.tsx` — confirmation dialog showing dirty file count when `isDirty`, force option, auto-switch to primary if active worktree removed
- [x] T032 [US2] Wire create/remove actions in `apps/web/src/pages/Workspace.tsx` — call API, refresh worktree list on success, update `activeWorktree` if removed worktree was active
- [x] T033 [US2] Disable or hide remove option for the primary worktree in `WorktreeSelector` in `apps/web/src/components/WorktreeSelector.tsx`
- [x] T034 [US2] Write unit tests for create worktree form (branch input, validation, error states) and remove worktree dialog (dirty warning, force confirmation, primary protection) in `apps/web/src/components/__tests__/WorktreeSelector.test.tsx`

**Checkpoint**: Full worktree lifecycle — create, switch, remove — works end-to-end from the UI. Users can manage parallel branch checkouts.

---

## Phase 5: User Story 5 — Worktree-Aware File Browser and Git Viewer (Priority: P2)

**Goal**: File browser and git viewer fully scoped to the active worktree. This is largely delivered by US1; this phase handles edge cases and polish.

**Independent Test**: Switch worktrees while file browser is open — verify file listing changes. Switch while viewing a git diff — verify panel refreshes or closes. Verify no stale data from previous worktree leaks through.

**Note**: US5 is sequenced before US3/US4 because it completes the read-only experience started by US1 with minimal additional work.

### Implementation for User Story 5

- [x] T035 [US5] Reset file browser `currentPath` to root (`.`) when active worktree changes in `apps/web/src/components/FileBrowserPanel.tsx`
- [x] T036 [US5] Clear `filesParam` and `gitParam` URL search params when active worktree changes if they reference stale context in `apps/web/src/pages/Workspace.tsx`
- [x] T037 [US5] Invalidate and re-fetch command palette file index (`paletteFileIndex`) when active worktree changes in `apps/web/src/pages/Workspace.tsx`
- [x] T038 [US5] Write tests verifying file browser resets and git panel refreshes on worktree switch in `apps/web/src/pages/__tests__/Workspace.test.tsx`

**Checkpoint**: File browser and git viewer are fully worktree-scoped with no stale data leakage on switch.

---

## Phase 6: User Story 3 — Worktree-Scoped Terminals (Priority: P2)

**Goal**: New terminals open in the active worktree's directory. Tab strip shows worktree badge per terminal.

**Independent Test**: Select a non-primary worktree, create a new terminal, run `pwd` — verify CWD matches the worktree. Switch worktree, verify existing terminal keeps its CWD. Check tab badges.

### Implementation for User Story 3

- [x] T039 [P] [US3] Add optional `workDir` field to `create_session` message in `packages/terminal/src/protocol.ts` — update `encodeTerminalWsCreateSession()` to accept and include `workDir`
- [x] T040 [P] [US3] Add `WorkDir string` field to `wsCreateSessionData` struct in `packages/vm-agent/internal/server/websocket.go`
- [x] T041 [US3] Add `workDir` parameter to `pty.Manager.CreateSessionWithID()` in `packages/vm-agent/internal/pty/manager.go` — use provided workDir if non-empty, fall back to manager default
- [x] T042 [US3] Thread `workDir` from `wsCreateSessionData` through `CreateSessionWithID()` call in `handleMultiTerminalWS` `create_session` handler, with worktree path validation via `resolveWorktreeWorkDir()`, in `packages/vm-agent/internal/server/websocket.go`
- [x] T043 [US3] Write unit tests for `CreateSessionWithID()` with custom workDir override and default fallback in `packages/vm-agent/internal/pty/manager_test.go`
- [x] T044 [US3] Add `defaultWorkDir` prop to `MultiTerminal` component in `packages/terminal/src/MultiTerminal.tsx` — pass to `encodeTerminalWsCreateSession()` when creating new sessions
- [x] T045 [US3] Pass `activeWorktree` path as `defaultWorkDir` to `MultiTerminal` in `apps/web/src/pages/Workspace.tsx`
- [x] T046 [US3] Add worktree badge to terminal tabs in `WorkspaceTabStrip` in `apps/web/src/components/WorkspaceTabStrip.tsx` — derive short branch name from `workingDirectory` on `MultiTerminalSessionSnapshot`, show as small label on tab
- [x] T047 [US3] Write unit tests for terminal tab worktree badge rendering in `apps/web/src/components/__tests__/WorkspaceTabStrip.test.tsx`

**Checkpoint**: Terminals open in the correct worktree directory. Tab badges clearly indicate which worktree each terminal belongs to.

---

## Phase 7: User Story 4 — Worktree-Scoped Agent Chat Sessions (Priority: P2)

**Goal**: New agent sessions bound to the active worktree. Tab badges show worktree. Sessions persist worktree binding across reload. Removing a worktree stops its bound sessions.

**Independent Test**: Select a worktree, create a chat session, ask the agent to run `pwd` — verify CWD matches. Reload page — verify session retains worktree badge. Remove the worktree — verify session stops.

### Implementation for User Story 4

- [x] T048 [P] [US4] Accept `worktreePath` in `POST /api/workspaces/:id/agent-sessions` request body, store in `agent_sessions.worktree_path` column, in `apps/api/src/routes/workspaces.ts`
- [x] T049 [P] [US4] Include `worktreePath` in agent session list and detail responses (`toAgentSessionResponse()` helper) in `apps/api/src/routes/workspaces.ts`
- [x] T050 [US4] Write integration tests for creating and listing agent sessions with `worktreePath` in `apps/api/tests/integration/`
- [x] T051 [US4] Extract `worktree` query param from agent WebSocket URL in `handleAgentWS`, validate via `resolveWorktreeWorkDir()`, and pass as `ContainerWorkDir` in `GatewayConfig` to `getOrCreateSessionHost()` in `packages/vm-agent/internal/server/agent_ws.go`
- [x] T052 [US4] Write unit tests for agent WS worktree param extraction and validation in `packages/vm-agent/internal/server/agent_ws_test.go`
- [x] T053 [US4] Pass `activeWorktree` as `worktreePath` when calling `createAgentSession()` in `apps/web/src/pages/Workspace.tsx`
- [x] T054 [US4] Append `&worktree=<path>` to agent WebSocket URL in `ChatSession` when session has a `worktreePath` in `apps/web/src/components/ChatSession.tsx`
- [x] T055 [US4] Add worktree badge to chat session tabs in `WorkspaceTabStrip` — derive branch name from `agentSession.worktreePath` in `apps/web/src/components/WorkspaceTabStrip.tsx`
- [x] T056 [US4] When a worktree is removed via `handleRemoveWorktree`, stop agent sessions bound to that worktree by iterating in-memory session hosts and calling `Stop()` in `packages/vm-agent/internal/server/worktrees.go`
- [x] T057 [US4] Write unit tests for chat tab worktree badge rendering and agent session worktree binding persistence in `apps/web/src/components/__tests__/WorkspaceTabStrip.test.tsx` and `apps/web/src/pages/__tests__/Workspace.test.tsx`

**Checkpoint**: Agent sessions are worktree-scoped with persistent binding. Tab badges show worktree. Removing a worktree cleans up bound sessions.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, edge cases, and final quality checks

- [x] T058 [P] Add `MAX_WORKTREES_PER_WORKSPACE`, `WORKTREE_CACHE_TTL`, `GIT_WORKTREE_TIMEOUT` to environment variables documentation in `CLAUDE.md` and `AGENTS.md`
- [x] T059 [P] Add worktree endpoints (`GET/POST/DELETE /workspaces/:id/worktrees`) and modified endpoint params to API Endpoints section in `CLAUDE.md` and `AGENTS.md`
- [x] T060 [P] Add `worktree-context` to Recent Changes section in `CLAUDE.md` and `AGENTS.md`
- [x] T061 Handle detached HEAD worktrees in `WorktreeSelector` — show commit hash instead of branch name when `branch` is empty or a raw hash in `apps/web/src/components/WorktreeSelector.tsx`
- [x] T062 Handle stale/prunable worktrees in `handleListWorktrees` — detect prunable flag from `git worktree list --porcelain` output and surface in `WorktreeInfo` response in `packages/vm-agent/internal/server/worktrees.go`
- [x] T063 Add worktree switcher to command palette — register a "Switch Worktree" action in the shortcut registry that opens the worktree selector in `apps/web/src/pages/Workspace.tsx`
- [x] T064 Run full test suites (`pnpm test`, Go tests) and verify all pass
- [x] T065 Run typecheck (`pnpm typecheck`) and lint (`pnpm lint`) across all packages and fix any issues
- [x] T066 Build all packages (`pnpm build`) and verify no build errors

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (shared types and config)
- **US1 (Phase 3)**: Depends on Phase 2 (worktree CRUD + validation endpoints)
- **US2 (Phase 4)**: Depends on Phase 2 (worktree CRUD endpoints) + US1 (WorktreeSelector component exists)
- **US5 (Phase 5)**: Depends on US1 (worktree prop threading in place)
- **US3 (Phase 6)**: Depends on Phase 2 (worktree path validation) — can run in parallel with US1/US2
- **US4 (Phase 7)**: Depends on Phase 1 (D1 migration + schema) + Phase 2 (worktree path validation) — can run in parallel with US3
- **Polish (Phase 8)**: Depends on all user story phases complete

### User Story Dependencies

```
Phase 1: Setup ──────────────────────────┐
                                          ▼
Phase 2: Foundational ───┬──────────────────────────────────────┐
                          │                                      │
                          ▼                                      ▼
Phase 3: US1 (View/Switch) ──┬──▶ Phase 4: US2 (Create/Remove)  │
                              │                                   │
                              ▼                                   │
                    Phase 5: US5 (File/Git Polish)                │
                                                                  │
                    Phase 6: US3 (Terminals) ◀────────────────────┤
                                                                  │
                    Phase 7: US4 (Agent Sessions) ◀───────────────┘
                              │
                              ▼
                    Phase 8: Polish
```

### Within Each User Story

- Tests MUST be written and FAIL before implementation (TDD for VM Agent critical paths)
- Shared types/config before endpoint handlers
- Backend handlers before frontend components
- Core implementation before integration wiring
- Story complete before moving to next priority

### Parallel Opportunities

**Phase 1** (all tasks can run in parallel):

- T001 + T002 (shared types — same file, sequential)
- T003, T004, T005 (different files, parallel)

**Phase 2** (sequential — each builds on the previous):

- T006 → T007 → T008 → T009 → T010 (helpers)
- T011 → T012 → T013 → T014 → T015 (handlers)

**Phase 3 (US1)** — after Phase 2:

- T016, T017 (API client — parallel, different functions)
- T018, T019 (VM Agent handlers — parallel, different files)
- T021 (WorktreeSelector — parallel with T018/T019)

**Phase 6 (US3) + Phase 7 (US4)** — can run in parallel after Phase 2:

- All of US3 (terminal) is independent from US4 (agent sessions)

---

## Parallel Example: Phase 1 Setup

```
# All three can run in parallel (different files):
Task T003: "Add worktree env vars to packages/vm-agent/internal/config/config.go"
Task T004: "Create D1 migration apps/api/src/db/migrations/0010_agent_sessions_worktree_path.sql"
Task T005: "Add worktreePath to agentSessions in apps/api/src/db/schema.ts"
```

## Parallel Example: User Story 1

```
# After Phase 2, these can run in parallel:
Task T016: "Add getWorktrees() to apps/web/src/lib/api.ts"
Task T017: "Add worktree param to existing API functions in apps/web/src/lib/api.ts"
Task T018: "Add worktree param to git handlers in packages/vm-agent/internal/server/git.go"
Task T019: "Add worktree param to file handlers in packages/vm-agent/internal/server/files.go"
Task T021: "Create WorktreeSelector component in apps/web/src/components/WorktreeSelector.tsx"
```

## Parallel Example: US3 + US4

```
# After Phase 2, these two stories can proceed in parallel:
US3 (Terminals): T039-T047
US4 (Agent Sessions): T048-T057
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 Only)

1. Complete Phase 1: Setup (shared types, config, migration)
2. Complete Phase 2: Foundational (worktree CRUD endpoints + validation)
3. Complete Phase 3: US1 — View and switch worktrees
4. Complete Phase 4: US2 — Create and remove worktrees
5. **STOP and VALIDATE**: Test worktree selector, switching, file browser scoping, git viewer scoping
6. Deploy — users can now manage worktrees and browse files/git per branch

### Incremental Delivery

1. Setup + Foundational → Backend ready
2. US1 + US2 → Worktree selector + CRUD (MVP!)
3. US5 → File browser/git viewer polish
4. US3 → Worktree-scoped terminals with badges
5. US4 → Worktree-scoped agent sessions with badges
6. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers after Phase 2:

- **Developer A**: US1 (view/switch) → US2 (create/remove) → US5 (polish)
- **Developer B**: US3 (terminals) → US4 (agent sessions)
- Stories integrate independently; no merge conflicts expected (different files)

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- TDD required for VM Agent critical paths (worktree CRUD, path validation)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- US5 is sequenced before US3/US4 because it completes the read-only experience with minimal work
