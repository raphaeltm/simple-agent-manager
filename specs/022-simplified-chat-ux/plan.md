# Implementation Plan: Simplified Chat-First UX

**Branch**: `022-simplified-chat-ux` | **Date**: 2026-02-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/022-simplified-chat-ux/spec.md`

## Summary

Radically simplify the SAM project page from a 7-tab interface (Overview, Chat, Kanban, Tasks, Sessions, Settings, Activity) to a single chat-first view. Users import a repo, click the project card, and land directly in a chat interface. They type what they want done; the system creates a task, provisions infrastructure, and starts an agent — all from a single message. The platform ensures GitHub credentials work reliably (token refresh, gh CLI availability, git identity fallback) and auto-pushes changes to a PR branch after 15 minutes of inactivity as a safety net.

**Key architectural decisions** (from [research.md](./research.md)):
- Single-action submit endpoint replaces the 3-call task creation sequence (R1)
- VM agent performs git push at agent completion time, not via DO alarm (R2)
- DO "earliest alarm" pattern for idle cleanup scheduling only (R3)
- gh wrapper script leverages existing git-credential-sam for token refresh (R4)
- Post-build gh CLI installation for custom devcontainer compatibility (R5)
- Branch names generated server-side with task ID suffix for uniqueness (R6)
- Session idle/terminated states derived at query time, not stored (R7)
- Direct WebSocket to VM agent for active session messaging (R8)
- GitHub noreply email format for git identity fallback (R9)
- `finalizedAt` timestamp as idempotency guard for git push operations (R10)

## Technical Context

**Language/Version**: TypeScript 5.x (API Worker + Web UI), Go 1.24+ (VM Agent)
**Primary Dependencies**: Hono (API framework), Drizzle ORM (D1), React 18 + Vite (Web), Cloudflare Workers SDK (Durable Objects), `creack/pty` + `gorilla/websocket` (VM Agent)
**Storage**: Cloudflare D1 (relational metadata), Durable Objects with SQLite (per-project chat data), VM-local SQLite (message outbox)
**Testing**: Vitest (TypeScript), Go test (VM Agent), Miniflare (Worker integration tests), Playwright (E2E)
**Target Platform**: Cloudflare Workers (API), Cloudflare Pages (Web UI), Hetzner Cloud VMs (agent execution)
**Project Type**: Web application (monorepo with `apps/api`, `apps/web`, `packages/*`)
**Performance Goals**: Task submission → first agent message in <30s (warm node) / <3min (cold provision). Dashboard and chat page load in <1s. Session sidebar updates in near-real-time.
**Constraints**: CF DO alarm single-alarm-per-instance limit. GitHub App installation tokens expire after 1h. CF Workers WebSocket limitations for long-lived proxy connections.
**Scale/Scope**: Supports existing user base. No new infrastructure services required. Changes span ~15 files across 3 packages (API, Web, VM Agent).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Research Check (Phase 0 gate)

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. Open Source** | PASS | All changes are to the open-source core. No enterprise-only features introduced. |
| **II. Infrastructure Stability** | PASS | Critical paths (submit endpoint, idle cleanup, git push) require TDD with >90% coverage. Integration tests planned for DO alarm lifecycle. |
| **III. Documentation Excellence** | PASS | This plan + data-model + contracts + quickstart constitute the documentation deliverables. Spec is complete. |
| **IV. Approachable Code & UX** | PASS | Core goal of this feature — reducing 7 tabs to 1 chat view. Error messages are actionable (inline errors for missing credentials, failed provisioning). |
| **IX. Clean Code Architecture** | PASS | No new packages. Changes stay within existing `apps/api`, `apps/web`, `packages/vm-agent` boundaries. Dependencies flow inward. |
| **X. Simplicity & Clarity** | PASS | Minimal schema changes (1 new D1 column, 1 new DO column, 1 new DO table). No new abstractions beyond what's needed. Branch name generation is a simple utility, not an abstraction layer. |
| **XI. No Hardcoded Values** | PASS | All timeouts (`SESSION_IDLE_TIMEOUT_MINUTES`), limits (`BRANCH_NAME_MAX_LENGTH`), and prefixes (`BRANCH_NAME_PREFIX`) are configurable via env vars with sensible defaults. URLs derived from `BASE_DOMAIN`. |
| **XII. Zero-to-Production** | PASS | Single D1 migration (additive). DO schema auto-migrates. No new infrastructure services. No new Cloudflare bindings required. Self-hosting impact: zero beyond running the migration. |

### Post-Design Re-Check (Phase 1 gate)

| Principle | Status | Evidence |
|-----------|--------|----------|
| **II. Infrastructure Stability** | PASS | Test strategy in quickstart.md covers unit, integration, and E2E for all phases. Idle cleanup has retry + fallback to cron sweep (3-layer defense). |
| **X. Simplicity** | PASS | Reviewed by adversarial sub-agent. All 10 research decisions justified. No over-engineering: `awaiting_followup` reuses existing execution step mechanism rather than adding new task status. Session idle state derived, not stored. |
| **XI. No Hardcoded Values** | PASS | New config parameters documented in data-model.md. `SESSION_IDLE_TIMEOUT_MINUTES` (existing but unused) now activated. `BRANCH_NAME_PREFIX`, `BRANCH_NAME_MAX_LENGTH`, `IDLE_CLEANUP_RETRY_DELAY_MS`, `IDLE_CLEANUP_MAX_RETRIES` all configurable. |
| **XII. Zero-to-Production** | PASS | Migration is a single `ALTER TABLE ADD COLUMN` — replayable from zero. No manual setup steps. DO tables auto-create. |

## Architecture Overview

### Data Flow: Chat-First Task Submission

```
User types message → Browser
       │
       ▼
POST /tasks/submit → API Worker
       │
       ├── 1. Generate branch name (R6)
       ├── 2. Insert task (queued) in D1
       ├── 3. Create session + record message in ProjectData DO
       ├── 4. Return 202 {taskId, sessionId, branchName}
       │
       └── waitUntil: executeTaskRun()
              │
              ├── Select/provision node
              ├── Create workspace
              ├── Start agent session
              │
              ▼
         Agent works (ACP session)
              │
              ├── Messages flow: VM Agent → API → DO → WebSocket → Browser
              ├── User follow-ups: Browser → WebSocket → VM Agent (direct)
              │
              ▼
         Agent completes
              │
              ├── VM Agent: git push + PR creation (R2)
              ├── Callback: executionStep → awaiting_followup (R3)
              ├── DO: schedule idle cleanup alarm
              │
              ▼
         Idle window (15 min default)
              │
              ├── User sends follow-up → reset timer, agent resumes
              ├── No response → alarm fires → cleanup workspace
              │
              ▼
         Session terminated (read-only)
```

### Component Changes Map

```
apps/api/
├── src/
│   ├── db/
│   │   ├── schema.ts                    [MODIFY] Add finalizedAt column
│   │   └── migrations/NNNN_*.sql        [NEW]    ALTER TABLE tasks
│   ├── routes/
│   │   ├── task-submit.ts               [NEW]    Submit endpoint
│   │   ├── tasks.ts                     [MODIFY] Enhanced callback
│   │   └── chat.ts                      [MODIFY] Add idle-reset endpoint
│   ├── services/
│   │   └── branch-name.ts              [NEW]    Slug generation utility
│   └── durable-objects/
│       └── project-data.ts             [MODIFY] Idle timer, session fields

apps/web/
├── src/
│   ├── pages/
│   │   ├── Dashboard.tsx               [MODIFY] Remove workspace cards
│   │   ├── Project.tsx                 [MODIFY] Chat-first layout, remove tabs
│   │   └── ProjectChat.tsx             [MODIFY] Simplified submit, session states
│   ├── components/
│   │   ├── chat/
│   │   │   ├── SessionSidebar.tsx      [MODIFY] Visual states (green/amber/gray)
│   │   │   └── ProjectMessageView.tsx  [MODIFY] WebSocket + lifecycle states
│   │   └── project/
│   │       └── SettingsDrawer.tsx      [NEW]    Extracted from ProjectSettings
│   ├── lib/
│   │   └── api.ts                      [MODIFY] Add submitTask(), resetIdle()
│   └── App.tsx                         [MODIFY] Update routing

packages/vm-agent/
├── internal/
│   ├── bootstrap/
│   │   └── bootstrap.go               [MODIFY] gh CLI, git identity, gh wrapper
│   └── acp/
│       └── session.go                  [MODIFY] Completion → git push → callback
```

## Project Structure

### Documentation (this feature)

```text
specs/022-simplified-chat-ux/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: 10 architecture decisions
├── data-model.md        # Phase 1: Schema changes, entity updates, state machines
├── quickstart.md        # Phase 1: Dev setup, phase ordering, testing approach
├── contracts/
│   ├── task-submit.md       # POST /tasks/submit contract
│   ├── callback-enhanced.md # Enhanced status callback contract
│   └── session-responses.md # Enhanced session response types
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
apps/
├── api/                          # Cloudflare Worker API (Hono)
│   ├── src/
│   │   ├── db/
│   │   │   ├── schema.ts        # Drizzle schema (tasks.finalizedAt added)
│   │   │   └── migrations/      # D1 migrations
│   │   ├── routes/
│   │   │   ├── task-submit.ts   # NEW: Single-action submit
│   │   │   ├── tasks.ts         # Enhanced callback handler
│   │   │   └── chat.ts          # Idle-reset endpoint
│   │   ├── services/
│   │   │   ├── branch-name.ts   # NEW: Slug generation
│   │   │   └── task-runner.ts   # Existing (minor: outputBranch at creation)
│   │   └── durable-objects/
│   │       └── project-data.ts  # Idle timer + session fields
│   └── tests/
│       ├── unit/                # Branch name, finalization guard
│       └── integration/         # Submit flow, callback, DO alarm
│
├── web/                          # React + Vite control plane UI
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx    # Simplified project cards
│   │   │   ├── Project.tsx      # Chat-first layout
│   │   │   └── ProjectChat.tsx  # Session lifecycle states
│   │   ├── components/
│   │   │   ├── chat/
│   │   │   │   ├── SessionSidebar.tsx
│   │   │   │   └── ProjectMessageView.tsx
│   │   │   └── project/
│   │   │       └── SettingsDrawer.tsx  # NEW
│   │   └── lib/
│   │       └── api.ts           # submitTask(), resetIdle()
│   └── tests/
│
packages/
└── vm-agent/                     # Go VM Agent
    └── internal/
        ├── bootstrap/
        │   └── bootstrap.go     # gh CLI, git identity, gh wrapper
        └── acp/
            └── session.go       # Completion → git push → callback
```

**Structure Decision**: Existing monorepo structure. No new packages or apps. All changes are modifications to existing packages or new files within existing package directories.

## Complexity Tracking

No constitution violations requiring justification. All changes use existing patterns (DO alarms, execution steps, callback endpoints, session management) extended with minimal additions.

## Design Artifacts

| Artifact | Path | Status |
|----------|------|--------|
| Feature Spec | [spec.md](./spec.md) | Complete |
| Requirements Checklist | [checklists/requirements.md](./checklists/requirements.md) | Complete (all pass) |
| Research | [research.md](./research.md) | Complete (10 decisions, adversarial-reviewed) |
| Data Model | [data-model.md](./data-model.md) | Complete |
| API Contracts | [contracts/](./contracts/) | Complete (3 contracts) |
| Quickstart | [quickstart.md](./quickstart.md) | Complete |
| Tasks | tasks.md | Pending (`/speckit.tasks`) |
