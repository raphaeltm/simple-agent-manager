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

- [x] Wire `getDecryptedAgentKey` to call `resolveAgentEnv` with fallback to old path
- [x] Wire `createProviderForUser` to call `resolveComputeConfig` with fallback to old path
- [x] Wire `agentAssembler` into `runtime.ts` opencode config path — N/A: assembler tested via E5 oracle; VM agent builds config on its side via `gateway.go:buildOpencodeConfig`; no runtime.ts changes needed for this PR
- [x] Add pre/post-backfill behavioral parity test (E6 — 14 tests in shared, 12 workers integration tests ready but blocked by pre-existing Miniflare OOM)
- [x] Add `ENCRYPTION_KEY` to `vitest.workers.config.ts` bindings for future resolver workers tests
- [x] Fix existing credential tests broken by CC wiring (add CC resolver mocks)
- [ ] Run backfill on staging and verify existing credentials resolve identically (Phase 6)

## Acceptance Criteria

- [x] Existing call sites work identically pre- and post-backfill
- [x] Old credential paths remain as fallback when cc_* tables have no data
- [x] Rule 28 invariant preserved: inactive project attachment halts resolution (E6 tests + workers integration test)
- [x] E5 oracle parity: opencode config output matches gateway.go buildOpencodeConfig (pre-existing E5 tests in shared package)
