# OpenAI Unified Billing Returns 401 Through SAM AI Gateway

## Status: Gateway Authentication Misconfiguration

The `sam` AI Gateway has `authentication: false`. When authentication is
disabled, the gateway does NOT inject unified billing credentials into upstream
requests — it just proxies them through. External providers like OpenAI then see
no API key and return 401.

The `default` gateway has `authentication: true` and OpenAI models work through
it with unified billing (confirmed by a separate agent session after adding $10
AI Gateway credit to the account).

## Root Cause

The `sam` gateway needs `authentication: true` to enable unified billing for
external providers. With authentication enabled:
- The `cf-aig-authorization` header authenticates the request to the gateway
- The gateway uses the account's AI Gateway credits to pay for external
  provider calls (OpenAI, Anthropic, Google)
- No external API keys are needed

## Fix

1. Set `authentication: true` on the `sam` AI Gateway (via CF dashboard or API)
2. The `configure-ai-gateway.sh` script already defaults to
   `AI_GATEWAY_AUTHENTICATION=true`, but the deploy token lacks permission to
   modify gateway settings (HTTP 404 during deploy)

## Context

Discovered during the 2026-05-03 harness gateway experiment on branch
`sam/summarize-work-done-yesterday-01kqpd`.

Working path (Workers AI — works regardless of authentication setting):

- Harness CLI calls `https://api.sammy.party/ai/v1/chat/completions`.
- SAM AI proxy accepts the experiment MCP token.
- Workers AI models complete tool loops through the SAM AI Gateway.
- Verified: Gemma 4, Llama 4 Scout, Qwen 2.5 Coder.

Failing path (OpenAI — requires `authentication: true` on gateway):

- Same harness/proxy path with `model: "gpt-4.1-mini"` reaches the gateway.
- Gateway logs show status `401` because authentication is disabled.
- With authentication enabled (as on the `default` gateway), this works.

## Acceptance Criteria

- [x] Confirm the Cloudflare account has AI Gateway unified-billing credits.
      **CONFIRMED: $10 credit added to account.**
- [ ] Enable `authentication: true` on the `sam` AI Gateway.
      **BLOCKED: CF_TOKEN lacks AI Gateway modification permissions. Requires
      dashboard change or token permission update.**
- [ ] Verify `gpt-4.1-mini` completes through SAM `/ai/v1`, the SAM AI Gateway
      (with authentication enabled), and the harness tool loop.
- [ ] Fix deploy token permissions so `configure-ai-gateway.sh` can update the
      gateway during deploys.
- [x] Update `experiments/harness-sam-proxy/README.md` with findings.
