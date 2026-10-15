# Reliability A: remove platform publication, preserve snapshots

## Problem

Successful agent turns automatically stage all files, commit, push and create review requests. Publication must remain agent-directed while independent sleep snapshots preserve work.

## Research

- Shared VM/Instant callback in `internal/server/server.go` is the sole production caller of `gitPushWorkspaceChanges`.
- `agent_ws.go` wires contextual completion for both harnesses; `workspaces.go` terminal prompts use that same callback.
- Standalone/container snapshot WIP paths use temporary GIT_INDEX_FILE and commit-tree; preserve these.
- Coordinator owns consolidated staging and merge. Use assigned snapshot-supported root branch rather than unpreserved sibling worktree. Task kept on assigned branch to avoid independent main mutation during coordinated release.

## Checklist

- [x] Static audit VM/Instant, both harnesses and actual completion.
- [x] Remove automatic staging/commits/push/review creation.
- [x] Preserve explicit git/PR tools and completion reporting.
- [x] Unit test dirty/staged/workflow/local-commit preservation and absence of publication.
- [ ] Update docs, run checks and independent local reviews.
- [ ] Draft PR and consolidated staging plan/evidence handoff.

## Acceptance

Turn end and actual completion never publish. Snapshot-supported workspace paths preserve tracked/untracked/staged/workflow files and local commits across capture/restore. No claim of sibling worktree preservation. Agent-directed git and complete_task evidence remain available.

## Evidence and remaining runtime proof

- Implementation pushed: 99c8ca22a. Shared `agent_ws.go:getOrCreateSessionHost` binds both callbacks independently of agent type; ACP `session_host_attempt.go` delivers completion for Claude Code and Codex. `workspaces.go:startAgentWithPrompt` uses the same callback. No alternate publication caller remains.
- Actual terminal `apps/api/src/routes/mcp/task-tools.ts` preserves supplied summary/PR/evidence and calls `cleanupTerminalTaskResources`; `services/task-terminal-cleanup.ts` tears down runtime without Git publication. These interfaces are unchanged.
- Targeted callback/cold-wake/WIP tests pass. Independent reviewer confirmed snapshot tests preserve local commits, dirty/untracked files, staged and unstaged content, and workflow files through both standalone/container implementations.
- Direct callback repository mutation proof is standalone; workspace-role callback rejects publication errors but does not execute Docker. Harness wiring/actual terminal paths are statically audited, not yet live-proven.
- Independent local Go/test/completion review: no production defect; stale docs corrected; constitution check and diff whitespace pass. Reviewer review_a.
- Coordinator runtime sweep remains REQUIRED: pin candidate across VM/Instant and Claude/Codex; create local unpushed commit plus staged/unstaged and workflow files; record HEAD/index/status/remote refs/PRs before turn end and complete_task, assert no publication; sleep/wake supported root, compare all content and staged state. Verify VM heartbeat and workspace/terminal access; clean up immediately. Do not claim arbitrary sibling-worktree recovery.
- Keep task active and PR draft pending coordinated runtime evidence. No independent deployment or merge.
