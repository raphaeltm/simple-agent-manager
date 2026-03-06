# Continue Staging UX/UI QA Testing

**Date:** 2026-03-06
**Status:** backlog

## Background

On 2026-03-05, an agent ran a Playwright-driven QA session against staging (`app.simple-agent-manager.org`) testing standard developer usage flows. It discovered and filed 5 bugs (commit `03b57d6`), then fixed all 5 in PRs #263–#268 (all merged). The agent was shut down after ~1 hour before completing its full test pass.

### What Was Completed

The agent tested and fixed:
1. Docker DNS resolution failure blocking devcontainer builds (PR #263)
2. Task title generation returning raw markdown (PR #264)
3. Error messages rendered as unsanitized markdown in chat (PR #265)
4. Inconsistent task title generation under concurrent load (PR #266)
5. Workspace restart showing stale error state (PR #267, #268)

It also filed `2026-03-05-agent-session-not-found-404.md` (still in backlog) discovered during E2E verification.

### What Was NOT Completed

The agent was interrupted before it could finish testing the full UX surface. The following areas likely still need QA:

## Areas to Test

Use Playwright against staging with test credentials at `/workspaces/.tmp/secure/demo-credentials.md`.

### Core Flows (Standard Developer Usage)
- [ ] **Login/auth flow** — GitHub OAuth login, session persistence, logout
- [ ] **Project creation & settings** — create project, link repo, configure VM size, agent type
- [ ] **Workspace lifecycle** — create workspace, wait for provisioning, connect terminal, stop, restart, delete
- [ ] **Task submission & execution** — submit task via chat, watch agent run, verify output
- [ ] **Chat UX** — new chat, switch sessions, message rendering, scroll behavior, load-more
- [ ] **Dashboard** — project cards, active tasks grid, navigation

### Secondary Flows
- [ ] **Settings page** — credentials management, API key vs OAuth toggle
- [ ] **Admin page** — health overview, error list, log viewer (if admin user)
- [ ] **Workspaces page** — list all workspaces across projects, status display
- [ ] **Node management** — node list, status, stop/delete
- [ ] **Mobile responsiveness** — test key flows at mobile viewport sizes

### Edge Cases & Error States
- [ ] **Empty states** — new user with no projects, project with no workspaces, no chat sessions
- [ ] **Error recovery** — what happens when a workspace fails to provision? Network disconnect?
- [ ] **Concurrent operations** — submit multiple tasks, switch between projects quickly
- [ ] **Stale data** — does the UI update when workspace state changes on the backend?

## How to Pick Up This Work

1. Deploy latest `main` to staging (or verify staging is current)
2. Open Playwright against `app.simple-agent-manager.org`
3. Authenticate with test credentials
4. Work through the checklist above systematically
5. For each bug found: file a backlog task in `tasks/backlog/YYYY-MM-DD-descriptive-name.md`
6. If fixes are straightforward, fix them immediately (worktree + PR)
7. Check off completed areas as you go

## Acceptance Criteria

- [ ] All checklist areas above have been tested
- [ ] Any bugs discovered are filed as backlog tasks
- [ ] Critical bugs (blocking standard usage) are fixed in PRs
