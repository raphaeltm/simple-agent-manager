# Remove `get_file_locks` MCP Tool

## Problem

The `get_file_locks` MCP tool is misleadingly named and functionally redundant. It does not implement any file-level locking — it simply queries active tasks in the same project and returns their branch names. This is identical to what `list_project_agents` already does. The name suggests a locking mechanism that doesn't exist, which could confuse agents.

Since each agent works in its own workspace on its own branch, actual file locking is unnecessary. The "check what other agents are doing" use case is already covered by `list_project_agents`.

## Research Findings

Files affected:
- `apps/api/src/routes/mcp/tool-definitions.ts` — tool definition (lines 558-567)
- `apps/api/src/routes/mcp/workspace-tools-direct.ts` — `handleGetFileLocks` implementation (lines 94-135)
- `apps/api/src/routes/mcp/index.ts` — import (line 66) and case handler (lines 218-219)
- `apps/api/src/routes/mcp/onboarding-tools.ts` — 6 references in onboarding guide text
- `apps/api/tests/unit/routes/mcp.test.ts` — tool list assertion (line 305) and tool count (38 → 37)

## Implementation Checklist

- [ ] Remove `get_file_locks` tool definition from `tool-definitions.ts`
- [ ] Remove `handleGetFileLocks` function from `workspace-tools-direct.ts`
- [ ] Remove import and case handler from `index.ts`
- [ ] Update onboarding guide text in `onboarding-tools.ts` — replace `get_file_locks` references with `list_project_agents`
- [ ] Update test assertion in `mcp.test.ts` — remove `get_file_locks` check and adjust tool count (38 → 37)
- [ ] Run lint, typecheck, test to confirm clean removal

## Acceptance Criteria

- [ ] `get_file_locks` tool no longer appears in MCP tool list
- [ ] `list_project_agents` still works and is referenced in onboarding guide for conflict checking
- [ ] All tests pass with updated tool count
- [ ] No dead code referencing `get_file_locks` remains
