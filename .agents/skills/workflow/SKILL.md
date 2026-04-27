---
name: workflow
description: "Orchestrate multi-step workflows by decomposing into subtasks, dispatching them, and monitoring via foreground polling loops. Prevents session timeout kills during long-running orchestration. Use when coordinating multiple agents or running multi-phase work that takes more than a few minutes."
---

# Workflow Orchestrator

Read the full workflow from `.codex/prompts/workflow.md` and execute it.

## Quick Summary

1. **Decompose** — break the user's request into discrete subtasks with dependencies
2. **Dispatch** — send subtasks to other agents via `dispatch_task` (with `/do` instructions)
3. **Poll** — foreground `sleep 300` + `get_task_details` loop keeps the session alive
4. **React** — dispatch dependent tasks as predecessors complete, retry failures
5. **Complete** — summarize results when all subtasks finish

## Why This Exists

When Claude Code dispatches subtasks and waits passively, the ACP session appears idle and the control plane kills it. This skill uses explicit foreground polling (Bash `sleep` + MCP tool calls) to maintain visible session activity throughout the orchestration.

## Staging Debugging Access

All agents have access to `$CF_TOKEN` for direct Cloudflare API queries against staging. When monitoring subtasks that deploy to staging, use the CF API to verify their work landed correctly — query D1 for data state, read KV for feature flags, check DNS for routing. See `.claude/rules/32-cf-api-debugging.md` for the full cheat sheet.

## State Persistence

Maintain `.workflow-state.md` (gitignored) as external memory. Re-read it before every poll cycle. This survives context compaction. See `.codex/prompts/workflow.md` for the full state file format.
