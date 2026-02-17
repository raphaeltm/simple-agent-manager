# Implementation Plan: Worktree Context Switching

**Branch**: `015-worktree-context` | **Date**: 2026-02-17 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/015-worktree-context/spec.md`

## Summary

Deep git worktree integration enabling parallel branch work within a single workspace. Users can create, switch, and remove worktrees via a selector in the workspace header. All subsystems — file browser, git viewer, terminals, and agent chat sessions — become worktree-scoped, allowing instant context switching between branches without container rebuilds. Terminals and agent sessions are bound to their creation-time worktree and retain that binding for their lifetime.

## Technical Context

**Language/Version**: TypeScript 5.x (API + Web), Go 1.22+ (VM Agent)
**Primary Dependencies**: Hono (API), React 18 + Vite 5 (Web), creack/pty + gorilla/websocket (VM Agent), ACP SDK (agent sessions)
**Storage**: Cloudflare D1 (agent session worktree metadata), SQLite on VM (terminal session metadata), Docker named volumes (worktree directories)
**Testing**: Vitest + Miniflare (API/Web), Go testing (VM Agent)
**Target Platform**: Cloudflare Workers (API), Cloudflare Pages (Web), Linux VMs (VM Agent)
**Project Type**: web (monorepo: apps/api, apps/web, packages/vm-agent, packages/shared, packages/terminal)
**Performance Goals**: Worktree switch <1s (no reload), worktree creation <10s, parallel agent sessions across 2+ worktrees
**Constraints**: Named Docker volume mount at `/workspaces` (enables sibling worktree access), configurable max worktrees per workspace, worktree paths validated against `git worktree list` output
**Scale/Scope**: Per-workspace feature; typical usage 2-5 worktrees per workspace

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source | PASS | Feature is core platform functionality, no premium gating |
| II. Infrastructure Stability | PASS | TDD required for worktree CRUD, path validation, and session binding. Integration tests for docker exec worktree commands |
| III. Documentation Excellence | PASS | API contracts documented, data model specified, quickstart provided |
| IV. Approachable Code | PASS | Worktree selector is intuitive UX, errors are actionable (branch already checked out, dirty worktree warnings) |
| V. Transparent Roadmap | PASS | Feature spec exists at specs/015-worktree-context/ |
| VI. Automated Quality Gates | PASS | Tests enforced via CI, no new manual gates needed |
| VII. Inclusive Contribution | N/A | No changes to contribution flow |
| VIII. AI-Friendly Repository | PASS | CLAUDE.md will be updated with worktree feature in Recent Changes |
| IX. Clean Code Architecture | PASS | New Go package `internal/server/worktrees.go`, frontend `WorktreeSelector` component, shared types extended. No circular deps |
| X. Simplicity & Clarity | PASS | Worktree path is threaded through existing `ContainerWorkDir` pattern. No new abstractions beyond what git worktree provides. Max worktree limit prevents complexity explosion |
| XI. No Hardcoded Values | PASS | `MAX_WORKTREES_PER_WORKSPACE` configurable via env var with default. All worktree paths derived dynamically. No hardcoded branch names or paths |

**Gate Result**: PASS — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/015-worktree-context/
├── spec.md              # Feature specification (complete)
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── api.md           # VM Agent + Control Plane API contracts
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
packages/vm-agent/
├── internal/
│   ├── config/config.go          # Add MAX_WORKTREES_PER_WORKSPACE env var
│   ├── server/
│   │   ├── worktrees.go          # NEW: worktree CRUD endpoints + validation
│   │   ├── git.go                # Add worktree query param support
│   │   ├── files.go              # Add worktree query param support
│   │   ├── server.go             # Register worktree routes
│   │   ├── websocket.go          # Accept worktree param for new PTY sessions
│   │   ├── agent_ws.go           # Accept worktree param for agent sessions
│   │   └── workspace_routing.go  # Worktree path validation helper
│   ├── pty/
│   │   └── manager.go            # CreateSessionWithWorkDir method
│   └── acp/
│       └── session_host.go       # Accept per-session ContainerWorkDir
└── tests/                        # Unit + integration tests

apps/api/
├── src/
│   ├── db/schema.ts              # Add worktreePath to agentSessions
│   └── routes/workspaces.ts      # Pass worktreePath in create/list agent sessions
└── tests/                        # Integration tests

apps/web/
├── src/
│   ├── components/
│   │   ├── WorktreeSelector.tsx   # NEW: dropdown with create/remove
│   │   ├── FileBrowserPanel.tsx   # Accept worktree prop
│   │   ├── GitChangesPanel.tsx    # Accept worktree prop
│   │   ├── GitDiffView.tsx        # Accept worktree prop
│   │   ├── WorkspaceTabStrip.tsx  # Worktree badge on tabs
│   │   └── ChatSession.tsx        # Pass worktree to agent WS URL
│   ├── pages/
│   │   └── Workspace.tsx          # Worktree state, selector, URL param
│   └── lib/
│       └── api.ts                 # Add worktree param to VM Agent calls
└── tests/

packages/shared/
└── src/types.ts                   # WorktreeInfo type, extended AgentSession

packages/terminal/
└── src/MultiTerminal.tsx          # Accept worktree for new sessions
```

**Structure Decision**: Changes span VM Agent (Go), Control Plane API (TypeScript), Web UI (React), shared types, and terminal package. No new packages needed — feature integrates into existing architecture via new endpoints and prop threading.
