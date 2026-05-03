# OpenAI Unified Billing Returns 401 Through SAM AI Gateway

## Problem

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

Failing path:

- Same harness/proxy path with `model: "gpt-4.1-mini"` reaches Cloudflare AI
  Gateway provider `openai`.
- Gateway logs show path `chat/completions`, status `401`, success `false`.
- A direct Gateway request with `cf-aig-authorization: Bearer $CF_TOKEN` also
  returns OpenAI's missing API key error.
- Staging D1 `platform_credentials` has no enabled Codex/OpenAI platform
  credential record; only a Claude key and Hetzner token were present at time of
  discovery.

## Acceptance Criteria

- [ ] Confirm the Cloudflare account has AI Gateway unified-billing credits and
      the correct token type/permissions for provider requests without BYOK.
- [ ] Decide whether OpenAI traffic should require unified billing only or
      support fallback to a stored Codex/OpenAI platform credential when
      unified billing is unavailable.
- [ ] Add a live or integration verification path that proves
      `gpt-4.1-mini` (or the chosen small OpenAI model) completes through
      SAM `/ai/v1`, the SAM Cloudflare AI Gateway, and the harness tool loop.
- [ ] Update `experiments/harness-sam-proxy/README.md` with the resolved
      OpenAI behavior.
