# Staging Claude Code (SAM AI proxy mode) says it cannot call deferred SAM MCP tools

## Problem

On staging, a Claude Code chat whose agent uses the SAM AI proxy (`providerMode: 'sam'`) did not
follow the `get_instructions` bootstrap. It made three tool calls, then replied: "I've loaded the
schema for `mcp__sam-mcp__get_instructions`, but I don't have a tool in my available interface to
actually invoke deferred MCP tools — I can only fetch their schemas via ToolSearch." It answered the
user's question without the instructions.

## Context

- Seen 2026-10-19 ~14:35Z during the shared-sessions staging run, Test Project 1
  (`01KJNR9R3TEN3KX1ETE33852R8`), chat session `94834910-f7f8-4f0e-8a9a-8f66f28a2694`, owner
  `toWzGjNW3IyUkCVItRQv3qSn0wI8c22y` (staging smoke user), Instant (Lightweight) runtime.
- Unrelated to the shared-sessions change; the same answer appeared on the owner's first prompt.
- Not yet diagnosed: could be the model behind the SAM proxy not following the deferred-tool
  protocol, the Claude Code version's ToolSearch flow, or how SAM registers its MCP server.

## Acceptance Criteria

- [ ] Read the session's tool calls to see what the agent tried (`get_session_messages`, staging)
- [ ] Identify whether the cause is the proxied model, the Claude Code version, or SAM's MCP setup
- [ ] A fresh staging chat in `sam` mode calls `get_instructions` on its first turn
