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

## Design (sent to coordinator for go/no-go)

1. **Fake upstream = a gated route inside the API Worker**, `/ai/_test-upstream/*`, serving
   Anthropic `/v1/messages` and OpenAI `/chat/completions` (+ `/responses` if cheap), JSON and SSE,
   canned text, and a `usage` block sized so the catalog price of the requested model gives a
   configured USD per call (setting `aiProxy.testUpstreamCostPerCallUsd`). No new Worker, sidecar or
   deploy step: the box reaches it through its own public hostname, the staging gateway reaches it as
   a custom provider. Returns 404 unless the gate below is open.
2. **Routing**: when the gate is open, the upstream URL builders point at the fake:
   - no gateway (box): `https://api.${BASE_DOMAIN}/ai/_test-upstream/...` directly; the call then runs
     the real local pricing, `AiTokenBudgetCounter` write and `checkMonthlyCostCap`.
   - gateway (staging): `gateway.ai.cloudflare.com/.../{gw}/custom-sam-test-upstream/...` with
     `cf-aig-metadata` (as today) and `cf-aig-custom-cost` set from the model's catalog price, so the
     gateway logs real tokens and cost, and the real hourly cron and KV cap check run.
   - Upstream auth is never resolved or forwarded in test mode: no platform key or CF token leaves SAM
     towards the fake, and no provider is billed.
3. **Gate (fail closed, three locks)**:
   - deploy-time env `AI_TEST_UPSTREAM_ENABLED=true`, absent by default;
   - ignored whenever `ENVIRONMENT === 'production'` (canonical and fork production deploys both set
     it), and `sync-wrangler-config` refuses to emit it for a production stack;
   - runtime superadmin setting `aiProxy.testUpstreamEnabled` (default off), honoured only with the env
     flag; while on it applies to the whole installation, which on staging/the test box has only test
     users. Rule 74 tests: production-shaped Env + setting on -> real upstream and fake route 404.
4. **Scenarios**: box: admin ceiling $1, fake $0.40/call, calls 1-3 succeed, 4th -> 429 "Administrator
   monthly AI spending limit reached", spend visible in Settings > Usage. Staging: user cap $1 (admin
   ceiling does not apply with a gateway), 3 calls, wait for the hourly cron (no on-demand trigger
   exists), 4th -> 429 "Monthly cost cap exceeded", spend visible in admin AI usage.

## Implementation checklist

- [ ] Spike on staging: custom provider `custom-sam-test-upstream` + `cf-aig-custom-cost` -> logs API returns tokens and cost with userId metadata, for both Anthropic and OpenAI shapes (else fall back per design note)
- [ ] Gate helper + env/setting wiring + production refusal in sync-wrangler-config
- [ ] Fake upstream route (Anthropic + OpenAI, JSON + SSE, usage sized from catalog price)
- [ ] Upstream URL builders honour the gate; upstream auth skipped in test mode
- [ ] Staging custom provider created by the deploy pipeline (staging only), not by hand
- [ ] Tests: rule 74 divergence/convergence, real-route metering -> 429 on the 4th call (local), gateway URL/header shape
- [ ] Docs: staging verification reference + configuration reference
- [ ] Live proof: box and staging, evidence in PR

## Acceptance criteria

- [ ] A production-shaped Env cannot reach the fake (route 404, real upstream used) even with the setting on
- [ ] Box: 4th $0.40 call refused with 429 by the admin ceiling; spend shown in Settings > Usage
- [ ] Staging: after the cron, 4th call refused with 429 by the user cap; spend shown in admin AI usage
- [ ] No platform key or CF token sent to the fake
