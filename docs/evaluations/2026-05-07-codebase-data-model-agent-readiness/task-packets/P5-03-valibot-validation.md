# P5-03: Add Valibot Validation to Mutation Routes

**Phase**: 5 (Architecture Documentation & Code Quality)
**Priority**: P1
**Risk Level**: Medium — modifies request handling across many routes
**Effort**: XL (3-5 days)
**Source Findings**: F-008, F-014 (Track 4: Coding Standards, Track 2: Data Model)
**Recommended Skill(s)**: `$cloudflare-specialist`

## Scope

~60% of mutation routes (POST/PUT/PATCH/DELETE) lack Valibot schema validation, relying on manual field checks or no validation at all. Add Valibot schemas and `validate()` middleware to all unprotected mutation routes.

Priority order (by risk):
1. Auth/credential routes — highest security impact
2. Task/workspace mutation routes — user-facing data integrity
3. Admin routes — lower priority but still needed
4. MCP tool input validation — agent-facing

## Files Likely Touched

- `apps/api/src/schemas/` — new Valibot schema files per domain
- `apps/api/src/routes/tasks/*.ts` — add validation middleware
- `apps/api/src/routes/projects/*.ts` — add validation middleware
- `apps/api/src/routes/workspaces/*.ts` — add validation middleware
- `apps/api/src/routes/credentials.ts` — add validation middleware
- `apps/api/src/routes/mcp/*.ts` — add input validation
- `apps/api/src/middleware/validate.ts` — shared validation middleware (if not already present)

## Compatibility Constraints

- Validation must reject invalid input with 400 errors — not silently coerce
- Existing valid requests must continue to work (no false rejections)
- Error response format must match existing API error contract
- Schema types should be exported for client-side reuse where applicable

## Automated Tests to Add/Run

- Test: each mutation route rejects invalid input with 400
- Test: each mutation route accepts valid input unchanged
- Test: error response includes field-level validation details
- `pnpm --filter @simple-agent-manager/api test`
- `pnpm lint && pnpm typecheck`

## Manual Staging Verification

- Deploy to staging, submit tasks, create projects, update settings — verify no false rejections
- Send malformed requests via curl — verify proper 400 responses

## Expected Post-Deploy State

- All mutation routes protected by Valibot validation
- Consistent 400 error responses for invalid input
- Shared schemas in `apps/api/src/schemas/`

## Visible Behavior Changes

- Previously silent invalid fields now return 400 errors
- Error responses include specific field validation messages

## Rollback Notes

- Revert validation middleware additions. No data migration.

## Acceptance Criteria

- [ ] All POST/PUT/PATCH/DELETE routes have Valibot schema validation
- [ ] Auth/credential routes validated first (highest priority)
- [ ] Shared schemas exported from `apps/api/src/schemas/`
- [ ] Validation errors return 400 with field-level details
- [ ] No false rejections for existing valid requests
- [ ] `pnpm --filter @simple-agent-manager/api test` passes
- [ ] `pnpm lint && pnpm typecheck` passes

## Links

- Track report: `tracks/04-coding-standards.md` (F01: Missing Valibot Validation)
- Track report: `tracks/02-data-model.md` (F-008: Schema Validation Gaps)
- Findings: F-008, F-014 in `findings-index.md`
