# Idea updates timeline backend

SAM task 01M5NGB4QRDKWPF812P7N42DRW; spec idea 01M5NG5WNQAX5026M9SPV9PZE8; program idea 01M5NG3W2ZMDFD797SQF8DWNHR.

## Problem

Appending progress to an idea's description obscures the current plan and can exceed its size limit. Notes need a separate bounded timeline shared by people and agents.

## Research

`operations/idea-core.ts` holds the existing create/update semantics. `platform-operations.ts` is shared by connector and workspace MCP. `routes/mcp/idea-tools.ts` delegates to `workspace-adapter.ts`. The ProjectData DO stores per-project session relationships; `services/project-data.ts` wraps its RPCs. Runtime limits live in `admin-settings-registry.ts`. Web project routes use project capability checks.

## Checklist

- [x] Add ProjectData migration `068-idea-updates` and sibling SQL module.
- [x] Add shared operation for add, list, delete with project lookup, bounds, throttling, cursor and soft deletion.
- [x] Add REST, workspace MCP and connector MCP paths; preserve existing content update behavior.
- [x] Document agent note use and listing.
- [x] Complete real SQL and handler tests, including foreign project and deletion attack.
- [x] Run specialist reviews and lint/typecheck/build; isolated web and focused API suites pass. The full API run exposed stale count assertions, each corrected and rerun, plus one unrelated timeout whose focused route test passed.
- [x] Claim, deploy and verify staging; release claim. Run 40045283143 passed migration safety, deploy and smoke; live note CRUD preserved the draft description, and the test draft was deleted.
- [ ] PR #2427 is open and CodeRabbit approved. Pass CI/coordinator review, merge and watch production deploy.

## Acceptance

A member can post and list notes without changing the current plan. An agent can post through `update_idea(note)` and list with `list_idea_updates`. Foreign project IDs fail. A non-author non-admin cannot delete; delete is soft. An agent cannot flood a single idea. Responses page newest first. Public docs reflect the feature.
