# Staging: Claude Code agent stalls before sending its first sam-mcp tool call

## Problem

On staging (sammy.party), a task-mode Claude Code session (profile "default", model
claude-sonnet-4-5-20250929, adapter @agentclientprotocol/claude-agent-acp 0.102.0) showed a
`mcp__sam-mcp__get_instructions` tool call in the chat and then hung: the first prompt ran 26 minutes
until cancelled, and a follow-up prompt hung the same way.

Workers Observability for `sam-api-staging` shows the MCP client completing `initialize`,
`notifications/initialized` (202), the SSE GET (405) and `tools/list` (200, 755 ms) for each prompt,
and then **no `tools/call` request ever reaching `/mcp`**. The stall is between the agent and its MCP
client, not in the API. After the prompt was cancelled, the transcript showed
`Tool permission request failed: Error: Tool use aborted`: the `get_instructions` call was waiting on a
tool-permission prompt (session mode `acceptEdits`) that nobody answered. Shell commands in the same
session then ran without a prompt.

## Context

Found 2026-11-16 during Insights slice F staging verification (PR #2789). Task
`01M7J65F54VX0BCVKFG6Z8BHMM`, session `a063f257-be6c-4152-9ec0-5552c683f058`, node
`01M7J65SHGAWV5788QBJK3VE7F`. The transcript shows `ToolSearch` resolving the deferred tool before
the call.

## Acceptance criteria

- [ ] Reproduce on staging with a Claude Code task-mode session and capture the vm-agent / adapter logs
      for the window after `tools/list`
- [ ] Confirm why sam-mcp tool calls need permission in `acceptEdits` mode for this profile, and auto-allow sam-mcp tools (or surface the permission request in the chat)
- [ ] A stalled tool call surfaces as a visible failure instead of an indefinitely running prompt
