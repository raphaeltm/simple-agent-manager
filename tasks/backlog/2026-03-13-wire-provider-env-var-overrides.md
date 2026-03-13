# Wire Provider Env Var Overrides

**Created**: 2026-03-13
**Context**: Constitution validator review of PR #373

## Problem

Several provider-related constants have `DEFAULT_*` naming and JSDoc comments documenting env var overrides, but the override paths are not actually wired through the API layer:

1. `DEFAULT_HETZNER_DATACENTER` — `buildProviderConfig()` never reads `env.HETZNER_DATACENTER`
2. `DEFAULT_VM_LOCATION` — route files use the constant directly without checking an env var override
3. D1 schema has `.default('nbg1')` which cannot be overridden at runtime

## Acceptance Criteria

- [ ] Add `HETZNER_DATACENTER?: string` to the `Env` interface
- [ ] Wire `env.HETZNER_DATACENTER` through `buildProviderConfig` into `HetznerProviderConfig.datacenter`
- [ ] Add `DEFAULT_VM_LOCATION?: string` to the `Env` interface
- [ ] Update nodes.ts, workspaces/crud.ts, tasks/run.ts, tasks/submit.ts to check env override
- [ ] Document the SQL schema default as non-overridable
