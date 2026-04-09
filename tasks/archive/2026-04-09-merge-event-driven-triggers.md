# Merge Event-Driven Triggers Feature

## Problem
The event-driven triggers feature is complete across 4 sub-tasks on `feature/event-driven-triggers` but needs to be merged into main. There are merge conflicts in ~6 files due to concurrent changes on main (project file library removal, MCP tool definition refactoring).

## Research Findings
- Feature branch is 4 commits ahead of main
- 90 files changed, 8565 insertions, 6083 deletions
- Conflicts in: `schema.ts`, `index.ts`, `mcp/index.ts`, `mcp/tool-definitions.ts`, `mcp.test.ts`, `types/index.ts`
- Main had a project file library feature that was added and then removed — the feature branch still has removal artifacts
- MCP tool definitions were split into separate files on the feature branch but main consolidated them differently

## Implementation Checklist
- [ ] Rebase feature branch onto current main
- [ ] Resolve merge conflicts in schema.ts
- [ ] Resolve merge conflicts in api/index.ts
- [ ] Resolve merge conflicts in mcp/index.ts
- [ ] Resolve merge conflicts in mcp/tool-definitions.ts
- [ ] Resolve merge conflicts in mcp.test.ts
- [ ] Resolve merge conflicts in types/index.ts
- [ ] Run pnpm typecheck
- [ ] Run pnpm lint
- [ ] Run pnpm test
- [ ] Run pnpm build

## Acceptance Criteria
- [ ] Feature branch merges cleanly into main
- [ ] All quality checks pass (lint, typecheck, test, build)
- [ ] Trigger CRUD API works
- [ ] Trigger management UI works
- [ ] Trigger chat integration works
- [ ] MCP create_trigger tool works
- [ ] Cron sweep engine works
