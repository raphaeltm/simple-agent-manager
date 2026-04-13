# MCP Profile Tools Improvements

**Date**: 2026-04-13
**PR**: #679 (in progress, needs work)
**Branch**: `sam/add-mcp-tools-agent-01kp0h`

## Problem

PR #679 adds 5 MCP tools for agent profile CRUD but has several issues:
1. **17.3% code duplication** — SonarCloud flagged param extraction logic duplicated between create and update handlers
2. **Missing `devcontainerConfigName` field** — the `AgentProfile`, `CreateAgentProfileRequest`, and `UpdateAgentProfileRequest` types all include this field, but the MCP tools omit it from tool definitions, handlers, and get response
3. **Missing preflight evidence** — PR body lacks the required Agent Preflight block
4. **No staging verification or specialist reviews** performed

## Research Findings

- **Shared types** at `packages/shared/src/types/agent-settings.ts` define `AgentProfile` with 14 configurable fields including `devcontainerConfigName`
- **Service functions** in `apps/api/src/services/agent-profiles.ts` already handle all fields — MCP handlers just need to pass them through
- **Other MCP tools** (e.g., idea-tools) follow inline param extraction without shared helpers — but the profile tools have 13 identical param extractions duplicated between create and update
- **Existing pattern**: `handleCreateIdea` and `handleUpdateIdea` also duplicate param extraction but with fewer fields (3-4), making duplication less severe

## Implementation Checklist

- [ ] Extract shared param extraction helper to reduce duplication between create/update
- [ ] Add `devcontainerConfigName` to tool definitions (create and update schemas)
- [ ] Add `devcontainerConfigName` to handler param extraction (create and update)
- [ ] Add `devcontainerConfigName` to get handler response
- [ ] Update tests to cover `devcontainerConfigName` field
- [ ] Update test for create handler to verify shared extraction works
- [ ] Update PR body with full template including preflight evidence
- [ ] Run lint, typecheck, test, build
- [ ] Deploy to staging and verify
- [ ] Run specialist reviews

## Acceptance Criteria

- [ ] SonarCloud duplication drops below 3% threshold (or close to it)
- [ ] All 14 configurable `AgentProfile` fields are exposed via MCP tools
- [ ] All existing tests pass plus new tests for `devcontainerConfigName`
- [ ] PR body includes proper preflight evidence block
- [ ] Staging verification complete
- [ ] Specialist reviews addressed
