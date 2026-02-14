# Git Changes Viewer

**Created**: 2026-02-14
**Priority**: High
**Relates to**: FR-008 (file browsing requirement)

## Summary

A GitHub PR-style review UI for viewing git changes (staged/unstaged/untracked) within workspaces. Entry point is an icon button in the workspace nav bar. Full-screen overlay with browser back/forward routing support. Read-only in v1.

## Context

FR-008 requires file browsing/editing in workspaces. This is the first step — a focused git changes viewer that lets users review what the agent (or they) have changed. A general file browser will follow later and integrate with this.

## Design Decisions

- **Entry point**: Icon button (GitBranch icon) in workspace nav bar, next to kebab menu
- **Layout**: Full-screen overlay (same on mobile and desktop)
- **Routing**: URL search params for browser back/forward (`?git=changes`, `?git=diff&file=...&staged=...`)
- **Read-only v1**: No stage/unstage actions; refresh button for manual updates
- **Not reusing `FileDiffView`** from acp-client — it uses Tailwind classes; workspace page uses inline styles with CSS custom properties
- **zIndex: 60** for git overlay (existing sidebar uses 50/51)

## Implementation Plan

### Phase 1: Backend — VM Agent (Go)

- [ ] Add `GitExecTimeout` (default 30s) and `GitFileMaxSize` (default 1MB) to `config.go`
- [ ] Create `git.go` with three handlers + helpers:
  - `GET /workspaces/{workspaceId}/git/status` — parses `git status --porcelain=v1`
  - `GET /workspaces/{workspaceId}/git/diff?path=...&staged=true|false` — unified diff for one file
  - `GET /workspaces/{workspaceId}/git/file?path=...&ref=HEAD` — full file content
  - `sanitizeFilePath()` — rejects `..`, absolute paths, null bytes
  - `sanitizeGitRef()` — rejects shell metacharacters
  - `execInContainer()` — `docker exec` wrapper with timeout
  - `parseGitStatusPorcelain()` — parser for porcelain v1 format
  - `formatAsAdditions()` — converts untracked file content to diff format
- [ ] Register 3 routes in `server.go` `setupRoutes()`
- [ ] Create `git_test.go` with path sanitization, ref sanitization, porcelain parser, and formatAsAdditions tests

### Phase 2: API Client (TypeScript)

- [ ] Add to `apps/web/src/lib/api.ts`:
  - Types: `GitFileStatus`, `GitStatusData`, `GitDiffData`, `GitFileData`
  - Functions: `getGitStatus()`, `getGitDiff()`, `getGitFile()`
  - Pattern: direct fetch to VM agent via `ws-{id}` subdomain with `?token=` auth

### Phase 3: Frontend Components (React)

- [ ] `GitChangesButton.tsx` — nav bar icon with optional change count badge
- [ ] `GitChangesPanel.tsx` — full-screen overlay with collapsible Staged/Unstaged/Untracked sections
  - File rows show status letter (color-coded) + path (dir dimmed, filename bright)
  - Refresh button, close button, Escape key handler
  - Empty state: "No changes detected"
- [ ] `GitDiffView.tsx` — full-screen diff viewer for one file
  - Unified diff with green (added), red (removed), blue (hunk headers), dimmed (context)
  - Toggle between "Diff" (hunks only) and "Full" (entire file with highlights)
  - Monospace, horizontal scroll
- [ ] Integrate into `Workspace.tsx`:
  - Read `git`, `file`, `staged` search params
  - Navigation handlers for open/close/navigate-to-diff/back-from-diff
  - `GitChangesButton` in header (before kebab menu, visible when workspace is running)
  - Overlay rendering at bottom of JSX

### Phase 4: Documentation

- [ ] Update `CLAUDE.md` + `AGENTS.md`: new VM agent endpoints, new env vars (`GIT_EXEC_TIMEOUT`, `GIT_FILE_MAX_SIZE`)
- [ ] Add to Recent Changes section

### Phase 5: Verification

- [ ] `go test ./internal/server/...` passes
- [ ] `pnpm typecheck && pnpm lint` passes
- [ ] Deploy and Playwright test against live app (file list, diff view, browser back/forward, mobile viewport)

## Work in Progress

Some implementation has already been completed:
- **Done**: config.go additions, git.go (handlers + helpers), server.go route registration, git_test.go (32 tests passing), api.ts client functions, GitChangesButton.tsx, GitChangesPanel.tsx
- **Remaining**: GitDiffView.tsx, Workspace.tsx integration, typecheck/lint, documentation updates
