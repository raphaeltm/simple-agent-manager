# OpenCode Aggressive Simplification — 3 User-Key Providers

**Date:** 2026-06-28
**Status:** Backlog
**Branch:** `opencode-aggressive-simplification`

## Problem Statement

OpenCode agent support carries a large amount of dead and duplicate provider
routing that nobody uses, and the UI for picking an OpenCode provider/model is
disconnected from the place where users actually add their OpenCode key. The net
result is that OpenCode does not practically work for a user with their own key —
they "can't find the UI" to choose Zen vs Go vs custom, and the backend carries
five provider paths (`platform`, `scaleway`, `google-vertex`, `anthropic`,
`opencode-managed` alias) plus a dead `opencode_provider_name` column that add
risk without value.

Goal (user, explicit, approved): **OpenCode actually working with user keys.**
Aggressively reduce OpenCode to **3 user-key providers**:

- `opencode-zen` (default) — OpenCode Zen endpoint
- `opencode-go` — OpenCode Go endpoint
- `custom` — bring-your-own OpenAI-compatible endpoint (needs baseURL + key)

"For now let's ignore routing through the platform proxy unless it's very simple
to do." Platform-proxy routing for OpenCode is removed entirely.

## Ground Truth (verified)

- User-key Zen/Go need **ONLY** `OPENCODE_API_KEY` env var + a model string.
  `opencode/<model>` → Zen endpoint; `opencode-go/<model>` → Go endpoint. Both are
  OpenCode built-in providers; OpenCode's own registry does namespace→endpoint
  routing. No provider block, baseURL, or apiKey override is needed for Zen/Go.
- `custom` is the only target provider that needs a baseURL + `OPENCODE_API_KEY`.
- CLI pin: `opencode-ai@1.17.8`.
- Upstream provider ID for Zen is `opencode` (SAM's internal label `opencode-zen`).
- DEFAULT_OPENCODE_PROVIDER stays `opencode-zen`.

## Research Findings

### Blast radius (~65 files via grep on opencodeProvider / OPENCODE_ / managed / platform-opencode)

Production code touched across all 4 layers:
- `packages/shared/src/types/agent-settings.ts` (+ re-exports in `types/index.ts`)
- `packages/vm-agent/internal/acp/gateway.go`
- `packages/vm-agent/internal/acp/session_host_startup.go`
- `apps/api/src/routes/workspaces/runtime.ts`
- `apps/api/src/routes/agent-settings.ts`
- `apps/api/src/schemas/agent-settings.ts`
- `apps/api/src/db/schema.ts` (+ new migration `0078`)
- `apps/web/src/components/AgentSettingsCard.tsx`
- `apps/web/src/components/ConnectFlow.tsx`

Tests to update: vm-agent `gateway_test.go`, `session_host_test.go`; apps/api
`agent-settings.test`, `opencode-credential-fallback.test`,
`runtime-always-proxy.test`, `composable-credentials-routes.test`; packages/shared
`agent-settings.test`, harness-capabilities tests +
`__snapshots__/harness-capabilities-assembly-snapshot.test.ts.snap`; apps/web
`agent-settings-card.test.tsx`, `agent-card.test.tsx`, playwright specs
(`agent-settings-audit`, `settings-credentials-audit`,
`light-mode-settings-cluster-audit`).

### CRITICAL scope protection (do NOT touch)

The OpenCodeProvider union (`agent-settings.ts`) is a **separate concept** from
the composable-credentials `ProviderDialect` / `SecretKind` (`openai-compatible`,
`anthropic`). The composable-credentials `openai-compatible` / `anthropic` are the
NEW credential system (z.ai, custom OpenAI-compatible endpoints, DeepSeek) and are
**in-use**. Scope item 5 ("merge openai-compatible into custom") applies **ONLY**
to the `OpenCodeProvider` union member, NOT the credential dialect. Same for
`provider-presets.ts` (`dialect: 'openai-compatible'`/`'anthropic'`) — **out of
scope**.

### runtime.ts simplification cascade

After removing the platform/scaleway opencode paths,
`opencodeRequiresDedicatedCredential = body.agentType === 'opencode'` (always true
for opencode). OpenCode therefore always returns at the BYO-credential branch
(cred → apiKey, or 404 with `opencode_byo_provider_missing_credential`) and NEVER
reaches the proxy-eligible block. This makes the opencode platform branch
(currently ~886-894, logging `opencode_zen_missing_credential`) **dead code** —
remove it.

### opencode_provider_name is dead end-to-end

`opencode_provider_name` is written/read only by schema.ts, the agent-settings
route (save + response + default), runtime.ts agent-settings response, shared
types, and the UI Provider Name input. It is **never** read by the vm-agent and
**never** used in composable-credentials assembly. Safe to drop.

### Migration

Latest existing migration = `0077_deployment_publish_jobs.sql`. New migration =
`0078_drop_opencode_provider_name.sql`:
`ALTER TABLE agent_settings DROP COLUMN opencode_provider_name;` (column drop, not
a table drop; not a CASCADE concern; safe per rule 31).

## Implementation Checklist

1. **Remove `opencode-managed` alias (all 4 layers)**
   - [ ] `packages/shared/src/types/agent-settings.ts`: drop union member, remove
     `OPENCODE_MANAGED_PROVIDER_ALIAS`, remove its registry entry + alias line in
     `resolveOpenCodeProvider`.
   - [ ] `packages/shared/src/types/index.ts`: remove `OPENCODE_MANAGED_PROVIDER_ALIAS` re-export.
   - [ ] `gateway.go` `normalizeOpencodeProvider` + `buildOpencodeConfig`: drop managed.
   - [ ] `session_host_startup.go` `credentialEnvVarName`: drop managed.
   - [ ] `AgentSettingsCard.tsx` `openCodeModelProviderFilter`: drop `opencode-managed`.

2. **Remove `platform` OpenCode path**
   - [ ] `gateway.go`: delete platform case + `opencodeConfigOverrides`
     PlatformBaseURL/PlatformAPIKey fields.
   - [ ] `session_host_startup.go`: remove `configureOpenCodePlatformSettings`,
     opencode platform tails in inject*ProxyCredential, overrides method/param.
   - [ ] `runtime.ts`: simplify `opencodeRequiresDedicatedCredential` →
     `body.agentType === 'opencode'`; always `getDecryptedAgentKey`; remove the
     dead opencode platform branch (~886-894).

3. **Remove `scaleway` OpenCode path**
   - [ ] `gateway.go`: delete scaleway case + env switch; remove
     `DefaultScalewayBaseURL` if now dead.
   - [ ] `session_host_startup.go` `credentialEnvVarName`: drop scaleway.
   - [ ] `runtime.ts`: reduce scaleway fallback carve-out to
     `agentDef?.fallbackCloudProvider`.

4. **Remove `google-vertex` + `anthropic` OpenCode paths**
   - [ ] `gateway.go`: delete cases + env switch cases; remove
     `DefaultGoogleVertexBaseURL` if dead.
   - [ ] `session_host_startup.go` `credentialEnvVarName`: drop anthropic/google-vertex.

5. **Merge `openai-compatible` → `custom` (OpenCodeProvider union ONLY)**
   - [ ] `agent-settings.ts` types: collapse to single `custom` option.
   - [ ] `gateway.go` `buildOpencodeConfig`: merge openai-compatible → custom;
     `opencodeProviderNeedsNpmPackage` → custom only.
   - [ ] `AgentSettingsCard.tsx`: `showBaseUrl = selectedProvider === 'custom'`.
   - [ ] Do NOT touch composable-credentials/provider-presets dialect.

6. **Remove dead `opencode_provider_name` column**
   - [ ] `schema.ts`: remove column + update comment.
   - [ ] New migration `0078_drop_opencode_provider_name.sql`.
   - [ ] `runtime.ts`: remove `opencodeProviderName` from agent-settings response.
   - [ ] `agent-settings.ts` route: remove from values, response, defaults.
   - [ ] `schemas/agent-settings.ts`: remove field.
   - [ ] shared types `AgentSettingsResponse` + `SaveAgentSettingsRequest`: remove.
   - [ ] `AgentSettingsCard.tsx`: remove Provider Name input + all related state.

7. **Final OPENCODE_PROVIDER_OPTIONS = [opencode-zen (default), opencode-go, custom]**
   - [ ] `agent-settings.ts` types: set the options array; keep
     DEFAULT_OPENCODE_PROVIDER = `opencode-zen`.

8. **UI consolidation**
   - [ ] Surface OpenCode provider + model selection in the SAME flow as key entry
     (ConnectFlow when agent = opencode), so users adding an OpenCode key see/set
     Zen/Go/custom + model.
   - [ ] Fix empty `""` default select value so persisted state matches displayed
     state.

## Acceptance Criteria

- [ ] An OpenCode user can add their key and pick Zen or Go **in one place**.
- [ ] Workspace boots with **only** `OPENCODE_API_KEY` + the right model namespace
      for Zen/Go (verified on a real provisioned VM — vm-agent touched ⇒ Phase 6b).
- [ ] `custom` still works with baseURL + `OPENCODE_API_KEY`.
- [ ] `opencode-managed`, `platform`, `scaleway`, `google-vertex`, `anthropic`
      OpenCode paths and the `opencode_provider_name` column are gone.
- [ ] composable-credentials `openai-compatible`/`anthropic` dialects untouched and
      still passing their tests.
- [ ] Playwright visual audit passes (apps/web touched), mobile + desktop.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.

## References

- `.claude/rules/06-api-patterns.md`, `24-no-duplicate-ui-controls.md`,
  `06-technical-patterns.md` (UI→backend data path), `31-migration-safety.md`,
  `17-ui-visual-testing.md`, `13-staging-verification.md`,
  `02-quality-gates.md` (infra verification for vm-agent changes).
