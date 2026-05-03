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
  unified billing when the AI Gateway has `authentication: true` and the account
  has AI Gateway credits. The `sam` gateway currently has `authentication: false`
  — see `tasks/backlog/2026-05-03-openai-unified-billing-gateway-401.md`.

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
The branch was deployed to staging on 2026-05-03 using GitHub Actions runs
`25275790396` and `25276086390`.

Because the current workspace's `SAM_MCP_TOKEN` belongs to the production
control-plane KV, staging did not initially recognize it. For this experiment,
the token was seeded into staging `sam-staging-sessions` KV with a one-hour TTL
using the `mcp:<token>` key shape consumed by
`apps/api/src/services/mcp-auth.ts:validateMcpToken()`.

### Gemma 4 Through SAM Proxy

Live staging command:

```text
go run ./cmd/harness \
  --provider openai-proxy \
  --base-url "https://api.sammy.party/ai/v1" \
  --api-key "$SAM_MCP_TOKEN" \
  --model "@cf/google/gemma-4-26b-a4b-it" \
  --tool-choice auto \
  --max-turns 5 \
  --dir ./testdata/fixture-repo \
  --transcript ../../.codex/tmp/harness-experiments/gemma4-staging-auto-transcript.json \
  --prompt "Use the read_file tool to read README.md, then summarize what this fixture project contains. Do not answer until you have read the file."
```

Result:

```text
Agent completed in 2 turns (reason: complete)
Final message: This fixture project is a minimal test repository designed specifically for the SAM harness evaluation tests.
Transcript written to ../../.codex/tmp/harness-experiments/gemma4-staging-auto-transcript.json (6 events)
```

After the OpenAI Gateway URL fix and redeploy, the same Gemma experiment still
passed:

```text
Agent completed in 2 turns (reason: complete)
Final message: This fixture project is a minimal test repository designed for use with the SAM harness evaluation tests.
Transcript written to ../../.codex/tmp/harness-experiments/gemma4-staging-auto-after-openai-url-fix.json (6 events)
```

Transcript shape:

- Turn 1 called the real harness `read_file` tool with `{ "path": "README.md" }`.
- The harness returned the fixture README content.
- Turn 2 returned the final model answer with no additional tool calls.

This proves the current prototype path:

```text
harness CLI
  -> SAM /ai/v1/chat/completions
  -> SAM AI proxy auth + model routing
  -> Cloudflare AI Gateway Workers AI path
  -> @cf/google/gemma-4-26b-a4b-it
  -> OpenAI-compatible tool call response
  -> harness tool execution
  -> final model response
```

Running the same Gemma prompt with `--tool-choice required` also reached the
model and executed `read_file`, but it repeated the tool call until `max_turns`.
For harness experiments that need a final answer, use `--tool-choice auto`.

### Small OpenAI Model Through SAM Proxy

Live staging command used the same harness/proxy/auth path with
`--model "gpt-4.1-mini"`.

Result:

```text
Agent completed in 1 turns (reason: error)
agent error: turn 1: LLM error: proxy returned 401: {"error":{"message":"AI inference failed (401). Please try again.","type":"server_error"}}
```

Cloudflare AI Gateway logs confirm this request reached the configured SAM
gateway as provider `openai`, model `gpt-4.1-mini`, path
`v1/chat/completions`, status `401`, success `false`.

Cloudflare's current OpenAI provider docs show the Gateway path as
`/openai/chat/completions`, not `/openai/v1/chat/completions`. This branch fixed
`apps/api/src/routes/ai-proxy.ts:buildOpenAIUrl()` and added unit coverage in
`apps/api/tests/unit/routes/ai-proxy.test.ts`. After redeploy, the same harness
experiment still returned 401, but Gateway logs now show provider `openai`,
model `gpt-4.1-mini`, path `chat/completions`, status `401`, success `false`.

Direct Gateway isolation with the same Cloudflare token also returned 401:

```text
POST https://gateway.ai.cloudflare.com/v1/$CF_ACCOUNT_ID/sam/openai/chat/completions
cf-aig-authorization: Bearer $CF_TOKEN

{
  "error": {
    "message": "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth ..."
  }
}
```

**Root cause:** The `sam` AI Gateway has `authentication: false`. When
authentication is disabled, the gateway does NOT inject unified billing
credentials for external providers — it just proxies the request through, so
OpenAI sees no API key.

The `default` gateway has `authentication: true` and OpenAI unified billing
works through it (confirmed in a separate session after adding $10 AI Gateway
credit). The fix is to enable `authentication: true` on the `sam` gateway.

See `tasks/backlog/2026-05-03-openai-unified-billing-gateway-401.md`.

## Notes

`apps/api/wrangler.toml` already sets `SAM_MODEL` to
`@cf/google/gemma-4-26b-a4b-it`. This branch adds the same model to the AI proxy
model registry so harness experiments can select it through `/ai/v1`.

Production `/ai/v1/models` did not list Gemma 4 before this branch. Staging did
list it after deployment.

### Additional Workers AI Models Tested

After confirming Gemma 4 works, two more Workers AI models were tested through
the same harness → SAM proxy → SAM AI Gateway path:

**Llama 4 Scout:**
```text
./harness --provider openai-proxy --base-url "https://api.sammy.party/ai/v1" \
  --api-key "$TOKEN" --model "@cf/meta/llama-4-scout-17b-16e-instruct" \
  --tool-choice auto --max-turns 5 --dir ./testdata/fixture-repo \
  --prompt "Use the read_file tool to read README.md, then summarize."

Agent completed in 2 turns (reason: complete)
```

**Qwen 2.5 Coder:**
```text
./harness --provider openai-proxy --base-url "https://api.sammy.party/ai/v1" \
  --api-key "$TOKEN" --model "@cf/qwen/qwen2.5-coder-32b-instruct" \
  --tool-choice auto --max-turns 5 --dir ./testdata/fixture-repo \
  --prompt "Use the read_file tool to read README.md, then summarize."

Agent completed in 2 turns (reason: complete)
```

All three Workers AI models successfully completed a tool-call loop (read_file →
summarize) through the full path: harness CLI → SAM AI proxy → SAM AI Gateway →
Workers AI → tool execution → final response.

## Harness Running Inside Cloudflare Container (2026-05-03)

The harness binary was cross-compiled (static, `CGO_ENABLED=0`, stripped) and
uploaded to R2 at `experiments/harness-linux-amd64` (5.9MB). A new admin
endpoint (`POST /api/admin/sandbox/run-harness`) orchestrates the full flow:

1. Download binary from R2 (166ms)
2. Write to container via base64 decode (573ms warm, 2.4s cold)
3. Create test fixture files
4. Run harness against SAM AI proxy

### Results

| Model | Turns | Total Time | Harness Time | Tools Used |
|-------|-------|-----------|-------------|------------|
| Gemma 4 26B | 2 | 5.1s (cold) | 1.8s | read_file |
| Llama 4 Scout 17B | 2 | 3.6s (warm) | 2.5s | read_file |
| Qwen 2.5 Coder 32B | 1 | 3.3s (warm) | 2.2s | (text-only) |
| Llama 4 Scout 17B | 2 | 4.2s (warm) | varies | read_file, write_file, bash |

### Multi-Tool Loop

The harness successfully executed a multi-tool loop inside the container:
```text
Turn 1: read_file(main.go) + write_file(hello.txt) + bash(cat hello.txt)
Turn 2: final summary
```

The bash tool runs real commands inside the container filesystem. The harness
creates and reads files within the sandbox's `/workspace/test-repo/` directory.

### Proven Path

```text
Go harness binary (static, 5.9MB)
  -> running inside Cloudflare Container (sandbox SDK)
  -> calling SAM /ai/v1/chat/completions
  -> auth via MCP token in KV
  -> routed through SAM AI Gateway
  -> Workers AI model inference
  -> tool calls executed inside the container
  -> transcript captured and returned
```

All with zero API keys — unified billing covers Workers AI models through the
SAM gateway.

## Unified Billing for External Providers (OpenAI, Anthropic)

Unified billing covers BOTH Workers AI models AND external providers (OpenAI,
Anthropic, Google) — but the AI Gateway must have `authentication: true` and
the account must have AI Gateway credits loaded ($10 was added).

When `authentication: true`:
- The `cf-aig-authorization: Bearer <CF_API_TOKEN>` header authenticates the
  caller to the gateway
- The gateway uses account credits to pay for external provider API calls
- No external API keys needed

When `authentication: false` (current `sam` gateway state):
- The gateway just proxies requests through without injecting billing
- External providers see no API key and return 401
- Workers AI still works (uses `Authorization` header directly)

**To fix:** Set `authentication: true` on the `sam` gateway via CF dashboard.
The `default` gateway already has this and OpenAI models work through it.
