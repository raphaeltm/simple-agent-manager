# Config Limits & Deploy Env Propagation Remediation

## Problem

A deep codebase review found that several configuration constants violate Constitution Principle XI (No Hardcoded Values) and that the deployment pipeline has an env var propagation gap:

1. **Deploy pipeline re-sync gap**: `deploy-reusable.yml` has two `sync-wrangler-config` steps — the initial sync passes 16 optional env vars (container/sandbox overrides), but the re-sync on first deploy passes only 3. First deploys silently lose operator-configured overrides.
2. **Docs-code mismatch**: `configuration.md` documents `NODE_LIFECYCLE_ALARM_RETRY_MS` and `MAX_NOTIFICATION_PAGE_SIZE` as configurable env vars, but both are compile-time constants with no actual env var resolution.
3. **Missing env overrides**: `WORKSPACE_IDLE_CHECK_INTERVAL_MS` has no env var override despite all sibling constants in the same file having them.
4. **Constants in wrong location**: `DEFAULT_CF_CONTAINER_*` constants are defined locally in `vm-agent-container.ts` instead of in the shared constants package.

## Research Findings

### Deploy Pipeline Gap (`deploy-reusable.yml`)

- **Initial sync** (lines 345-375): passes 16 optional env vars including `CF_CONTAINER_ENABLED`, `CF_CONTAINER_SLEEP_AFTER`, `CF_CONTAINER_PORT_READY_TIMEOUT_MS`, etc.
- **Re-sync on first deploy** (lines 660-676): passes ONLY `REQUIRE_APPROVAL`, `HETZNER_BASE_IMAGE`, `ARTIFACTS_BINDING_ENABLED` — all 16 optional vars missing
- Impact: first-ever deploy to a new environment silently loses container/sandbox configuration

### Hardcoded Constants Documented as Configurable

- `DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS` (`packages/shared/src/constants/node-pooling.ts:18`): JSDoc says only "Default alarm retry delay" — no "Override via" clause unlike all siblings. Not in `Env` interface.
- `MAX_NOTIFICATION_PAGE_SIZE` (`packages/shared/src/constants/notifications.ts:17`): compile-time `const = 100`, not in `Env` interface. `configuration.md` line 195 documents it as an env var.

### Missing Env Override

- `WORKSPACE_IDLE_CHECK_INTERVAL_MS` (`node-pooling.ts:49`): hardcoded at 5 minutes. Every sibling constant (lines 5-15, 24, 33) has an "Override via" JSDoc + env var resolution. This one does not.

### Constants in Wrong Location

- `DEFAULT_CF_CONTAINER_SLEEP_AFTER`, `DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS`, `DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS` are defined in `apps/api/src/durable-objects/vm-agent-container.ts:10-12` instead of `packages/shared/src/constants/`.

## Implementation Checklist

- [ ] **1. Fix deploy pipeline re-sync gap**: Add the 16 missing optional env vars to the re-sync step in `deploy-reusable.yml` to match the initial sync step
- [ ] **2. Make `DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS` env-configurable**: Add `NODE_LIFECYCLE_ALARM_RETRY_MS` to `Env` interface, add env var resolution at usage site(s), add "Override via" JSDoc
- [ ] **3. Make `MAX_NOTIFICATION_PAGE_SIZE` env-configurable**: Add to `Env` interface, add env var resolution at usage site(s), update JSDoc
- [ ] **4. Make `WORKSPACE_IDLE_CHECK_INTERVAL_MS` env-configurable**: Add `WORKSPACE_IDLE_CHECK_INTERVAL_MS` to `Env` interface, add "Override via" JSDoc, add env var resolution at usage site
- [ ] **5. Move CF container constants to shared package**: Move `DEFAULT_CF_CONTAINER_SLEEP_AFTER`, `DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS`, `DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS` from `vm-agent-container.ts` to `packages/shared/src/constants/`
- [ ] **6. Fix `configuration.md`**: Correct documented env vars to match actual behavior
- [ ] **7. Add tests**: Write unit tests verifying env var resolution for newly configurable constants
- [ ] **8. Verify build**: Run full `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

## Acceptance Criteria

- [ ] Deploy pipeline re-sync step forwards the same env vars as the initial sync step
- [ ] `NODE_LIFECYCLE_ALARM_RETRY_MS` is resolvable from env at runtime with fallback to `DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS`
- [ ] `MAX_NOTIFICATION_PAGE_SIZE` has env var resolution with fallback to compile-time default
- [ ] `WORKSPACE_IDLE_CHECK_INTERVAL_MS` has env var resolution matching its sibling constants
- [ ] CF container constants live in `packages/shared/src/constants/` and are imported from there
- [ ] `configuration.md` accurately reflects which env vars are actually configurable and where they apply
- [ ] All changes are backward-compatible (existing defaults unchanged)
- [ ] Tests verify env var override behavior for each newly configurable constant
- [ ] CI passes cleanly

## References

- Constitution Principle XI: `.specify/memory/constitution.md`
- Env interface: `apps/api/src/env.ts`
- Node pooling constants: `packages/shared/src/constants/node-pooling.ts`
- Notification constants: `packages/shared/src/constants/notifications.ts`
- CF container DO: `apps/api/src/durable-objects/vm-agent-container.ts`
- Deploy workflow: `.github/workflows/deploy-reusable.yml`
- Configuration docs: `apps/www/src/content/docs/docs/reference/configuration.md`
- Task ID: `01KYC73DQFH22WH4AF09R9861C`
- PR: #1677 (draft)
