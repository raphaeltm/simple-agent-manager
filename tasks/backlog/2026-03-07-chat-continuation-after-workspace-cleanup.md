# Chat Continuation After Workspace Cleanup

**Created**: 2026-03-07
**Design note**: `docs/notes/2026-03-07-chat-continuity-after-workspace-cleanup.md`

## Problem

When a workspace is cleaned up (node destroyed), the user cannot continue the chat session. The chat history survives in the ProjectData DO, but the API blocks follow-up prompts with a 409. We want to let users keep chatting in the same session thread, with the system transparently provisioning a new workspace.

## Approach: Approach C with branch-aware forking

When a user sends a follow-up to a stopped session:

1. Persist the message in the DO immediately (appears in chat)
2. Check whether the previous task's output branch exists on the remote (via GitHub API or `git ls-remote`)
3. **Branch exists**: Create a continuation task that checks out that branch. The new agent gets the code context + `output_summary` + user's new message. This is the "pick up where we left off" path.
4. **Branch does not exist**: Create a continuation task on the project's default branch. The new agent gets only `output_summary` (if any) + user's new message. The UI should indicate that prior code changes were not preserved — this is a conversational fork, not a code continuation.
5. Provision workspace via normal TaskRunner flow, re-link session via `linkSessionToWorkspace()`
6. Show provisioning indicator inline in the chat

### Key signal: `finalizedAt` vs branch verification

- `outputBranch` in D1 is set at task creation time (intended branch name) — it does NOT mean the branch exists on the remote
- `finalizedAt` is set only on confirmed push — but even this isn't 100% reliable (push could succeed, callback could fail)
- **The only reliable check is querying GitHub** for the branch. Use `finalizedAt` as a fast-path hint (skip the check if null), but always verify against the remote when `finalizedAt` is set.

## Research Needed

- [ ] How does the current `task-submit` flow construct the initial prompt? Need to understand where to inject continuation context (summary + branch info).
- [ ] What does `output_summary` actually contain today? Is it reliably generated? Is it useful as agent context?
- [ ] How does the frontend handle the provisioning state in `ProjectChat.tsx`? Need to understand what changes are needed to support provisioning from within a stopped session (vs. only from the new-chat input).
- [ ] What GitHub API call is best for checking branch existence? (`GET /repos/:owner/:repo/branches/:branch` or `git ls-remote`?) Need to consider auth (user's GitHub token vs. GitHub App installation token).
- [ ] How should the session status state machine change? Currently `active → stopped` is terminal. Need a `stopped → provisioning → active` transition, or keep the session `stopped` until the new workspace is ready and then flip to `active`.
- [ ] Race condition: what if the user sends multiple messages while provisioning? Queue them as part of the initial prompt? Block input during provisioning?
- [ ] How does `useProjectAgentSession` (ACP WebSocket) handle workspace ID changes mid-session? The workspace link changes when `linkSessionToWorkspace()` runs — does the frontend pick this up and reconnect?

## Acceptance Criteria

- [ ] User can send a follow-up message to a stopped chat session
- [ ] System checks whether the output branch exists on the remote
- [ ] If branch exists: new workspace checks out that branch; agent gets code context
- [ ] If branch does not exist: new workspace uses default branch; UI indicates this is a fresh-code continuation
- [ ] Provisioning indicator appears inline in the existing chat thread
- [ ] Messages from the new agent append to the same session's message stream
- [ ] Chat input is disabled during provisioning to prevent race conditions
- [ ] `finalizedAt` used as fast-path hint; GitHub API used as ground truth for branch existence
