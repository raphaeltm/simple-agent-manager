# MCP retry_subtask active agent stop post-mortem

## What Broke

`retry_subtask` could retry an active child task without stopping the actual node agent session first. The task row was marked failed and a replacement task was dispatched, but the old agent process could continue running on its node.

The user-visible failure mode is duplicate active agents for one logical child task retry: two agents can write to branches, mutate workspace state, and report progress while the task graph says the first attempt has already been stopped.

## Root Cause

The MCP retry implementation treated ProjectData session cleanup as equivalent to stopping the running agent:

- `apps/api/src/routes/mcp/orchestration-tools.ts` updated the task row to `failed`.
- It called `projectDataService.stopSession()` when a workspace chat session existed.
- It did not resolve the running `agent_sessions` row and did not call `stopAgentSessionOnNode()`.

The nearby `stop_subtask` path did perform a node-agent stop, but the retry path duplicated orchestration control logic instead of sharing the same stop invariant.

## Timeline

- The issue was introduced when MCP orchestration retry support added active-task retry behavior.
- The existing test named "should stop running child task before retrying" only asserted the retry response and replacement dispatch.
- On 2026-05-09, a random spot check of MCP orchestration tooling found that the test name described a stronger contract than the code or assertions enforced.

## Why It Wasn't Caught

The regression test was too shallow. It validated that retrying an active task returned success, but it did not assert the boundary call that actually stops the running agent on the node.

This is a mock-hidden integration failure: the route test mocked enough database state to let the replacement dispatch proceed, but it never modeled the node-agent control side effect as a required part of the contract.

## Class Of Bug

Agent lifecycle split-brain across boundaries. A control-plane state transition claimed an agent was stopped, but the worker/node runtime was not commanded to stop.

Any task, session, workspace, or agent lifecycle operation that replaces, cancels, retries, or marks work terminal can hit the same class of bug if it updates durable metadata without proving the runtime boundary received the corresponding stop/cancel/suspend command.

## Process Fix

Lifecycle tests must assert runtime-boundary side effects, not just database state or JSON responses. When a feature says an agent, workspace, or node is stopped/cancelled/retried/replaced, the regression test must prove the appropriate runtime command is invoked before the replacement or terminal state is accepted.

This PR updates `.claude/rules/02-quality-gates.md` with that requirement.
