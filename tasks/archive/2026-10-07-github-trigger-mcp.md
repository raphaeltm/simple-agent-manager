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
- [x] Share canonical creation validation/persistence with REST, retain source-specific validation and atomic GitHub writes.
- [x] Support MCP sourceType github and eventType/filters; exclude webhook/incident creation and secrets.
- [x] Add GitHub config updates to MCP and REST with source-specific checks.
- [x] Preserve project/profile scope and existing cron/resource callers.
- [x] Add meaningful real-dispatch integration and regression tests.
- [x] Update tool descriptions and docs.
- [ ] Run quality checks, completion/specialist review, staging, CI, CodeRabbit, merge and production verification.

## Acceptance
GitHub MCP creation works without cron, stores validated filters, returns no secrets, is project scoped and rejects foreign profiles. Source updates round-trip through REST/MCP. Legacy cron creates/updates remain functional. No webhook creation is introduced.

## References
apps/api/src/routes/mcp/trigger-create-tool.ts; apps/api/src/routes/mcp/tool-definitions-trigger-tools.ts; apps/api/src/routes/triggers/crud.ts; .claude/rules/25-review-merge-gate.md; apps/api/.claude/rules/32-cf-api-debugging.md.

## Verification
66 focused unit/integration tests and 8 real Worker MCP dispatch tests passed. Full root lint/typecheck/test/build passed. Local specialist reviews passed; documentation finding corrected (canonical github.* template variables). Staging/PR/merge/deploy remain tracked in PR and .do-state.md. Existing SAM isolated branch reused; task-only push to main rejected by GH013 required Workers check, so task record included in feature PR.

### CodeRabbit follow-up

Removed root input-schema union for MCP client compatibility while retaining source-specific server validation. Separated strict replacement validation from tolerant stored-filter reads and existence checks, permitting malformed-filter repair through REST/MCP. Added repair/read/metadata regression cases. Extracted shared creation validation to reduce Sonar complexity. Follow-up Cloudflare/security and completion reviews passed.
