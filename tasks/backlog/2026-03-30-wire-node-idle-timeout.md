# Wire nodeIdleTimeoutMs to NodeLifecycle DO

## Problem Statement

The `nodeIdleTimeoutMs` column exists on the projects table and is exposed in the Settings UI, but it is not consumed by any backend system. The NodeLifecycle DO's `getWarmTimeoutMs()` only reads the platform-wide `NODE_WARM_TIMEOUT_MS` env var.

This column predates the per-project scaling work and was documented as "stored for future use." The per-project scaling PR removed the comment but did not add consumption.

## Implementation

1. Pass `nodeIdleTimeoutMs` from the project through to the NodeLifecycle DO (similar to `warmNodeTimeoutMs`)
2. Use it as the idle timeout for nodes that are not in the warm pool (i.e., nodes with zero workspaces that haven't been marked warm)
3. Clarify the semantic distinction between "warm timeout" (warm pool lifetime) and "idle timeout" (how long before an idle node is stopped)

## Acceptance Criteria

- [ ] `nodeIdleTimeoutMs` value from the project is consumed by NodeLifecycle DO
- [ ] Setting a shorter idle timeout causes nodes to be stopped sooner
- [ ] Test verifies the override behavior
