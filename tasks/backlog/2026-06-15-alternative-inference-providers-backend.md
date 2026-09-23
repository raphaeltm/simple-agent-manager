# Alternative Inference Provider Support — Backend-First (via SAM Proxy)

## Goal
Let users bring **alternative / third-party inference providers** to SAM agents.
The world has more inference providers than the defaults SAM ships with, and many
expose **OpenAI-compatible OR Anthropic-compatible** endpoints. The valuable
capability is decoupling *harness* from *inference backend*: e.g. run **Mistral**
(the French provider) inference under **Claude Code, Codex, or opencode** even
though a dedicated `mistral-vibe` harness exists; integrate **Cohere North**
models where useful; and generally support any compliant third-party endpoint.

This is **not** about any specific vendor or region — it is general support for
alternative inference providers, so that a new provider is a small data change,
not a code change.

The composable-credentials (CC) system removed the structural blocker: the
`openai-compatible` credential kind (`{ apiKey, baseUrl }`) already models these
providers, is storable via CC CRUD, resolvable via the tiered resolver, and
assembled for opencode.

This task delivers the **backend** so credentials can be stored, resolved, and
injected for all agents — before any provider-picker UI is built.

## Key Decision (settled with Raphaël 2026-06-15)
**Route alternative-provider traffic through SAM's existing passthrough proxy
(Option A), NOT direct baseURL/credential injection into the workspace.**

Two reasons given:
1. **Avoid injecting more credentials into the workspace** — the provider key
   stays in the control plane; the workspace only ever sees a `__platform_proxy__`
   / wstoken-scoped proxy URL.
2. **Cross-provider usage/cost analytics** — because all traffic stays metered
   through the proxy, SAM can aggregate per-provider usage and tell users "these
   sessions cost you X on provider A vs Y on provider B," helping them find best
   value. This is the user-facing payoff that justifies the proxy approach.

Implication: the actual baseURL injected into the workspace remains the SAM
proxy. The **provider's** baseURL is carried by the credential and consumed by
the **proxy upstream forwarder**, not by the agent env. The assembler/dialect
work must be proxy-aware.

## Research Findings (verified, with code paths)
- **CC models the providers already**: `CredentialKind` includes
  `'openai-compatible'`; `CredentialSecret` for it = `{ apiKey, baseUrl }`;
  `ConfigurationSettings` has `model?`, `baseUrl?`, `providerName?`
  (`packages/shared/src/composable-credentials/types.ts`). Comments reference a
  third-party openai-compatible endpoint — alternative providers were a design
  target.
- **CC CRUD already stores them**: `POST /api/credentials` validates
  `kind: 'openai-compatible'` and inserts credential/configuration/attachment
  rows (`apps/api/src/routes/composable-credentials.ts:55`). Backend can store
  alternative-provider credentials today with no UI.
- **Snapshot parses raw-or-JSON tokens** with per-row resilience
  (`apps/api/src/services/composable-credentials/snapshot.ts:parseSecret`,
  Rule 41).
- **Resolver is tiered + Rule 28 inactive-halt**
  (`packages/shared/src/composable-credentials/resolver.ts`).
- **Assembler emits baseUrl ONLY for opencode** today
  (`packages/shared/src/composable-credentials/assemblers.ts:70-91`). claude-code
  / codex get bare keys via `API_KEY_ENV` (lines 137-144). Gap.
- **`mapResolvedToLegacy` DROPS baseUrl** for openai-compatible (returns
  `credential = secret.apiKey; credentialKind = 'api-key'`,
  `apps/api/src/routes/credentials.ts:~752-780`). Gap.
- **inferenceConfig.baseURL is proxy-only**: when a user has their own credential
  it always points at `https://api.${baseDomain}/ai/proxy/{wstoken}/anthropic`
  (claude-code) or `/openai/v1` (codex/opencode); proxy upstream is hardcoded to
  Anthropic/OpenAI (`apps/api/src/routes/workspaces/runtime.ts:373-503`). This is
  exactly the mechanism Option A extends.
- **VM agent already supports an arbitrary Anthropic base URL**:
  `appendAnthropicProxyEnv` / `ANTHROPIC_BASE_URL` + auth token
  (`packages/vm-agent/internal/acp/session_host_startup.go:213-280`). No VM-agent
  change needed for the injection itself.
- **Model catalog has no openai-compatible/alternative-provider entries**
  (`packages/shared/src/model-catalog.ts`). Gap.

## The Core Architectural Problem: No Common Harness Interface

There is **no single source of truth** for "which harness works with which env
vars / base-URL convention / proxy route." That knowledge is currently
duplicated across **three** layers, each encoding a slice of it with its own
hardcoded agent-type conditionals:

| Layer | File | What it encodes | Shape today |
|-------|------|-----------------|-------------|
| **1. CC assembler** | `packages/shared/src/composable-credentials/assemblers.ts` | env-var *names* per agent (`API_KEY_ENV`, `OAUTH_ENV`); opencode custom-provider config | `switch (secret.kind)` + per-agent name maps. **No dialect, no base-URL routing.** `openai-compatible` case is **opencode-only** — claude-code/codex with a custom base URL are not handled. |
| **2. agent-key endpoint** | `apps/api/src/routes/workspaces/runtime.ts:373-503` | proxy route + `inferenceConfig {provider, baseURL, model, apiKeySource}` | Hand-written `if (isClaudeCode) … else if (isCodex) … else …` ladder. Duplicates agent knowledge from Layer 1. **Not fed by the assembler** — uses legacy `mapResolvedToLegacy`. |
| **3. VM agent** | `packages/vm-agent/internal/acp/session_host_startup.go:213-280` | final env injection per `(agentType, provider)` pair | One branch per pair: `claude-code + anthropic-passthrough → appendAnthropicProxyEnv(ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY)`, `openai-codex + openai-passthrough → OPENAI_BASE_URL/OPENAI_API_KEY`, etc. |

Adding providers naively means adding new conditionals to **all three** layers —
the "patchwork of off-the-shelf implementations" outcome we explicitly want to
avoid. The dialect↔harness↔proxy mapping must become **declared data**, not
branching logic scattered across three boundaries.

### Why this is the right anchor (not gold-plating)

- **It already wants to exist.** Three layers independently re-derive the same
  agent-type facts. A registry is the de-duplication of knowledge that is
  *already* present, not a speculative abstraction (Constitution: no premature
  abstraction — but three concrete duplications justify one).
- **It collapses N×M branching to N+M data.** Without it, every new provider ×
  every harness is a potential new branch in each layer. With it, a new provider
  is a *preset row* (dialect tag) and a new harness is *one descriptor row*.
- **It is the natural seam for the analytics payoff.** The descriptor's `dialect`
  + the preset's `providerId` are exactly the dimensions item 6 meters on. One
  source of truth for "what provider/dialect is this traffic" feeds both
  injection and metering.
- **It makes the proxy decision (Option A) enforceable in one place.** "Provider
  key never enters the workspace; only a proxy URL does" becomes an invariant the
  registry-driven assembler guarantees, instead of a property you have to re-check
  in three hand-written branches.

## Implementation Checklist (approved order — backend before UI)

### 0. Harness capability registry (FOUNDATIONAL — build first)

Create one declarative table that every downstream layer derives from. All later
items (1, 3, 5, 6) consume this instead of re-encoding agent-type knowledge.

**0a. Define the descriptor type** in `packages/shared/src/harness-capabilities.ts`:

```ts
/** API wire dialect a harness speaks to its model backend. */
export type Dialect = 'anthropic' | 'openai-compatible' | 'gemini' | 'native';

/** How the harness expects its credential to be presented. */
export type AuthStyle = 'api-key' | 'bearer-token' | 'auth-json';

export interface HarnessCapability {
  /** Agent type id (matches AGENT_CATALOG ids). */
  agentType: string;
  /** Dialects this harness can speak. First entry is the preferred/native one. */
  dialects: Dialect[];
  /** Env var the harness reads its model base URL from (undefined = not overridable). */
  baseUrlEnvVar?: string;        // e.g. 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'
  /** Env var the harness reads its credential from. */
  authEnvVar: string;            // e.g. 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'
  /** Whether the auth value is a bearer token or a raw key (affects header build). */
  authStyle: AuthStyle;
  /** Does this harness consume an opencode-style provider config JSON instead of env? */
  usesOpencodeConfig?: boolean;
  /** Proxy route segment under /ai/proxy/{wstoken}/ for this dialect. */
  proxyRouteSegment: string;     // e.g. 'anthropic', 'openai/v1'
  /** inferenceConfig.provider tag the VM agent switches on. */
  proxyProviderTag: string;      // e.g. 'anthropic-passthrough', 'openai-passthrough'
}
```

**0b. Populate `HARNESS_CAPABILITIES`** for every agent in `AGENT_CATALOG`
(claude-code, openai-codex, google-gemini, mistral-vibe, opencode, amp). Capture
exactly what the three layers encode today so the registry is a faithful refactor
target, e.g.:
- `claude-code` → dialects `['anthropic']`, baseUrlEnvVar `ANTHROPIC_BASE_URL`,
  authEnvVar `ANTHROPIC_AUTH_TOKEN` (proxy) / `ANTHROPIC_API_KEY` (passthrough),
  proxyRouteSegment `anthropic`, proxyProviderTag `anthropic-passthrough`.
- `openai-codex` → dialects `['openai-compatible']`, baseUrlEnvVar
  `OPENAI_BASE_URL`, authEnvVar `OPENAI_API_KEY`, proxyRouteSegment `openai/v1`,
  proxyProviderTag `openai-passthrough`.
- `opencode` → `usesOpencodeConfig: true`, dialects
  `['openai-compatible','anthropic']`, authEnvVar `OPENCODE_API_KEY`.
- etc. — **derive each row from the current code, do not invent values.** This
  is a "capture present behavior as data" step; behavior must be byte-identical
  after the refactor.

**0c. Add a dialect-compatibility resolver helper** (pure):
```ts
/** Given a harness + a provider preset's dialect, return the descriptor slice
 *  to use, or null if the harness cannot speak that dialect. */
export function resolveHarnessDialect(
  agentType: string,
  providerDialect: Dialect,
): HarnessCapability | null;
```
This is the single gate that answers "can harness X use provider Y?" — used by
the assembler, the inferenceConfig builder, and (later) the UI to grey out
incompatible combinations.

**0d. Tests**: every `AGENT_CATALOG` id has exactly one capability row;
`resolveHarnessDialect` returns the right descriptor for compatible pairs and
`null` for incompatible ones (e.g. claude-code + a pure-openai-only provider when
no anthropic dialect exists); enum values are valid; no duplicate agentType rows.

**0e. Refactor the three layers to consume the registry (no behavior change):**
- Assembler `API_KEY_ENV`/`OAUTH_ENV` maps → read `authEnvVar` from the registry.
- `runtime.ts` `if/else` ladder → look up `proxyRouteSegment` + `proxyProviderTag`
  from the registry to build `inferenceConfig`.
- VM agent `session_host_startup.go` per-pair branches → drive `ANTHROPIC_BASE_URL`
  vs `OPENAI_BASE_URL` selection from a Go mirror of the descriptor (or from the
  `inferenceConfig.provider` tag, which now comes from the registry). Keep the Go
  change minimal: the goal is that adding a provider needs **zero** new Go
  branches, because the dialect is already encoded in the descriptor-derived tag.
- **This refactor must be behavior-preserving** — land it with the existing
  agents' env output asserted byte-identical (snapshot the current
  `EnvInjection` / `inferenceConfig` for each agent before and after).

### 1. Provider preset catalog (shared, pure data) — depends on 0a (Dialect type)
- [ ] Add `packages/shared/src/provider-presets.ts` exporting
  `PROVIDER_PRESETS`: `{ id, label, dialect: Dialect, baseUrl,
  suggestedModels: string[] }[]` for a representative set of alternative
  providers (e.g. Mistral, Cohere North, and other OpenAI-/Anthropic-compatible
  endpoints). `dialect` reuses the registry's `Dialect` type so presets and
  harnesses speak the same vocabulary. baseURLs must be HTTPS, no hardcoded
  secrets. The list is intentionally open-ended — adding a provider later is a
  one-row change.
- [ ] Export from `packages/shared/src/index.ts`.
- [ ] Unit tests: shape, dialect enum, HTTPS baseURLs, unique ids,
  every preset dialect is one a real harness can speak (cross-check against
  `HARNESS_CAPABILITIES`).

### 2. Model-catalog entries — decision-independent
- [ ] Add the providers' suggested models to
  `packages/shared/src/model-catalog.ts` (keyed appropriately for
  openai-compatible consumers).
- [ ] Unit tests.

### 3. Assembler dialect mapping (registry-driven, proxy-aware) — pure
- [ ] Replace the opencode-only `openai-compatible` branch with a
  registry-driven path: given the resolved credential's provider dialect + the
  consumer agent, use `resolveHarnessDialect()` to pick env-var names and config
  shape. With Option A the injected baseURL is the **SAM proxy URL** (from the
  registry's `proxyRouteSegment`), not the provider — the provider baseUrl is
  carried separately for the forwarder (item 5).
- [ ] Unit tests per dialect, asserting (a) correct env-var names, (b) injected
  baseURL is the proxy URL not the provider, (c) provider key absent from env for
  proxy-routed harnesses.

### 4. Capability / vertical-slice test (Rule 35)
- [ ] Seed CC rows across project/user/platform tiers → resolver → assembler;
  assert per-dialect injection and that the provider key never lands in the
  workspace env (only the proxy URL does). Cover at least one anthropic-dialect
  and one openai-dialect alternative provider.

### 5. Proxy upstream forwarding (core Option-A work)
- [ ] Extend the SAM passthrough proxy (`/ai/proxy/{wstoken}/anthropic`,
  `/ai/proxy/{wstoken}/openai/v1`) to forward to the **arbitrary upstream
  baseURL carried by the resolved credential** instead of the hardcoded
  Anthropic/OpenAI host. Resolve the credential server-side from the wstoken →
  workspace → user/project scope. Use the registry's `authStyle` to build the
  correct upstream auth header per dialect.
- [ ] Surface the credential baseUrl into the agent-key `inferenceConfig`
  response (`runtime.ts`) and **fix `mapResolvedToLegacy` dropping baseUrl**
  (`credentials.ts`) so the resolved provider endpoint is available to the proxy
  forwarder path.
- [ ] Write-path validation: HTTPS baseUrl required; dialect required for
  openai-compatible credentials; dialect must be one the chosen harness can speak
  (`resolveHarnessDialect` non-null).
- [ ] Cross-boundary contract test (Rule 23): proxy forwards to the right
  upstream with the right auth header per dialect.
- [ ] Credential-resolution fallback tests (Rule 28): active project → active
  user → platform → null, inactive-project-halts.

### 6. Cross-provider usage/cost analytics (the user-value payoff)
- [ ] Ensure proxy-forwarded requests are metered with a `provider` dimension
  (provider id + dialect, sourced from the resolved preset/registry) so usage
  rows are attributable per provider.
- [ ] Aggregation query/endpoint: per-user usage + estimated cost grouped by
  provider for comparable session types.
- [ ] Tests for the aggregation (multi-provider seed → correct per-provider
  rollups).
- [ ] (UI surface for the comparison is deferred to the UX task below.)

## Acceptance Criteria
- [ ] One registry (`HARNESS_CAPABILITIES`) is the single source of truth for
  harness↔dialect↔env-var↔proxy mapping; the assembler, agent-key endpoint, and
  VM agent all derive from it (no duplicated agent-type conditionals).
- [ ] The registry refactor is behavior-preserving for existing agents
  (before/after env output identical).
- [ ] An alternative-provider `openai-compatible` credential (both OpenAI- and
  Anthropic-dialect) can be stored, resolved across all three tiers, and results
  in working agent traffic via the SAM proxy.
- [ ] The provider API key NEVER appears in workspace env — only a wstoken-scoped
  proxy URL does.
- [ ] Proxy forwards to the provider's real endpoint with the correct dialect
  auth header.
- [ ] Adding a new provider requires only a preset row (and possibly a model-
  catalog row) — **zero** new conditionals in the assembler, endpoint, or VM agent.
- [ ] Usage is metered per provider; an aggregation surface returns per-provider
  cost comparison for a user.
- [ ] All resolver/assembler/proxy paths covered by behavioral + vertical-slice
  tests; no source-contract tests on credential code.

## Follow-up (UI — AFTER this backend lands)
- Provider presets in the Connect flow (`tasks/archive/2026-06-15-composable-credentials-ux.md`);
  the Connect flow uses `resolveHarnessDialect()` to grey out incompatible
  harness×provider combinations.
- Cross-provider cost-comparison UI on the usage dashboard.

## References
- CC types/resolver/assembler: `packages/shared/src/composable-credentials/`
- API resolve/snapshot: `apps/api/src/services/composable-credentials/`
- agent-key + legacy mapping: `apps/api/src/routes/credentials.ts`
- inferenceConfig / proxy URL build: `apps/api/src/routes/workspaces/runtime.ts:373-503`
- VM agent base URL injection (per-pair branches): `packages/vm-agent/internal/acp/session_host_startup.go:213-280`
- CC CRUD: `apps/api/src/routes/composable-credentials.ts`
- Agent catalog: `packages/shared/src/agents.ts` (`AGENT_CATALOG`)
- Model catalog: `packages/shared/src/model-catalog.ts`
- Rules: 23 (contract), 28 (resolution fallback), 35 (vertical slice), 41 (snapshot resilience)
