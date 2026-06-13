# Composable Credentials — Three-Primitive Implementation

## Problem Statement
The current credential system uses a single-table model (`credentials`) where secret, consumer binding, and scope are all flattened into one row. This prevents:
- Multiple credentials of the same kind per user
- Reusing one secret across multiple consumers (e.g., one OpenAI key for both Codex and OpenCode)
- Clear scope semantics (user-default vs project-override)

The composable-credentials model replaces this with three primitives:
- **Credential** — named, typed, agent-agnostic secret
- **Configuration** — consumer + credential ref + settings
- **Attachment** — binds a configuration into a scope

All design work is proven on `experiment/composable-credentials` (446/446 tests green).

## Research Findings

### Current Call Sites to Rewire
1. `getDecryptedAgentKey()` in `apps/api/src/routes/credentials.ts:671` — 3-tier resolution (project→user→platform) with Rule 28 inactive halt
2. `createProviderForUser()` in `apps/api/src/services/provider-credentials.ts:197` — 2-tier (user→platform) for compute providers
3. `resolveCredentialSource()` in `apps/api/src/services/provider-credentials.ts:275` — lightweight source check
4. Agent key endpoint: `apps/api/src/routes/workspaces/runtime.ts:248`
5. Node provisioning: `apps/api/src/services/nodes.ts` (3 call sites)
6. Deployment volumes: `apps/api/src/services/deployment-volumes.ts` (1 wrapper)

### Experiment Artifacts to Promote
- `packages/shared/src/experiments/composable-credentials/types.ts` → production types
- `packages/shared/src/experiments/composable-credentials/resolver.ts` → production resolver
- `packages/shared/src/experiments/composable-credentials/assemblers.ts` → production assemblers
- `packages/shared/src/experiments/composable-credentials/backfill.ts` → API backfill service

### E4 Prototype to Delete (Rule 37)
- `apps/web/src/pages/credentials-prototype/` (entire directory)
- Route + import in `apps/web/src/App.tsx`

### Migration Constraints (Rule 31)
- Latest migration: 0070. Next: 0071.
- NEVER DROP TABLE — `credentials` is a CASCADE parent
- New tables only: `cc_credentials`, `cc_configurations`, `cc_attachments`
- Carry `encrypted_token`/`iv` verbatim — do not re-encrypt

## Implementation Checklist

### Phase A: Promote Experiment Code to Production
- [ ] A1. Move types from `experiments/composable-credentials/types.ts` to `packages/shared/src/composable-credentials/types.ts`
- [ ] A2. Move resolver from `experiments/composable-credentials/resolver.ts` to `packages/shared/src/composable-credentials/resolver.ts`
- [ ] A3. Move assemblers from `experiments/composable-credentials/assemblers.ts` to `packages/shared/src/composable-credentials/assemblers.ts`
- [ ] A4. Export from `packages/shared/src/index.ts`
- [ ] A5. Update existing experiment tests to import from new locations

### Phase B: Database Migration
- [ ] B1. Create `0071_composable_credentials.sql` with three new tables (additive only)
- [ ] B2. Add Drizzle schema definitions for new tables in `apps/api/src/db/schema.ts`
- [ ] B3. Verify `pnpm quality:migration-safety` passes

### Phase C: Backfill Service
- [ ] C1. Create `apps/api/src/services/composable-credentials/backfill.ts` adapting experiment backfill
- [ ] C2. Create backfill API route (admin-only) for triggering migration
- [ ] C3. Write backfill tests with realistic state (Rule 35)

### Phase D: Unified Resolver Integration
- [ ] D1. Create `apps/api/src/services/composable-credentials/resolver.ts` that reads from new tables and calls shared resolver
- [ ] D2. Rewire `getDecryptedAgentKey()` to delegate to unified resolver
- [ ] D3. Rewire `createProviderForUser()` to delegate to unified resolver
- [ ] D4. Keep backward compat: old tables still work if new tables are empty (pre-backfill)
- [ ] D5. Write Rule 28 branch coverage tests: active-scoped / inactive-scoped-halts / user-fallback / no-row

### Phase E: Assembler Integration
- [ ] E1. Wire agent assembler into `runtime.ts` agent-key endpoint for opencode config
- [ ] E2. Verify parity with `gateway.go buildOpencodeConfig` (E5 oracle test)

### Phase F: API Routes (CRUD)
- [ ] F1. Create `apps/api/src/routes/composable-credentials/` with CRUD for credentials, configurations, attachments
- [ ] F2. Add proper auth (requireAuth + ownership validation)
- [ ] F3. Write integration tests for CRUD routes

### Phase G: UI
- [ ] G1. Delete E4 prototype (`apps/web/src/pages/credentials-prototype/`, route in App.tsx)
- [ ] G2. Build authed credentials management UI in Settings
- [ ] G3. Playwright visual audit mobile (375px) + desktop (1280px)

### Phase H: Quality Gates
- [ ] H1. `pnpm quality:migration-safety` passes
- [ ] H2. `pnpm typecheck` passes
- [ ] H3. `pnpm lint` passes
- [ ] H4. `pnpm test` passes
- [ ] H5. `pnpm build` passes

## Acceptance Criteria
- [ ] Three new tables created via additive migration (no DROP TABLE)
- [ ] Unified resolver reproduces existing behavior for all credential types
- [ ] Rule 28: inactive project attachment halts resolution (does NOT fall through)
- [ ] Existing call sites work identically pre- and post-backfill
- [ ] Opencode config assembly matches gateway.go parity
- [ ] E4 prototype deleted
- [ ] Real authed credentials UI works
- [ ] All quality gates pass locally

## References
- Idea: 01KV0AGSMP20SZP5CHX38G9M03
- Experiment branch: `experiment/composable-credentials`
- Rule 28: `.claude/rules/28-credential-resolution-fallback-tests.md`
- Rule 31: `.claude/rules/31-migration-safety.md`
- Rule 37: `.claude/rules/37-prototype-development.md`
