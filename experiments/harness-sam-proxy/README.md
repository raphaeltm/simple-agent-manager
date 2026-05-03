# Harness Through SAM AI Proxy

**Date:** 2026-05-03

This experiment wires the Go harness to SAM's existing OpenAI-compatible AI
proxy at `/ai/v1/chat/completions`. The goal is to exercise the harness through
the same SAM Cloudflare AI Gateway path used by workspace agents, not a direct
or default gateway URL.

## Current Shape

The harness CLI now supports:

```bash
go run ./cmd/harness \
  --provider openai-proxy \
  --base-url "${SAM_API_URL}/ai/v1" \
  --api-key "$SAM_AI_PROXY_TOKEN" \
  --model "@cf/google/gemma-4-26b-a4b-it" \
  --tool-choice auto \
  --dir ./testdata/fixture-repo \
  --prompt "Use the read_file tool to read README.md, then summarize what this fixture project contains."
```

The same proxy path can be used for a small OpenAI model:

```bash
--model "gpt-4.1-mini"
```

## Proxy Contract

- `--base-url` points at SAM's OpenAI-compatible proxy, usually
  `https://api.${SAM_BASE_DOMAIN}/ai/v1` or `${SAM_API_URL}/ai/v1`.
- `--api-key` must be a workspace callback token for the current workspace.
- Workers AI models such as `@cf/google/gemma-4-26b-a4b-it` route through SAM's
  configured `AI_GATEWAY_ID` using the Workers AI gateway path.
- OpenAI models such as `gpt-4.1-mini` route through the same SAM proxy and use
  Unified Billing when `CF_AIG_TOKEN` or `CF_API_TOKEN` is configured upstream.

## Experiment Auth Option

The current production proxy auth contract is a workspace callback token. For
local harness experiments, this branch adds an explicit opt-in flag:

```bash
AI_PROXY_ACCEPT_MCP_TOKEN_FOR_HARNESS=true
```

When enabled, `apps/api/src/services/ai-proxy-shared.ts:verifyAIProxyAuth()`
falls back from callback-token verification to `validateMcpToken()`. That maps
the task MCP token to the same `userId`, `workspaceId`, and `projectId` metadata
shape used by callback tokens. The flag defaults off.

This keeps the provider routing unchanged while making the current workspace's
`SAM_MCP_TOKEN` usable for harness experiments after the branch is deployed to
an environment with the flag enabled.

## Result So Far

The harness provider and proxy request/response mapping work in local tests.

Live run attempted with `SAM_MCP_TOKEN`:

```text
Agent completed in 1 turns (reason: error)
agent error: turn 1: LLM error: proxy returned 401: {"error":{"message":"Invalid or expired token","type":"invalid_request_error"}}
```

That confirms the harness reaches SAM's `/ai/v1/chat/completions` route, but
`SAM_MCP_TOKEN` is not accepted by the currently deployed proxy. The next live
step is to deploy this branch with `AI_PROXY_ACCEPT_MCP_TOKEN_FOR_HARNESS=true`
or inject the same callback token that VM agents use for OpenAI proxy fallback.

## Notes

`apps/api/wrangler.toml` already sets `SAM_MODEL` to
`@cf/google/gemma-4-26b-a4b-it`. This branch adds the same model to the AI proxy
model registry so harness experiments can select it through `/ai/v1`.
