# Staging AI Proxy Model Test for OpenCode

Date: 2026-05-18  
Environment: staging (`https://app.sammy.party`, `https://api.sammy.party`)  
User: smoke-test primary user from `SAM_PLAYWRIGHT_PRIMARY_USER`

## Summary

Staging authentication works and the AI proxy is enabled at the Worker level (`AI_PROXY_ENABLED=true`). The admin AI proxy config endpoint returns the platform model catalog and reports Workers AI plus Anthropic models as available, but OpenAI models are not available because staging has no OpenAI platform credential and no Cloudflare AI Gateway Unified Billing token (`CF_AIG_TOKEN` is not bound).

OpenCode does not appear in the project chat agent selector for the authenticated smoke-test user. This matches the known bug/issue referenced in idea `01KPWKTVEWVYY5K44V3W3SQH8X`: `/api/agents` reports `opencode` as `configured=false` and `fallbackCredentialSource=null`, so the UI hides it even though the platform proxy is intended to support zero-config OpenCode.

Direct inference testing through `POST /ai/v1/chat/completions` could not be completed from the authenticated browser session because the endpoint requires a workspace callback JWT, not the user session cookie or smoke-test login token. A direct request without that callback token returns `401 Missing or invalid Authorization header`. The unauthenticated `GET /ai/v1/models` endpoint does list the allowed proxy models.

## Methodology

Read:

- `.claude/rules/13-staging-verification.md`
- `.claude/rules/33-staging-feature-validation.md`
- `apps/api/src/routes/ai-proxy.ts`
- `apps/api/src/routes/admin-ai-proxy.ts`
- `apps/api/src/routes/agents-catalog.ts`
- `apps/api/src/routes/workspaces/runtime.ts`
- `packages/shared/src/constants/ai-services.ts`

Live checks performed:

- `POST https://api.sammy.party/api/auth/token-login`
- `GET https://api.sammy.party/health`
- `GET https://api.sammy.party/api/admin/ai-proxy/config`
- `GET https://api.sammy.party/api/agents`
- `GET https://api.sammy.party/ai/v1/models`
- `POST https://api.sammy.party/ai/v1/chat/completions` without callback token, to confirm auth behavior
- Playwright browser validation against `https://app.sammy.party/projects/01KJNR9R3TEN3KX1ETE33852R8/chat`
- Cloudflare Worker settings read for `sam-api-staging` to confirm `AI_PROXY_ENABLED`, `AI_GATEWAY_ID`, `AI_PROXY_DEFAULT_MODEL`, and absence of `CF_AIG_TOKEN`

## Authentication

`POST /api/auth/token-login` succeeded with HTTP 200 and returned:

- `success: true`
- user email: `raphael+serverspresentation@ephemerecreative.ca`
- user name: `serverspresentation2025`

`GET /health` succeeded with HTTP 200:

```json
{"status":"healthy","timestamp":"2026-05-18T10:51:08.435Z"}
```

## AI Proxy Configuration

`GET /api/admin/ai-proxy/config` succeeded with HTTP 200.

Important values:

| Field | Value |
|---|---|
| `defaultModel` | `claude-haiku-4-5-20251001` |
| `source` | `admin` |
| `updatedAt` | `2026-04-21T01:08:41.481Z` |
| `hasAnthropicCredential` | `true` |
| `hasOpenAICredential` | `false` |
| `hasUnifiedBilling` | `false` |
| `billingMode` | `auto` |
| Worker `AI_PROXY_ENABLED` | `true` |
| Worker `AI_GATEWAY_ID` | `sam` |
| Worker `AI_PROXY_DEFAULT_MODEL` | `@cf/qwen/qwen3-30b-a3b-fp8` |
| Worker `CF_AIG_TOKEN` binding | absent |

`GET /ai/v1/models` returned the allowed proxy model list:

- `@cf/meta/llama-4-scout-17b-16e-instruct`
- `@cf/qwen/qwen3-30b-a3b-fp8`
- `@cf/qwen/qwen2.5-coder-32b-instruct`
- `@cf/google/gemma-4-26b-a4b-it`
- `@cf/google/gemma-3-12b-it`
- `claude-haiku-4-5-20251001`
- `claude-sonnet-4-6`
- `claude-opus-4-6`
- `gpt-4.1-mini`
- `gpt-4.1`
- `gpt-5.2`

## Model Results

Status meanings:

- `Listed / available`: model appears in the platform catalog and admin config marks it `available=true`.
- `Listed / unavailable`: model appears in the platform catalog, but admin config marks it `available=false`.
- `Not configured`: model is absent from the platform catalog and `/ai/v1/models`.
- `Inference not completed`: could not call `POST /ai/v1/chat/completions` with a valid staging workspace callback JWT from this authenticated browser validation session.

| Model | Provider | Catalog/admin status | Direct proxy inference status | Error details / notes |
|---|---|---:|---:|---|
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Workers AI | Listed / available | Inference not completed | Direct chat endpoint requires workspace callback JWT. |
| `@cf/qwen/qwen3-30b-a3b-fp8` | Workers AI | Listed / available | Inference not completed | Worker env default is this model, but admin KV default overrides it to Claude Haiku. |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | Workers AI | Listed / available | Inference not completed | Direct chat endpoint requires workspace callback JWT. |
| `@cf/google/gemma-4-26b-a4b-it` | Workers AI | Listed / available | Inference not completed | Direct chat endpoint requires workspace callback JWT. |
| `@cf/google/gemma-3-12b-it` | Workers AI | Listed / available | Inference not completed | Direct chat endpoint requires workspace callback JWT. |
| `claude-haiku-4-5-20251001` | Anthropic | Listed / available | Inference not completed | Admin default model. Anthropic platform credential is configured. |
| `claude-sonnet-4-6` | Anthropic | Listed / available | Inference not completed | Anthropic platform credential is configured. |
| `claude-opus-4-6` | Anthropic | Listed / available | Inference not completed | Anthropic platform credential is configured. |
| `gpt-4.1-mini` | OpenAI | Listed / unavailable | Expected to fail until configured | `hasOpenAICredential=false`, `hasUnifiedBilling=false`; endpoint cannot be tested past auth without callback JWT. |
| `gpt-4.1` | OpenAI | Listed / unavailable | Expected to fail until configured | Same OpenAI credential/Unified Billing blocker. |
| `gpt-5.2` | OpenAI | Listed / unavailable | Expected to fail until configured | Same OpenAI credential/Unified Billing blocker. |
| `gpt-5-mini` | OpenAI | Not configured | Not available | Absent from `PLATFORM_AI_MODELS` and absent from `/ai/v1/models`. |

Direct unauthenticated/user-session proxy call result:

```json
{
  "error": {
    "message": "Missing or invalid Authorization header",
    "type": "invalid_request_error"
  }
}
```

This is expected from `apps/api/src/routes/ai-proxy.ts`: `POST /ai/v1/chat/completions` authenticates only via `Authorization: Bearer <workspace callback token>`.

## Project Chat / OpenCode UI Result

Playwright validation loaded the staging dashboard and then opened:

`https://app.sammy.party/projects/01KJNR9R3TEN3KX1ETE33852R8/chat`

Observed chat composer state:

- Project: `CrewAI`
- Chat route loaded without console errors or failed API responses.
- Agent selector showed:
  - `Claude Code`
  - `OpenAI Codex`
  - `Mistral Vibe`
- Agent selector did not show `OpenCode`.
- Page text did not contain `OpenCode`.

This is a confirmed staging bug for the smoke-test user. OpenCode cannot be selected from project chat, so I could not submit an OpenCode task through the normal UI path.

## Agent Catalog Result

`GET /api/agents` returned:

| Agent | `configured` | `fallbackCredentialSource` |
|---|---:|---|
| `claude-code` | `true` | `null` |
| `openai-codex` | `true` | `null` |
| `google-gemini` | `false` | `null` |
| `mistral-vibe` | `true` | `null` |
| `opencode` | `false` | `null` |

OpenCode catalog entry:

```json
{
  "id": "opencode",
  "name": "OpenCode",
  "description": "Open-source AI coding agent by SST. Uses Scaleway Generative APIs for inference.",
  "supportsAcp": true,
  "configured": false,
  "credentialHelpUrl": "https://console.scaleway.com/iam/api-keys",
  "fallbackCredentialSource": null
}
```

The current catalog logic in `apps/api/src/routes/agents-catalog.ts` only marks an agent configured when the user has a dedicated agent credential or an agent-specific cloud-provider fallback credential. It does not account for platform AI proxy fallback availability.

## GPT-5-mini Availability

`gpt-5-mini` is not configured in the platform model catalog on staging or in the checked-in catalog:

- Absent from `PLATFORM_AI_MODELS` in `packages/shared/src/constants/ai-services.ts`
- Absent from `GET /api/admin/ai-proxy/config`
- Absent from `GET /ai/v1/models`

The catalog currently includes OpenAI models:

- `gpt-4.1-mini`
- `gpt-4.1`
- `gpt-5.2`

Even these OpenAI models are marked unavailable on staging because there is no Codex platform credential and no `CF_AIG_TOKEN`.

## Recommendations

1. Fix `/api/agents` so OpenCode is marked configured when the platform AI proxy is enabled and has at least one usable platform-backed model for OpenCode. For staging today, Workers AI and Anthropic are available; OpenCode should not depend only on a user Scaleway credential if the platform proxy is the intended fallback.

2. Add `gpt-5-mini` to `PLATFORM_AI_MODELS` if it should be selectable/defaultable. Include provider `openai`, an OpenAI unified model ID, costs, context window, scope, and tool-call metadata.

3. Configure staging OpenAI access before making any OpenAI model the default for platform OpenCode. Either add a Codex platform credential or bind `CF_AIG_TOKEN` for Cloudflare AI Gateway Unified Billing. Without that, `gpt-4.1-mini`, `gpt-4.1`, `gpt-5.2`, and any future `gpt-5-mini` entry will remain unavailable.

4. Do not make `gpt-5-mini` the default OpenCode model until both catalog and staging credential/Unified Billing configuration are present. The best default from the currently available staging config is `@cf/google/gemma-4-26b-a4b-it` for cost-conscious OpenCode agent work, with Claude Haiku as the available paid fallback if OpenCode supports the platform OpenAI-compatible route cleanly.

5. Add an admin/test-only way to mint or retrieve a short-lived workspace callback token for staging validation, or add a purpose-built AI proxy smoke-test endpoint that runs the same auth/routing path server-side. Without that, authenticated browser sessions can verify config and UI behavior but cannot directly exercise `POST /ai/v1/chat/completions` for each model.
