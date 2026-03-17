# Post-Mortem: MCP Token Revocation Breaks Ongoing Sessions

**Date**: 2026-03-08
**Severity**: High — complete loss of MCP functionality after first task completion

## What Broke

After an agent called `complete_task` on the SAM MCP server, all subsequent MCP tool calls failed permanently for the rest of the session. The tools remained visible but every call returned "Command failed with no output."

## Root Cause

`handleCompleteTask()` in `apps/api/src/routes/mcp.ts` revoked the MCP token from KV immediately upon task completion. Since the MCP token is the sole authentication credential for the session, all subsequent requests received HTTP 401.

The MCP client (Claude Code) then attempted OAuth discovery as a recovery mechanism, cached empty credentials, and entered a permanent failure state where all tools returned "Token expired without refresh token."

## Timeline

1. **Token lifecycle designed**: MCP tokens were designed as task-scoped, with explicit revocation on completion — reasonable for single-task sessions.
2. **ACP session lifecycle**: The MCP connection is scoped to the ACP session (workspace lifetime), which outlives individual tasks. Bearer token injection happens once at session start with no refresh mechanism.
3. **2026-03-08**: During a live session, `get_instructions` and `complete_task` succeeded on first use, then all three tools failed permanently on subsequent attempts.

## Why It Wasn't Caught

1. **No test covered the multi-call lifecycle**: Existing tests verified individual tool calls in isolation. No test called `complete_task` followed by another tool call.
2. **Lifecycle mismatch not analyzed**: The token lifecycle (task-scoped) vs connection lifecycle (session-scoped) mismatch was not identified during design because single-task sessions worked fine.
3. **Silent failure mode**: The "Command failed with no output" error message from Claude Code's MCP client provided no diagnostic information about the underlying 401.

## Class of Bug

**Credential lifecycle mismatch**: A credential (MCP token) is scoped to a shorter lifecycle (task) than the connection that depends on it (ACP session), with no mechanism to refresh the credential when a new lifecycle begins.

This is a subclass of "resource lifecycle coupling errors" where two coupled resources have different lifetimes and the shorter-lived one's cleanup breaks the longer-lived one.

## Process Fix

Added rule to `.claude/rules/06-technical-patterns.md`: when implementing credential revocation or cleanup, verify that the credential's lifecycle matches the connection/session that uses it.

## Resolution

Removed the explicit token revocation from `handleCompleteTask()`. Token cleanup is now handled by:
1. KV TTL auto-expiration (default 4 hours, configurable via `MCP_TOKEN_TTL_SECONDS`)
2. Task-runner DO cleanup on failure path (`task-runner.ts:1129-1139`)

The tool handlers already validate task state independently (rejecting updates on completed tasks, rejecting duplicate completions), so a lingering token provides no meaningful privilege escalation.
