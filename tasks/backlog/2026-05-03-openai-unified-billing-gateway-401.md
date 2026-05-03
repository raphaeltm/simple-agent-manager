# OpenAI Unified Billing Returns 401 Through SAM AI Gateway

## Status: NOT A BUG — Fundamental Platform Limitation

Cloudflare AI Gateway unified billing only covers **Workers AI models** (Gemma,
Llama, Qwen, etc.) that run on Cloudflare infrastructure. External providers
(OpenAI, Google, Anthropic) always require their own API keys — the gateway is
a proxy for those providers, not a billing intermediary. The `cf-aig-authorization`
header authenticates to the gateway itself, NOT to the upstream provider.

This means "no API keys + OpenAI model" is not achievable through unified billing.
The options are:
1. **Use Workers AI models only** (Gemma 4, Llama 4, Qwen 3) — works today, no keys needed
2. **Provide an OpenAI API key** as a platform credential — SAM proxy forwards it upstream
3. **Use Anthropic models** with Cloudflare's Anthropic partnership billing (if available)

## Original Problem

SAM's AI proxy can route harness traffic through the configured Cloudflare AI
Gateway, but OpenAI unified-billing requests return 401 even after using the
documented OpenAI provider path.

## Context

Discovered during the 2026-05-03 harness gateway experiment on branch
`sam/summarize-work-done-yesterday-01kqpd`.

Working path:

- Harness CLI calls `https://api.sammy.party/ai/v1/chat/completions`.
- SAM AI proxy accepts the experiment MCP token.
- Workers AI model `@cf/google/gemma-4-26b-a4b-it` completes a real tool loop
  through the SAM Cloudflare AI Gateway.
- Also verified: `@cf/meta/llama-4-scout-17b-16e-instruct` and
  `@cf/qwen/qwen2.5-coder-32b-instruct` both complete tool loops successfully.

Failing path:

- Same harness/proxy path with `model: "gpt-4.1-mini"` reaches Cloudflare AI
  Gateway provider `openai`.
- Gateway logs show path `chat/completions`, status `401`, success `false`.
- A direct Gateway request with `cf-aig-authorization: Bearer $CF_TOKEN` also
  returns OpenAI's missing API key error.
- Staging D1 `platform_credentials` has no enabled Codex/OpenAI platform
  credential record; only a Claude key and Hetzner token were present at time of
  discovery.

## Root Cause

The 401 is **correct behavior**. OpenAI requires an OpenAI API key in the
`Authorization` header. Cloudflare AI Gateway passes through requests to external
providers but does not substitute billing credentials for them. Unified billing
is a Workers AI feature only.

## Acceptance Criteria

- [x] Confirm the Cloudflare account has AI Gateway unified-billing credits and
      the correct token type/permissions for provider requests without BYOK.
      **CONFIRMED: unified billing only covers Workers AI. External providers
      always need their own API keys.**
- [x] Decide whether OpenAI traffic should require unified billing only or
      support fallback to a stored Codex/OpenAI platform credential when
      unified billing is unavailable.
      **DECIDED: For no-key experiments, use Workers AI models. For OpenAI,
      a platform credential is required.**
- [ ] Add a live or integration verification path that proves
      `gpt-4.1-mini` (or the chosen small OpenAI model) completes through
      SAM `/ai/v1`, the SAM Cloudflare AI Gateway, and the harness tool loop.
      **DEFERRED: requires OpenAI API key as platform credential.**
- [x] Update `experiments/harness-sam-proxy/README.md` with the resolved
      OpenAI behavior.
