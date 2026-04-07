# MCP Tool: get_repo_setup_guide

## Problem

A conversation on 2026-04-07 (session 0407d9cd) designed and partially implemented a new MCP tool called `get_repo_setup_guide` that returns a comprehensive SAM Environment Briefing document. The workspace died before the code could be committed. The tool needs to be recreated and deployed.

## Context

The tool returns a markdown document ("SAM Environment Briefing & Repo Preparation") that:
- Part 1: Teaches agents about their SAM environment (env vars, ephemeral reality, MCP tools, workflow patterns)
- Part 2: Instructs agents to analyze the repo and weave SAM-aware guidance into existing agent config files

This is a zero-argument tool — it simply returns the briefing markdown when called.

## Research Findings

- MCP tool handlers live in `apps/api/src/routes/mcp/`
- Tool definitions are in `tool-definitions.ts` (MCP_TOOLS array)
- Tool dispatch is in `index.ts` (switch statement in `tools/call` handler)
- Pattern to follow: each tool has a handler function in a separate file, exported and imported in index.ts
- The handler returns `JsonRpcResponse` using `jsonRpcSuccess()` from `_helpers.ts`
- The full markdown content was captured in the session messages

## Implementation Checklist

- [ ] Create `apps/api/src/routes/mcp/onboarding-tools.ts` with the SAM Environment Briefing constant and `handleGetRepoSetupGuide()` handler
- [ ] Add `get_repo_setup_guide` tool definition to `tool-definitions.ts`
- [ ] Wire handler into `index.ts` switch statement
- [ ] Run typecheck to verify
- [ ] Add integration test for the new tool

## Acceptance Criteria

- [ ] Calling `get_repo_setup_guide` via MCP returns the full SAM Environment Briefing markdown
- [ ] Tool appears in `tools/list` response
- [ ] Tool requires no arguments
- [ ] Typecheck passes
- [ ] Integration test verifies the tool returns expected content
