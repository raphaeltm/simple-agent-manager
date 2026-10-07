# Enable GitHub trigger creation via MCP

## Problem
MCP create_trigger requires a cron expression and always persists cron, so agents cannot create approved GitHub automations.

## Research
- MCP trigger-create-tool.ts duplicates REST creation validation/persistence.
- REST triggers/crud.ts already validates CreateTriggerSchema and persists github_trigger_configs, but PATCH ignores githubConfig.
- schemas/triggers.ts defines the canonical GitHub event/filter shape.
- Workers mcp-trigger-tools.test.ts exercises real JSON-RPC dispatch, D1 persistence and scope boundaries.
- Existing cron clients omit sourceType; retain cron as the MCP default.

## Checklist
- [ ] Share canonical creation validation/persistence with REST, retain source-specific validation and atomic GitHub writes.
- [ ] Support MCP sourceType github and eventType/filters; exclude webhook/incident creation and secrets.
- [ ] Add GitHub config updates to MCP and REST with source-specific checks.
- [ ] Preserve project/profile scope and existing cron/resource callers.
- [ ] Add meaningful real-dispatch integration and regression tests.
- [ ] Update tool descriptions and docs.
- [ ] Run quality checks, completion/specialist review, staging, CI, CodeRabbit, merge and production verification.

## Acceptance
GitHub MCP creation works without cron, stores validated filters, returns no secrets, is project scoped and rejects foreign profiles. Source updates round-trip through REST/MCP. Legacy cron creates/updates remain functional. No webhook creation is introduced.

## References
apps/api/src/routes/mcp/trigger-create-tool.ts; apps/api/src/routes/mcp/tool-definitions-trigger-tools.ts; apps/api/src/routes/triggers/crud.ts; .claude/rules/25-review-merge-gate.md; apps/api/.claude/rules/32-cf-api-debugging.md.
