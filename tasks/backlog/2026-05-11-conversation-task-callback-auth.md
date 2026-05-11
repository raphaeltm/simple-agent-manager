# Conversation Task Callback Auth Failure

## Problem

During staging validation of PR #963 on 2026-05-11, a conversation-mode task reached agent completion but the VM agent task status callback returned `401 Authentication required`.

Evidence from node debug package:

- Task: `01KRC34397DD0A2SGHT1Z9HYC4`
- Project: `01KJNR9R3TEN3KX1ETE33852R8`
- Workspace: `01KRC387GS8HHM52YJHS3WT97F`
- Node: `01KRC349V91MW4S8959TVV0Z7B`
- Log line: `Task callback: unexpected status`
- Callback URL: `https://api.sammy.party/api/projects/01KJNR9R3TEN3KX1ETE33852R8/tasks/01KRC34397DD0A2SGHT1Z9HYC4/status/callback`
- Response: `{"error":"UNAUTHORIZED","message":"Authentication required"}`

The task was submitted with `taskMode: "conversation"` and the VM agent correctly skipped git push, but the completion/status callback still attempted the task callback path and was rejected.

## Context

This was discovered while validating Cloudflare managed Containers Registry devcontainer cache behavior. The cache feature itself worked, but this callback failure can leave conversation-mode validation tasks in an inaccurate lifecycle state.

## Acceptance Criteria

- [ ] Reproduce with a staging or integration test for `taskMode: "conversation"`.
- [ ] Confirm the VM agent has the correct callback token/context for conversation-mode task status reporting, or skips task status callback when appropriate.
- [ ] Task/session state transitions are correct after a conversation-mode agent exits.
- [ ] Add regression coverage for the callback auth path.
