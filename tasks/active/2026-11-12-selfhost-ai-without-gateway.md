# Self-hosted AI features without Cloudflare AI Gateway / Workers AI (overnight B3)

## Problem

On a self-hosted (celld) install SAM has no AI Gateway and no Workers AI binding. Task titles are
always truncated, the SAM-managed AI proxy (`sam` provider mode and the BYO passthrough) is forced
off, the monthly AI cost cap and cost views have no data source, and voice input / server
read-aloud are hidden. Research: idea 01M75V57RG8GR4NA0KC91TM1J7, notes "AREA A (AI)" parts 1-6.

Coordinator overrides (task 01M76JCEHVRDNYMNGN7A5Q944Q): branch from `sam/selfhost-pass-2`, draft
PR into it, never merge; no deploys; local tests only; self-host behaviour behind
`platform-capabilities.ts`; skip CodeRabbit and the Playwright audit (listed under "Before main").

## Research findings

- `scripts/selfhost/celld-config.ts` `SELFHOST_VAR_OVERRIDES` forces `TASK_TITLE_GENERATION_ENABLED`,
  `AI_PROXY_ENABLED` and `TTS_ENABLED` to `'false'`.
- `task-title.ts` checks `enabled` before the endpoint; the endpoint path and truncation fallback exist.
- Proxy kill switch `AI_PROXY_ENABLED` is read in 7 places (admission, anthropic x2, passthrough
  prepare, agent-key, agents-catalog, platform-trial). Every upstream builder already has a
  no-gateway branch (direct provider URLs, platform key via billing mode `auto`).
- agent-key with the proxy off: the fall-through returns the raw key with no base URL, so a
  Claude/Codex credential that names a custom base URL is sent to the vendor default URL
  (confirmed by code reading, `routes/workspaces/runtime.ts` fall-through).
- Monthly cap: `isMonthlyCostCapAvailable` needs a gateway; `checkMonthlyCostCap` reads a KV cache
  written by the gateway-log cron. `AiTokenBudgetCounter` DO already stores per-day
  `estimated_cost_usd` per provider; the platform Anthropic route records no provider row.
  `PLATFORM_AI_MODELS` has per-1k prices.
- Speech: `/api/transcribe` and `/api/tts/synthesize` call `env.AI.run` only; capabilities
  `speechToText`/`textToSpeech` derive from the binding.

## Checklist

- [ ] A3a: drop the title override; README; test (endpoint title + truncation fallback, celld config)
- [ ] A1: admin setting `aiProxy.directUpstreamEnabled` (default off); one shared resolver for every
      proxy gate; drop `AI_PROXY_ENABLED` override; agent-key custom-base-URL fail-closed with proxy off
- [ ] A1 tests: proxy route with gateway unset (setting on → direct upstream; off → refused);
      Cloudflare control; budgets/allowlist/RPM still apply; agent-key base-URL test
- [ ] A2: local cost metering (catalog price × usage) when no gateway; cap reads local month total;
      capability `monthlyCostCap` true without gateway; tests (cap reached → 429; Cloudflare control)
- [ ] A2b: per-model/per-day views (if time)
- [ ] A4: speech-to-text endpoint settings + route + capability; tests
- [ ] A5: text-to-speech endpoint settings + route + capability; tests
- [ ] A3b: classifier on LLM endpoint (only if time)
- [ ] Docs: deploy/selfhost/README.md, public docs where behaviour changed
- [ ] security-auditor on proxy + settings; fix CRITICAL/HIGH
- [ ] Draft PR with "How to enable and test on the box"

## Acceptance criteria

- Titles are generated through the configured endpoint on self-host; truncated when none.
- With the admin setting on and no gateway, `sam` mode proxies straight to the provider with all
  admission checks; with it off the proxy refuses; Cloudflare unchanged.
- Without a gateway the monthly cap is enforced from SAM's own metering; 429 `monthly-cost-cap`.
- With speech endpoints set, capabilities resolve true and the routes round-trip through them.
