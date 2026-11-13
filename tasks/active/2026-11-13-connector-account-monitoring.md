# Connector: reliable SAM account monitoring for external agents

Task: 01M7A6DFY9MR9E24V2M51MZBX2 (replaces cancelled 01M7A5XZVWEDB9QEFZYAGXP6JX).
Branch: `sam/raph-requests-research-implementation-1mzbx2`.

## Problem

An external agent connected through the SAM Connector (`/connect/mcp`) cannot monitor an account
reliably:

- `sam_profiles_list` shows model/effort/runtime but not which account a profile runs on.
- There is no usage/quota read with reset times and freshness; quota only appears inside
  `sam_team_status`, per credential, with no link to profiles and no stale/unknown semantics.
- `sam_chat_start` cannot override the model for one chat while keeping the profile's account.
- `sam_chats_list` returns the session lifecycle label (often a stale `active`) and no task state
  or parent; `sam_tasks_list` has no `parentTaskId`, `executionStep` or chat session id.

## Research findings

- Connector registers every operation from `packages/operations/src/registry.ts` in
  `apps/api/src/routes/connector-mcp.ts`. New operations must live in `packages/operations`
  (policy: one operation per capability, every surface calls it).
- Profile → account resolution exists only in the browser (`explainProfileAccount`,
  `apps/web/src/components/accounts/profile-account-resolution.ts`) over the shared pure resolver
  `explainResolution` (`packages/shared/src/composable-credentials/resolver.ts`). The resolver never
  reads secrets, so a server-side metadata-only snapshot (no decrypt) gives the same answer as the
  agent-key path (`getDecryptedAgentKey` → `resolveAgentKeyViaCC`, legacy fallback
  `resolveAgentKeyLegacy` when the user has no cc_* rows).
- Usage windows: `credential_limit_windows`, read through `listProjectCredentialLimits` /
  `listUserCredentialLimits` (`apps/api/src/services/credential-limit-events/read.ts`), keyed by the
  reference agent-key records (`cc_credentials:<id>`, `credentials:<id>`). Owner scoping is in SQL.
- Two stored credentials with byte-identical ciphertext are the same secret (dual-write mirrors;
  see `run-agent-credential.ts`), so they are one quota pool.
- REST submit already supports per-chat `model`/`effort` (`TaskAgentOverrideFields`,
  `resolveTaskAgentOverrides`); the Connector input simply does not expose them.
- Platform-resolved profiles never receive the raw platform credential (runtime.ts agent-key); their
  quota is installation-shared or the SAM AI proxy daily budget.

## Ranked gap inventory

1. Profile → account association (HIGH, requested) — implement.
2. Pool-aware remaining usage with reset times and freshness/unknown semantics (HIGH, requested) — implement `sam_usage_get`.
3. Per-chat model/effort override on `sam_chat_start` keeping profile/account (HIGH, requested) — implement.
4. Chat list shows stale lifecycle label without operational state or lineage (MEDIUM-HIGH) — implement task status/step/parent fields.
5. Task list lacks lineage (`parentTaskId`), `executionStep`, session link (MEDIUM) — implement.
6. No connector read of running compute (nodes/workspaces, cost) for an account (MEDIUM) — deferred; tracked as a note on idea `01M4GJ0W0DS5BTKBM1YW0X5YC8` (SAM Connector remaining work).
7. No push delivery to external agents (polling `sam_work_changes` exists) (LOW) — deferred; same idea note `01M4GJ0W0DS5BTKBM1YW0X5YC8`.

## Checklist

- [ ] API service: metadata-only profile account bindings (no decrypt), with legacy fallback and ciphertext-identity pools
- [ ] Operations port + shared usage pooling/freshness logic
- [ ] `sam_profiles_list`: `account` per profile (state, tier, poolId, name)
- [ ] `sam_usage_get`: pools with profiles, windows, freshness, exhausted/nextResetAt, SAM AI proxy budget when platform
- [ ] Admin setting `connector.usageStaleAfterMinutes`
- [ ] `sam_chat_start`: `model`, `effort` overrides passed through
- [ ] `sam_chats_list`: task status, execution step, parentTaskId per chat
- [ ] `sam_tasks_list`: parentTaskId, executionStep, chatSessionId
- [ ] Connector instructions mention new tools
- [ ] Tests: real SQLite for bindings (scoping, pools, legacy, halted, platform, no secrets), operations tests, chat_start override passthrough
- [ ] Docs: sam-connector guide, api reference, admin-settings

## Acceptance criteria

- Profiles sharing one stored credential report the same `poolId` and appear in one usage pool.
- No response contains tokens, ciphertext or IVs; only the caller's own credential names appear.
- Another member's credentials and pins never affect or appear in the caller's bindings.
- Usage windows say `fresh`, `stale` or `reset_since_sample`; a pool with no samples says `never_reported`.
- `sam_chat_start` with `model` runs that model with the chosen profile and does not modify the profile.
