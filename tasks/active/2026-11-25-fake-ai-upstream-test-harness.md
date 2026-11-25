# Fake AI upstream test harness (platform-funded metering and spending ceilings)

Task: SAM 01M89E0MVWWBBXQH5XQ58R1RWG. Coordinator: 01M7XCE59V5X0WTNF1X3NFZP5J (channel `feature.selfhost-landing`).
Idea: 01M72M9AEB933ZY8269D376DKC (self-host landing plan, slice L13).

## Problem

Nobody has shown live that platform-funded ("sam" provider mode) model calls are metered and then
refused past the monthly ceiling, because the self-host test box has no platform AI key, and spending
real money on staging to prove a ceiling is wasteful. Raphaël (2026-11-25): "Can we setup a fake
testing harness that we can use to test without an AI key? ... we should do that on staging as well."

## Research findings (Phase 1 trace)

Entry points (both runtimes): `POST /ai/v1/chat/completions`, `POST /ai/v1/responses`
(`apps/api/src/routes/ai-proxy.ts:71,258`), `POST /ai/anthropic/v1/messages`
(`apps/api/src/routes/ai-proxy-anthropic.ts:69`). The workspace authenticates with its callback token
(`apps/api/src/services/ai-proxy-auth.ts:56-66`); `__platform_proxy__` is only the placeholder key the
agent-key callback hands out (`apps/api/src/routes/workspaces/runtime-agent-key.ts:379`).

Gate order: auth/enabled -> per-user RPM -> body -> model allowlist -> tier gate ->
`checkAiUsageGate` (`packages/ai-proxy/src/ai-token-budget.ts:460-481`: daily token budget, then
`checkMonthlyCostCap`) -> upstream auth (`ai-billing.ts:71-119`) -> forward -> accounting
(`attachTokenUsageAccounting`, `ai-token-usage-accounting.ts:82-123`).

The two runtimes meter cost DIFFERENTLY, chosen by `hasLocalAiCostMetering(env)` = "no AI Gateway"
(`packages/ai-proxy/src/ai-gateway-availability.ts:40-44`):

| | Hosted / staging (AI Gateway) | Self-host box (no gateway, `celld-config.ts:45` sets `AI_GATEWAY_ID: ''`) |
|---|---|---|
| Upstream URL | `gateway.ai.cloudflare.com/v1/{acct}/{gw}/anthropic/...` (`ai-proxy-shared.ts:71-78`, `routes/ai-proxy-upstream.ts:56-72`) | hard-coded `AI_PROVIDER_BASE_URLS` (`packages/shared/src/constants/ai-services.ts:3-6`), no override |
| Usage recorded | gateway logs (cost per entry), attributed by `cf-aig-metadata.userId`; hourly cron `runMonthlyCostAggregation` (`ai-monthly-cost-cron.ts:292-363`) sums into KV `ai-monthly-cost:{user}:{YYYY-MM}` | after each response: tokens x `PLATFORM_AI_MODELS` price (`ai-cost-pricing.ts:217-238`) -> `incrementProviderUsage` -> `AiTokenBudgetCounter` DO `ai_provider_usage.estimated_cost_usd` (`ai-token-usage-accounting.ts:250-290`) |
| Ceiling checked | `checkMonthlyCostCap` reads the KV cache; **user-set cap only**, admin ceiling ignored; fail-open until the cron has run (`ai-monthly-cost-cap.ts:172-190`) | `checkMonthlyCostCap` with `min(user cap, aiProxy.perUserMonthlyCostCeilingUsd)` over `getLocalMonthlyAiCostUsd`; fail-closed 503 (`ai-monthly-cost-cap.ts:156-170`) |
| Refusal | 429 `rate_limit_error`, `monthlyCost:{used,cap}` (`ai-proxy-admission.ts:135-164`); message from `monthlyCostCapMessage` | same; "Administrator monthly AI spending limit reached..." when the admin ceiling binds |
| Usage visible | `/api/admin/analytics/ai-usage` (gateway logs) and Settings > Usage | Settings > Usage (`/api/usage/ai`, `/api/usage/ai/budget`). Admin analytics returns zeros without a gateway (`admin-ai-usage.ts:55-70`) |

Other findings:
- The "installation ceiling" `aiProxy.perUserMonthlyCostCeilingUsd` is a per-user ceiling, not a total
  across users (`apps/api/src/services/ai-proxy-settings.ts:32`), and only applies without a gateway.
- The spend check runs before the call (`costUsd < capUsd`), so a call is admitted while spend is below
  the cap. With $0.30 calls and a $1 cap the 4th call is admitted at $0.90 and the 5th is refused. To
  see the 4th refused, use $0.40 calls (spend $1.20 after 3).
- No fake/mock AI upstream exists outside in-process `fetch` stubs and Miniflare `outboundService`
  hooks in tests (rule 59 search done).
- AI Gateway custom providers: `.../{gw}/custom-{slug}/{path}` -> `{base_url}/{path}`, base_url must be
  HTTPS (developers.cloudflare.com/ai-gateway/configuration/custom-providers/). Custom pricing per
  request via `cf-aig-custom-cost: {"per_token_in":..,"per_token_out":..}`
  (developers.cloudflare.com/ai-gateway/configuration/custom-costs/). Docs do NOT say the logs API
  returns cost/tokens for a custom provider, or parses Anthropic-shaped usage there: needs a spike.

## Design as built (coordinator-approved, with changes)

Coordinator answers (events d1e67baa, 876ce0f0, 585186e9): (b) NO installation-wide redirect: an explicit
allowlist of test user ids, empty = off; (a) hosted gaps reported, not fixed (idea
01M89FVN8N54G0676JXHZW2JQY); (c) the staging (AI Gateway custom provider) half is SPLIT into a follow-up
PR in this same task: `tasks/backlog/2026-11-25-fake-ai-upstream-staging-gateway.md`.

1. **In-process fake, no public route.** `services/ai-test-upstream.ts` `resolveAiTestUpstream` returns an
   `AiUpstreamFetch` (`fakeUpstreamFetch` -> `ai-test-upstream-responses.ts:buildFakeUpstreamResponse`)
   that the proxy routes call instead of `globalUpstreamFetch`. Anthropic Messages, OpenAI Chat and
   Responses, JSON and SSE, count_tokens; usage sized so the catalog price equals the configured cost.
   No platform key or CF token is sent (`testUpstreamAnthropicAuth`, `resolveOpenAIProxyCredential(..., testUpstream)`).
2. **Locks:** `AI_TEST_UPSTREAM_ENABLED === 'true'`; `ENVIRONMENT` in the allow-list
   staging/staging2/selfhost/development/test; no AI Gateway (`hasLocalAiCostMetering`); caller in
   `aiProxy.testUpstreamUserIds` (<= 50 ids). Cost: `aiProxy.testUpstreamCostPerCallCents` (default 40).
3. The production refusal is the runtime ENVIRONMENT allow-list, not a sync-wrangler-config guard: the
   Cloudflare pipeline never forwards the var (`getOptionalProcessEnvVars` does not list it).

## Implementation checklist (box half, PR #3009)

- [x] Gate helper + env (`Env.AI_TEST_UPSTREAM_ENABLED`, runtime-tunables bootstrap exception) + admin settings
- [x] Fake responses (Anthropic + OpenAI chat + Responses, JSON + SSE, count_tokens)
- [x] Proxy routes use the fake for allowlisted users; upstream auth not resolved/sent; limit telemetry skipped
- [x] Tests: Workers-runtime vertical slice (`tests/workers/ai-test-upstream-ceiling.test.ts`, 9 cases incl. non-listed user, production/unset/unmapped-env/flag locks, gateway); unit truth table + price round trip; every guard proven discriminating
- [x] Docs: configuration.md "Test-only fake AI upstream", agent testing reference, self-host README, .env.example
- [x] Live box proof on app.vmtest.sam2.party (below)
- [x] Hosted gaps filed as idea 01M89FVN8N54G0676JXHZW2JQY; UX findings idea 01M89JXTFHW4W3PQ65GTED6D0K; upgrader umask idea 01M89H1MQHJH432BFT2N43GHJJ
- [ ] Staging half: deferred to `tasks/backlog/2026-11-25-fake-ai-upstream-staging-gateway.md` (coordinator-approved split)

## Acceptance criteria

- [x] A production-shaped Env cannot reach the fake (production, unset, unmapped stack name, wrong flag) even for an allowlisted user
- [x] Box: metering per call and refusal by the admin ceiling (429 "Administrator monthly AI spending limit reached"); spend in Settings > Usage
- [x] A non-listed user on the same installation keeps the real upstream
- [x] No platform key or CF token sent (global fetch never called in the slice test)
- [ ] Staging: deferred (see backlog file)

## Box live proof (2026-11-25, channel feature.selfhost-landing seq 511)

Box upgraded to e4030e959 (after a self-inflicted umask incident, recovered by the documented path, see
seq 510/511), `AI_TEST_UPSTREAM_ENABLED` via `.state/secrets.env`, admin ceiling $1, agent-test listed at
40 cents, a real GCP node running a Claude Code chat in sam mode (model claude-opus-4-6):
reply "SAM test upstream: canned reply"; 4 calls in the first turn metered $0.40 each = $1.60 (calls 3
and 4 were concurrent, documented overshoot); the next prompt was refused with
"API Error: Request rejected (429) · Administrator monthly AI spending limit reached"; Settings > Usage
showed $1.60 / 4 requests / claude-opus-4-6. Cleanup: settings reset, node/profile/agent settings
deleted, flag `--unset`, box back on main bff4b944d, sealed, healthy, access removed. The exact
sequential "4th call refused" case is proven in the Workers-runtime test.
