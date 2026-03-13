# Prefix Agent Initial Prompt with MCP get_instructions Instruction

**Created**: 2026-03-13
**Priority**: Medium
**Classification**: `business-logic-change`

## Problem

Agents launched via SAM task runner don't call `get_instructions` from the SAM MCP server before starting work. This means they miss critical context: task details, output branch name, project info, and progress reporting instructions. The MCP tool description says "You MUST call this tool before starting any work" but agents don't reliably read tool descriptions proactively.

## Solution

Prefix the initial prompt with a system instruction telling the agent to call `get_instructions` first.

## Tasklist

- [ ] Add instruction prefix to `initialPrompt` in `task-runner.ts:866`
- [ ] Add test verifying the prefix is present
- [ ] Run quality checks

## Key Files

| File | Change |
|------|--------|
| `apps/api/src/durable-objects/task-runner.ts` | Add instruction prefix to initialPrompt |
