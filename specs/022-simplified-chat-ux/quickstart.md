# Quickstart: Simplified Chat-First UX

**Feature Branch**: `022-simplified-chat-ux`
**Date**: 2026-02-25

## Prerequisites

- Node.js 20+, pnpm 9+, Go 1.24+
- Access to the SAM monorepo
- Familiarity with: Cloudflare Workers, Durable Objects, Hono, React + Vite, Go

## Implementation Phases

Work proceeds in four phases. Phases A and B can run in parallel. Phase C depends on A. Phase D is independent.

### Phase A: Backend (API + Durable Objects)

**Goal**: New submit endpoint, enhanced callback, idle cleanup timer.

#### A1. D1 Migration — `finalizedAt` column

**Files**:
- `apps/api/src/db/migrations/NNNN_add_finalized_at.sql` (new)
- `apps/api/src/db/schema.ts` (add column)

**What to do**:
1. Create migration: `ALTER TABLE tasks ADD COLUMN finalized_at TEXT;`
2. Add `finalizedAt` to tasks table in Drizzle schema
3. Export updated type from `@simple-agent-manager/shared`

**Test**: Unit test that task creation returns `finalizedAt: null` and can be updated.

#### A2. Submit Endpoint — `POST /tasks/submit`

**Files**:
- `apps/api/src/routes/task-submit.ts` (new)
- `apps/api/src/services/branch-name.ts` (new — slug generation utility)
- `apps/api/src/routes/index.ts` (register route)

**What to do**:
1. Implement branch name generation (R6 algorithm from research.md)
2. Implement submit handler:
   - Validate request (auth, project ownership, credentials)
   - Generate branch name
   - Insert task as `queued` with `outputBranch` set
   - Create chat session in ProjectData DO
   - Record first user message
   - Kick off `executeTaskRun` via `waitUntil`
3. Return 202 with taskId, sessionId, branchName

**Contract**: See `contracts/task-submit.md`

**Tests**:
- Unit: branch name generation (edge cases: long messages, special chars, unicode, empty words)
- Integration: submit endpoint creates task, session, and message atomically

#### A3. Enhanced Status Callback

**Files**:
- `apps/api/src/routes/tasks.ts` (modify callback handler)

**What to do**:
1. Accept `executionStep` and `gitPushResult` fields in callback body
2. When `executionStep: 'awaiting_followup'`:
   - Update task execution step (don't change status)
   - Save git push results on task
   - Set `finalizedAt` if push succeeded
   - Signal DO to start idle cleanup timer
3. Do NOT stop session or cleanup workspace on agent completion

**Contract**: See `contracts/callback-enhanced.md`

**Tests**:
- Integration: callback with `awaiting_followup` keeps task in `running`, starts idle timer
- Integration: callback with `toStatus: 'completed'` still works (backward compat)
- Unit: finalization guard prevents double-set

#### A4. ProjectData DO — Idle Cleanup

**Files**:
- `apps/api/src/durable-objects/project-data.ts` (modify)

**What to do**:
1. Add `agent_completed_at` column to `chat_sessions` (DO SQLite auto-migration)
2. Create `idle_cleanup_schedule` table
3. Implement `scheduleIdleCleanup(sessionId, workspaceId, taskId)` method
4. Implement `cancelIdleCleanup(sessionId)` method
5. Implement `alarm()` handler (trigger cleanup for expired sessions)
6. Add `resetIdleCleanup(sessionId)` for follow-up timer reset

**Pattern**: Follow NodeLifecycle DO alarm pattern (`apps/api/src/durable-objects/node-lifecycle.ts`)

**Tests**:
- Unit: schedule/cancel/reset lifecycle
- Integration: alarm fires and triggers cleanup API call
- Edge: concurrent sessions with different timeout times

#### A5. Enhanced Session Responses

**Files**:
- `apps/api/src/durable-objects/project-data.ts` (modify session query methods)

**What to do**:
1. Include `agentCompletedAt` in session responses
2. Compute `isIdle`, `isTerminated`, `workspaceUrl` at response time
3. Add task embed to detail response (D1 lookup)

**Contract**: See `contracts/session-responses.md`

**Tests**:
- Unit: isIdle/isTerminated derivation logic
- Integration: session list returns computed fields correctly

#### A6. Idle Timer Reset Endpoint

**Files**:
- `apps/api/src/routes/chat.ts` (add endpoint)

**What to do**:
1. `POST /projects/:projectId/sessions/:sessionId/idle-reset`
2. Call ProjectData DO to reset cleanup timer
3. Return new cleanup timestamp

**Tests**:
- Integration: reset extends cleanup time
- Edge: reset on non-idle session returns 409

---

### Phase B: VM Agent (Go)

**Goal**: gh CLI reliability, git identity fallback, agent completion flow.

#### B1. Post-Build gh CLI Check

**Files**:
- `packages/vm-agent/internal/bootstrap/bootstrap.go` (modify)

**What to do**:
1. Add `ensureGitHubCLI()` function, called after `ensureDevcontainerReady()`
2. `docker exec <container> which gh` — check existence
3. If not found: install via official script (`curl -fsSL https://cli.github.com/packages/...`)
4. Log result

**Tests**:
- Unit: mock docker exec for gh check
- Integration: container without gh gets it installed

#### B2. gh Wrapper Script

**Files**:
- `packages/vm-agent/internal/bootstrap/bootstrap.go` (modify `ensureGitCredentialHelper`)

**What to do**:
1. After confirming gh exists: move `gh` to `gh.real`
2. Install wrapper script at original `gh` path:
   ```sh
   #!/bin/sh
   export GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill 2>/dev/null | grep '^password=' | cut -d= -f2-)
   exec "$(dirname "$0")/gh.real" "$@"
   ```
3. Make wrapper executable

**Tests**:
- Unit: wrapper script generates correct GH_TOKEN
- Integration: `gh auth status` works after 1+ hours

#### B3. Git Identity Noreply Fallback

**Files**:
- `packages/vm-agent/internal/bootstrap/bootstrap.go` (modify `ensureGitIdentity`)

**What to do**:
1. When `gitUserEmail` is empty, use fallback: `{githubId}+{sanitized-name}@users.noreply.github.com`
2. Requires `githubId` in workspace creation payload
3. Update `CreateWorkspaceRequest` to include `githubId` field

**Tests**:
- Unit: fallback email format is correct
- Edge: user with no name defaults to github username

#### B4. Agent Completion Git Push

**Files**:
- `packages/vm-agent/internal/acp/session.go` (or equivalent ACP session handler)

**What to do**:
1. On ACP session end (OnPromptComplete or monitorProcessExit):
   a. `git status --porcelain` — check for changes
   b. If changes: `git add -A && git commit -m "..."` (use `.gitignore`)
   c. `git push origin {branchName}`
   d. If push succeeded and no existing PR: `gh pr create --title "..." --body "..."`
2. POST callback to control plane with `executionStep: 'awaiting_followup'` and `gitPushResult`
3. Do NOT stop the container — workspace stays alive

**Tests**:
- Unit: git push logic with mock git commands
- Integration: agent completion triggers push and callback

---

### Phase C: Frontend (React)

**Goal**: Chat-first UI, simplified dashboard, settings drawer.

**Depends on**: Phase A (submit endpoint, enhanced session responses)

#### C1. Dashboard Simplification

**Files**:
- `apps/web/src/pages/Dashboard.tsx` (modify)

**What to do**:
1. Remove workspace cards and node lists
2. Keep project cards: name, repo, last activity
3. Click project → navigate to `/projects/:id` (chat interface)
4. Keep "Import Project" button prominent
5. Remove onboarding checklist (or simplify)

**Tests**: Visual regression test, navigation test

#### C2. Project Page — Chat-First Layout

**Files**:
- `apps/web/src/pages/Project.tsx` (major modification)
- `apps/web/src/App.tsx` (update routing)

**What to do**:
1. Remove `PROJECT_TABS` array and `<Tabs>` component
2. Replace with minimal header: project name, repo link, settings gear icon
3. Default route `/projects/:id` renders chat interface directly
4. Session sidebar on left, message area center, input at bottom
5. Keep subroute for `/projects/:id/chat/:sessionId` for deep linking

**Tests**: Navigation test, layout test

#### C3. Settings Drawer

**Files**:
- `apps/web/src/components/project/SettingsDrawer.tsx` (new)
- `apps/web/src/pages/Project.tsx` (integrate drawer)

**What to do**:
1. Extract settings content from `ProjectSettings.tsx` into a drawer component
2. Slide-in from right on gear icon click
3. Include: default node size, env vars, runtime files
4. Save/discard confirmation on close
5. Close on click outside or close button

**Tests**: Open/close, save/discard, persistence

#### C4. Session Sidebar Visual States

**Files**:
- `apps/web/src/components/chat/SessionSidebar.tsx` (modify)

**What to do**:
1. Green indicator for active sessions (agent working)
2. Amber indicator for idle sessions (agent finished, workspace alive)
3. Gray/muted for terminated sessions (workspace cleaned up)
4. Use `isIdle` and `isTerminated` from enhanced API response

**Tests**: Visual states render correctly for each session type

#### C5. Simplified Submit Input

**Files**:
- `apps/web/src/components/chat/ChatInput.tsx` (new or modify TaskSubmitForm)

**What to do**:
1. Single text input with send button
2. Enter to submit (calls `POST /tasks/submit`)
3. No "Save to Backlog" option visible by default
4. No advanced options visible by default
5. While task is provisioning: show inline progress indicator

**Tests**: Submit flow, progress indicator, error states

#### C6. Active Session WebSocket

**Files**:
- `apps/web/src/components/chat/ProjectMessageView.tsx` (modify)

**What to do**:
1. When session is active and has `workspaceUrl`:
   - Establish WebSocket to VM agent for bidirectional messaging
2. User messages sent via WebSocket (not HTTP)
3. When session becomes idle: keep WebSocket open, show "agent finished" indicator
4. When session is terminated: close WebSocket, disable input
5. On idle session message send: call idle-reset endpoint

**Tests**: WebSocket connection lifecycle, message send/receive, reconnection

---

### Phase D: Branch Naming (Independent)

#### D1. Slug Generation Utility

**Files**:
- `apps/api/src/services/branch-name.ts` (new)

**What to do**:
1. Implement slugification algorithm (R6 from research.md)
2. Stop words list, sanitization, truncation
3. Task ID suffix for uniqueness

**Tests**: Comprehensive unit tests (long strings, unicode, special chars, empty input, collisions)

---

## Testing Strategy

| Phase | Unit Tests | Integration Tests | E2E Tests |
|-------|------------|-------------------|-----------|
| A | Branch name gen, finalization guard, idle derivation | Submit endpoint, callback flow, DO alarm lifecycle | Submit → provision → agent complete → idle cleanup |
| B | Git push logic, gh wrapper, identity fallback | Agent completion → callback → git push result | Long-running session (>1h) gh CLI works |
| C | Component rendering, state derivation | API integration (session states, submit) | Full chat flow: submit → watch → follow-up → idle |
| D | Slug algorithm | Branch name in submit response | Branch exists in GitHub after task |

## Key Files Quick Reference

| File | Phase | Change |
|------|-------|--------|
| `apps/api/src/db/schema.ts` | A1 | Add `finalizedAt` |
| `apps/api/src/routes/task-submit.ts` | A2 | New file |
| `apps/api/src/services/branch-name.ts` | A2/D1 | New file |
| `apps/api/src/routes/tasks.ts` | A3 | Modify callback |
| `apps/api/src/routes/chat.ts` | A6 | Add idle-reset endpoint |
| `apps/api/src/durable-objects/project-data.ts` | A4-A5 | Idle timer, session fields |
| `packages/vm-agent/internal/bootstrap/bootstrap.go` | B1-B3 | gh CLI, git identity |
| `packages/vm-agent/internal/acp/session.go` | B4 | Completion → git push |
| `apps/web/src/pages/Dashboard.tsx` | C1 | Simplify |
| `apps/web/src/pages/Project.tsx` | C2 | Chat-first layout |
| `apps/web/src/pages/ProjectChat.tsx` | C2 | Merge into Project.tsx |
| `apps/web/src/components/chat/SessionSidebar.tsx` | C4 | Visual states |
| `apps/web/src/components/chat/ProjectMessageView.tsx` | C6 | WebSocket connection |

## Running Locally

```bash
# Install dependencies
pnpm install

# Build in dependency order
pnpm --filter @simple-agent-manager/shared build
pnpm --filter @simple-agent-manager/providers build

# Run API (with Miniflare for D1/DO)
pnpm --filter @simple-agent-manager/api dev

# Run Web UI
pnpm --filter @simple-agent-manager/web dev

# Run tests
pnpm test

# Type check
pnpm typecheck
```

For meaningful testing of DO alarm behavior and WebSocket connections, deploy to staging per `docs/guides/local-development.md`.
