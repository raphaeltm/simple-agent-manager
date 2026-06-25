# Security Review: Domain B - Credentials, Encryption & AI Proxy

Date: 2026-06-25
Branch: `security-review/credentials-encryption-aiproxy`
Repository: `raphaeltm/simple-agent-manager`

## Domain Summary

Reviewed credential storage, encryption helpers, composable credential resolution, OAuth refresh rotation, and AI proxy routes. The core AES-GCM helper uses random 12-byte IVs and avoids logging ciphertext/IV. BYOC Hetzner/Scaleway credentials are stored encrypted in D1 rather than env vars. Composable credential snapshots now isolate per-row decrypt/parse failures, and the compute assembler rejects provider mismatches before provider construction.

High-risk issues remain around policy enforcement at credential/proxy trust boundaries: native Anthropic proxy requests bypass the SAM model allowlist, Codex OAuth refresh accepts and stores unexpected upstream OAuth scopes by default, and URL-embedded workspace callback tokens create replay exposure through logs and process configuration.

Multi-level review note: I dispatched SAM subtasks with Backend Implementation profile `01KSWW2DQTZ8N3F2PYXKMJ7QZZ` and mission `c879abb0-770a-4187-8503-77dc1ba42ca8` for encryption and composable credential/rotation review. Initial subtasks `01KVZ8QB77BQ0KC2VZGEY92PSX` and `01KVZ8QG6RXD8KB2G3K2QZ3SKK` failed before producing summaries. I retried narrower replacements `01KVZ8WG18BV9743Y5P1BDJHAB` and `01KVZ8WTGWGMJXBZXDYX7Y5TSM`; these also failed before returning findings. The findings below are based on local read-only review.

## Severity Counts

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 0 |

## High Findings

### CRED-001 - Native Anthropic proxy bypasses AI_PROXY_ALLOWED_MODELS

Severity: High
CWE: CWE-770 (Allocation of Resources Without Limits or Throttling)
Location: `apps/api/src/routes/ai-proxy-anthropic.ts:140`

Description: The OpenAI-compatible proxy resolves the requested model and enforces `AI_PROXY_ALLOWED_MODELS` before forwarding, but the native Anthropic Messages proxy only checks that `body.model` exists and starts with `claude-`. The route is mounted separately at `/ai/anthropic/v1`, so a workspace callback token can call `/messages` with any Anthropic model name accepted by the upstream, even if that model is not in the platform allowlist.

Impact/Exploit: A workspace using the native Anthropic route can select a more expensive or disallowed Anthropic model and still pass SAM's proxy gate, consuming platform or unified-billing spend outside the configured allowlist. The same missing allowlist applies to `/messages/count_tokens`.

Evidence:
- `/ai/v1/chat/completions` enforces `validateAllowedModel()` before forwarding at `apps/api/src/routes/ai-proxy.ts:604`.
- `/ai/anthropic/v1/messages` only checks `isAnthropicModel(modelId)` at `apps/api/src/routes/ai-proxy-anthropic.ts:140`.
- `/ai/anthropic/v1/messages/count_tokens` repeats the same prefix-only check at `apps/api/src/routes/ai-proxy-anthropic.ts:344`.
- Route mounting shows this is a separate public proxy surface at `apps/api/src/index.ts:670`.

Remediation: Reuse the same allowlist parser/normalization for native Anthropic routes. Reject any Anthropic model not present in `AI_PROXY_ALLOWED_MODELS` before `checkAiUsageGate()` and before upstream auth resolution. Add worker/unit tests proving disallowed `claude-*` models fail on both `/messages` and `/messages/count_tokens`.

Confidence: High

### CRED-002 - Codex OAuth refresh stores unexpected scopes by default

Severity: High
CWE: CWE-269 (Improper Privilege Management)
Location: `apps/api/src/durable-objects/codex-refresh-lock.ts:349`

Description: Codex refresh scope validation has a conservative allowlist implementation, but the default enforcement mode is `warn`. When OpenAI returns unexpected scopes, the Durable Object logs `codex_refresh.unexpected_scopes_allowed`, proceeds, updates the encrypted auth.json, and returns the rotated token set. This violates the project rule requiring unexpected OAuth scopes to be rejected by default.

Impact/Exploit: If the upstream returns a token with expanded scopes due to provider drift, misconfiguration, or an attack on the refresh exchange, SAM persists the escalated token material encrypted in D1 and hands it to the workspace. The user-visible credential boundary accepts a broadened OAuth grant instead of failing closed.

Evidence:
- Default expected scopes are defined at `apps/api/src/durable-objects/codex-refresh-lock.ts:98`.
- The code comments say blocking was demoted and can only be re-enabled with `CODEX_SCOPE_VALIDATION_MODE=block` at `apps/api/src/durable-objects/codex-refresh-lock.ts:349`.
- The default branch uses `const validationMode = this.env.CODEX_SCOPE_VALIDATION_MODE ?? 'warn'` at `apps/api/src/durable-objects/codex-refresh-lock.ts:358`.
- In warn mode, it logs and continues at `apps/api/src/durable-objects/codex-refresh-lock.ts:365`, then persists `newTokens` into the encrypted auth JSON at `apps/api/src/durable-objects/codex-refresh-lock.ts:381`.
- Tests explicitly lock in warn-by-default behavior at `apps/api/tests/unit/durable-objects/codex-refresh-lock.test.ts:774`.

Remediation: Make block the default for unset `CODEX_SCOPE_VALIDATION_MODE`; keep explicit `warn` or empty allowlist as opt-out only if the risk is documented and operator-controlled. Ensure rejected rotations do not update D1 and add a regression test for unset env returning 502 on unexpected scopes.

Confidence: High

## Medium Findings

### CRED-003 - Workspace callback tokens are embedded in URLs

Severity: Medium
CWE: CWE-598 (Use of GET Request Method With Sensitive Query Strings)
Location: `apps/api/src/routes/codex-refresh.ts:46`

Description: The Codex refresh endpoint reads the workspace callback token from `?token=...`, and passthrough AI proxy routes embed the same token in the path as `/:wstoken/...`. Callback tokens default to 24 hours and authorize workspace-scoped operations. URL query strings and paths are routinely captured in reverse-proxy logs, APM traces, crash logs, shell histories, and process/config dumps.

Impact/Exploit: Anyone who obtains a logged URL before token expiry can replay the workspace callback token against callback-token-authenticated endpoints, including AI proxy calls and Codex refresh. For passthrough proxy, the VM agent also materializes token-bearing base URLs into agent configuration/env, increasing accidental exposure through process inspection or tool diagnostics.

Evidence:
- Codex refresh documents and extracts `?token=` at `apps/api/src/routes/codex-refresh.ts:9` and `apps/api/src/routes/codex-refresh.ts:47`.
- Passthrough routes are explicitly `POST /ai/proxy/:wstoken/...` at `apps/api/src/routes/ai-proxy-passthrough.ts:9`.
- The handler reads `c.req.param('wstoken')` and verifies it as the workspace token at `apps/api/src/routes/ai-proxy-passthrough.ts:386`.
- Callback tokens default to 24 hours at `apps/api/src/services/jwt.ts:35`.
- The VM agent replaces `{wstoken}` directly into proxy base URLs at `packages/vm-agent/internal/acp/session_host_startup.go:262` and `packages/vm-agent/internal/acp/gateway.go:1052`.

Remediation: Prefer header-based workspace token auth for all clients that support it. For clients that cannot set headers, issue short-lived, audience-limited proxy tokens or opaque one-time handles instead of the durable workspace callback token. Add URL/token redaction in edge logs and agent diagnostics, and shorten the lifetime of any token that must appear in a URL.

Confidence: High

### CRED-004 - Credential write endpoints use non-atomic KV rate limiting

Severity: Medium
CWE: CWE-770 (Allocation of Resources Without Limits or Throttling)
Location: `apps/api/src/middleware/rate-limit.ts:103`

Description: `rateLimitCredentialUpdate()` protects credential update endpoints, but it is backed by `checkRateLimit()`, a KV read-increment-write limiter that the code itself documents as non-atomic. The scoped requirement for credential rotation endpoints says rate-limit state must be atomic and not KV. Codex refresh correctly moved to a Durable Object, but user/project credential writes and deployment secret overwrites still use the shared KV limiter.

Impact/Exploit: An authenticated user can issue concurrent credential write/overwrite requests and exceed the intended limit. This weakens brute-force and resource-exhaustion protection around encryption/write-heavy credential operations and can be used to spam encrypted secret rotations.

Evidence:
- `checkRateLimit()` notes the KV read-increment-write pattern is not atomic at `apps/api/src/middleware/rate-limit.ts:103`.
- `rateLimitCredentialUpdate()` wraps that KV limiter at `apps/api/src/middleware/rate-limit.ts:226`.
- User-scoped agent credential writes use it at `apps/api/src/routes/credentials.ts:455`.
- Project-scoped agent credential writes use it at `apps/api/src/routes/projects/credentials.ts:128`.
- Deployment environment secret overwrites use it at `apps/api/src/routes/deployment-secrets.ts:97`.
- Codex refresh comments contrast the DO-based atomic limiter at `apps/api/src/routes/codex-refresh.ts:71`.

Remediation: Move credential-write throttling to a Durable Object counter or D1 atomic upsert/update with a conditional limit, keyed per user and operation class. Preserve existing headers and add concurrency tests showing at-limit rejection under parallel requests.

Confidence: High

### CRED-005 - AI proxy logs unsanitized upstream error bodies

Severity: Medium
CWE: CWE-532 (Insertion of Sensitive Information into Log File)
Location: `apps/api/src/routes/ai-proxy.ts:220`

Description: Several AI proxy forwarding paths read upstream error bodies and log the first 500 bytes. Upstream AI errors can contain provider diagnostics, request fragments, model inputs, or account/project metadata. This is especially risky for LLM prompts because users and agents may include secrets in prompts or tool payloads even when credentials are not intentionally logged.

Impact/Exploit: A malformed or rejected AI request that causes an upstream provider to echo request details can place sensitive prompt content or provider diagnostics into SAM logs. Operators, log sinks, or incident exports then retain data that should have stayed inside the request/response boundary.

Evidence:
- Workers AI error body is logged at `apps/api/src/routes/ai-proxy.ts:220`.
- Translated Anthropic error body is logged at `apps/api/src/routes/ai-proxy.ts:271`.
- OpenAI chat error body is logged at `apps/api/src/routes/ai-proxy.ts:346`.
- OpenAI Responses error body is logged at `apps/api/src/routes/ai-proxy.ts:401`.
- Native Anthropic `/messages` logs upstream error body at `apps/api/src/routes/ai-proxy-anthropic.ts:235`.
- Native Anthropic `/messages/count_tokens` logs upstream error body at `apps/api/src/routes/ai-proxy-anthropic.ts:413`.

Remediation: Replace raw upstream body logging with a sanitized error classifier: status, provider, request id, stable upstream error code, and a redacted/truncated message after applying known secret and prompt redaction. Add tests using an upstream error body containing fake API keys and prompt text to assert logs do not contain those values.

Confidence: Medium

## Positive Observations

- AES-GCM helper uses random 12-byte IVs and does not log ciphertext/IV (`apps/api/src/services/encryption.ts:45`, `apps/api/src/services/encryption.ts:86`).
- BYOC cloud-provider credentials are encrypted before D1 writes (`apps/api/src/routes/credentials.ts:247`).
- Composable credential snapshot wraps per-row decrypt/parse and skips bad rows rather than failing the whole snapshot (`apps/api/src/services/composable-credentials/snapshot.ts:166`).
- Compute credential assembly rejects requested-provider versus credential-provider mismatch (`packages/shared/src/composable-credentials/assemblers.ts:144`).
- Codex refresh stale-token branch omits `refresh_token` outside the grace window (`apps/api/src/durable-objects/codex-refresh-lock.ts:269`) and rate limits refreshes through Durable Object storage (`apps/api/src/durable-objects/codex-refresh-lock.ts:193`).
