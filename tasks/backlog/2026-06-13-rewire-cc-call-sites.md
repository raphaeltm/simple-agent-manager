# Rewire Credential Resolution Call Sites onto Composable-Credentials Resolver

## Problem Statement

The composable-credentials model (cc_credentials, cc_configurations, cc_attachments) is implemented and additive, but the existing credential resolution call sites still use the old paths:

- `getDecryptedAgentKey()` in `apps/api/src/routes/credentials.ts:671-755`
- `createProviderForUser()` in `apps/api/src/services/provider-credentials.ts:197-265`

These need to be rewired onto the unified cc resolver (`resolveAgentEnv` / `resolveComputeConfig`) to complete the composable-credentials feature.

## Context

Deferred from PR #1309 (composable-credentials implementation) because:
- The old paths are deeply integrated with AI proxy logic, GCP OIDC token exchange, and runtime.ts
- Rewiring risks breaking existing credentials for the primary staging user (who has a Claude Code oauth token)
- The cc model is additive — old paths still work alongside the new model

## Checklist

- [ ] Wire `getDecryptedAgentKey` to call `resolveAgentEnv` with fallback to old path
- [ ] Wire `createProviderForUser` to call `resolveComputeConfig` with fallback to old path
- [ ] Wire `agentAssembler` into `runtime.ts` opencode config path (E5 oracle parity)
- [ ] Add pre/post-backfill behavioral parity test (same fixture → same output from old and new resolvers)
- [ ] Add `ENCRYPTION_KEY` to `vitest.workers.config.ts` bindings for future resolver workers tests
- [ ] Run backfill on staging and verify existing credentials resolve identically

## Acceptance Criteria

- [ ] Existing call sites work identically pre- and post-backfill
- [ ] Old credential paths remain as fallback when cc_* tables have no data
- [ ] Rule 28 invariant preserved: inactive project attachment halts resolution
- [ ] E5 oracle parity: opencode config output matches gateway.go buildOpencodeConfig
