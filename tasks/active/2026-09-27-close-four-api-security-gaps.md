# Close Four Pre-Existing API Security Gaps

**Created**: 2026-09-27
**SAM task**: `01M3J7GT7YPGCX735V6AWZCAG1`
**Branch**: `sam/close-four-pre-existing-wzcag1`
**Merge rule**: stop WITHOUT merging after CI green + local specialist review (incl.
security-auditor) + staging verification. An independent adversarial reviewer merges.

Specs (treated as input, every claim re-verified against current code below):

- `tasks/active/2026-08-18-setup-config-echoes-plaintext-secrets.md`
- `tasks/active/2026-05-19-enforce-allowed-model-tiers-at-proxy.md`
- `tasks/backlog/2026-03-14-summarize-endpoint-hardening.md` (rate-limit item only; stays in
  backlog because its other five items are out of scope)

## Problem

1. `PUT /api/setup/config` returns the full `ResolvedPlatformConfig`, including plaintext
   `.value` for every platform secret (GitHub App private key, OAuth client secrets, webhook
   secret — both runtime-stored and environment-fallback values).
2. Admin `allowedModelTiers` (`PUT /api/admin/ai-allowance/:userId`) is stored in KV but never
   read at inference time, so a restricted user can use any model tier through the platform AI
   proxy.
3. `services/secret-redaction.ts` (`redactSecretPatterns`, which backs `redactSensitiveData`)
   only matches `sk-ant-` keys. OpenAI `sk-…` / `sk-proj-…` keys pass through into persisted
   platform errors (VM agent error intake), debug-agent evidence, diagnostic incidents and
   feedback triage — while `lib/logger.ts` (`SENSITIVE_VALUE_RE`) does match `sk-`.
4. `POST …/sessions/:sessionId/summarize` and `POST …/sessions/:sessionId/fork-prepare` both call
   Workers AI (`summarizeSession`) with no rate limit.

## Research Findings (verified 2026-09-27)

### 1. Setup config echo

- Confirmed: `routes/setup.ts` `PUT /config` → `c.json({ status, config: resolved })`.
- Web consumer `apps/web/src/pages/Setup.tsx` `handleSave` reads only `response.status`; the web
  type `PlatformConfigStatusResponse` is already `{ status }`. No UI change needed.
- Other serializers: `admin-platform-config.ts` GET/PUT return `getPlatformConfigStatus` only;
  `GET /api/config/login-providers` returns booleans. `/setup/verify` and `/setup/complete`
  return status only. So `PUT /setup/config` is the only wholesale serializer.
- Structural fix available: no caller (route or test) uses the return value of
  `savePlatformIntegrationConfig` / `completeSetupWithConfig`; both end with a
  `resolvePlatformConfig` re-read purely to return it. Returning `void` makes the echo
  unrepresentable and removes dead work (the next `getPlatformConfigStatus` re-warms the cache,
  so total D1 reads are unchanged).
- Validation errors (`platform-config-validation.ts`) never interpolate submitted values.

### 2. Model-tier enforcement

- Tier data exists: `PlatformAIModel.tier` in `packages/shared/src/constants/ai-services.ts`
  (`PLATFORM_AI_MODELS`); domain `'low-cost' | 'standard' | 'premium'`. The spec's `frontier`
  example does not exist. `ai-services.ts` is 785 lines → new logic goes in a sibling module
  (`ai-model-tiers.ts`), not into it (rule 18).
- Actual route paths: `/ai/v1/chat/completions`, `/ai/v1/responses` (`routes/ai-proxy.ts`) and
  **`/ai/anthropic/v1/messages`** (not `/ai/v1/messages`) plus
  `/ai/anthropic/v1/messages/count_tokens` (`routes/ai-proxy-anthropic.ts`). All four forward
  a model-bearing request upstream with PLATFORM credentials (`resolveUpstreamAuth` /
  `resolveOpenAIProxyCredential` / Workers AI).
- The model ID each route checks is exactly the ID it forwards: `forwardTo*` overwrite
  `model` with the resolved `modelId`; the native Anthropic route forwards `body.model`, which is
  the value it validates. No aliasing bypass.
- Not in scope, with reasons (rule 61 enumeration):
  - `/ai/proxy/:wstoken/*` passthrough (`routes/ai-proxy-passthrough.ts`): resolves the user's /
    project's OWN attached credential via `resolveForConsumer`, explicitly skips
    `platform-proxy`, and can never select a platform default (platform defaults are
    `api-key`/`oauth-token` kinds with no dialect config, so `credentialSupportsDialect` rejects
    them). Platform tiers classify platform spend; BYO-key traffic is user-funded.
  - SAM agent loop (`durable-objects/sam-session`): model is platform-configured (`SAM_MODEL`),
    not user-selected.
  - `GET /ai/v1/models`: discovery only, no spend.
- `allowedModelTiers` is read from KV with an unvalidated `kv.get<AdminAiAllowance>(…, 'json')`
  in two places (`services/ai-token-budget.ts:getAdminAiAllowance` and a duplicate
  `getAllowance` in `routes/admin-ai-allowance.ts`, rule 24). The admin route accepts any
  strings as tiers (a typo such as `frontier` would silently block every model).
- No admin UI sets `allowedModelTiers` (API only).
- Rollout impact (rule 71): production KV (`sam-prod-sessions`) and staging KV both hold **zero**
  `ai-admin-allowance:*` keys, so enforcement changes no existing user's access.
- I/O: +1 KV read per proxy request (rule 60 counts D1/DO/fetch, not KV); no D1 added.

### 3. Log/secret redaction

API redactors and their `sk-` coverage:

| Helper | File | `sk-` coverage before |
| --- | --- | --- |
| `SENSITIVE_VALUE_RE` | `lib/logger.ts` | `\bsk-[A-Za-z0-9_-]+` ✓ |
| `redactSecretPatterns` / `redactSensitiveData` | `services/secret-redaction.ts`, `observability-cf-support.ts` | `sk-ant-` only ✗ |
| `redactSensitiveText` | `services/message-comments.ts` | `\bsk-…{20,}` ✓ |
| `redactSecrets` | `services/report-issue.ts` | own `sk-…{10,}` + `redactSecretPatterns` ✓ |
| `sanitizeDriverDetail` | `durable-objects/credential-setup-session/index.ts` | `sk-ant` only ✗ (Codex device auth also runs here) |
| `sanitizePublishEventText` | `services/deployment-publish-jobs.ts` | none ✗ |
| `boundedDiagnostic` | `services/workspace-deletion.ts` | none ✗ |

- `redactSensitiveData` feeds: VM agent error intake (`routes/node-diagnostic-incidents.ts` →
  `platform_errors`), Workers Observability log query details, debug-agent evidence/diagnosis,
  diagnostic incidents, feedback triage/incidents, session snapshot capture errors.
- The shared canary fixture `tests/fixtures/diagnostic-secret-canaries.json` (consumed by API
  tests AND `packages/vm-agent/internal/errorreport`) has no OpenAI key shape. The Go redactor
  already matches `(?i)sk-[a-z0-9_-]{8,}`; its tests index canary `[7]` and count
  `redactions >= len(canaries)`, so appending entries is safe for Go.
- `lib/` sits below `services/` (lib imports services in only two unrelated files), so the one
  shared pattern belongs in `lib/`.
- A leading `\b` misses `KEY_sk-…` (`_` is a word char); no boundary at all matches inside
  `task-runner-…`. An alphanumeric lookbehind handles both.

### 4. Rate limits (summarize, fork-prepare)

- Routes: `POST …/:sessionId/summarize` in `routes/chat.ts` (663 lines — over the 500 ceiling,
  so it must be split, not extended) and `POST …/:sessionId/fork-prepare` in
  `routes/chat-fork.ts`. Both mounted under `chatRoutes`, which applies `requireAuth()` first.
- **The cited pattern is dead config**: `RATE_LIMIT_TRANSCRIBE` is declared in `env.ts`,
  documented in `.env.example` and in public docs as "Max transcriptions per minute (30)", but
  `routes/transcribe.ts` never applies any limiter. The live pattern is
  `DEFAULT_RATE_LIMITS` + `getRateLimit` + `rateLimit()` (`middleware/rate-limit.ts`), e.g.
  `rateLimitReportIssuePost`.
- Web: retry flow calls `/summarize` and swallows errors (degrades to no summary); fork flow
  calls `/fork-prepare` and surfaces the error message. A 429 is handled on both.

## Implementation Checklist

### 1. Setup config echo
- [x] `PUT /api/setup/config` returns `{ status }` only
- [x] `savePlatformIntegrationConfig` / `completeSetupWithConfig` return `Promise<void>` (echo unrepresentable)
- [x] Route test: seed known secrets via env fallback AND request body; assert no secret appears in the
      raw response text of `PUT /config`, `POST /verify`, `POST /complete`; liveness: status says configured
- [x] Admin platform-config GET/PUT canary test (the only other platform-config serializer)
- [x] Revert `config: resolved` once → test red; restore (reverted to `config: await resolvePlatformConfig()`:
      exactly `PUT /config returns only the status projection, never a secret value` went red — env GitHub
      client secret found in the body)

### 2. Model-tier enforcement
- [ ] `packages/shared`: `PLATFORM_AI_MODEL_TIERS` (exhaustive over the union), `isPlatformAIModelTier`,
      `getPlatformAIModelTier(modelId)` derived from `PLATFORM_AI_MODELS`; export + shared tests
- [ ] `services/ai-model-tier-gate.ts`: read allowance once (Valibot-validated), decide
      allowed / tier-not-allowed / uncataloged-model; null = all tiers; malformed stored value fails closed
- [ ] Wire gate into `/ai/v1/chat/completions`, `/ai/v1/responses`, `/ai/anthropic/v1/messages`,
      `/ai/anthropic/v1/messages/count_tokens` after model validation, before the usage gate / upstream auth / fetch
- [ ] 403 with clear message in each route's native error format
- [ ] Admin allowance route: reject unknown tier names (400); reuse `getAdminAiAllowance` (drop duplicate)
- [ ] Route tests per route: allowed passes (owner-path control), disallowed → 403 and no upstream fetch,
      null → all allowed, uncataloged model under restriction → 403, malformed allowance → 403
- [ ] Machine-checked enumeration: every proxy route file that forwards with platform credentials runs the gate
- [ ] Revert gate once per route family → tests red; restore

### 3. Redaction
- [x] `lib/credential-token-redaction.ts`: one `redactCredentialTokens` (provider `sk-`, GitHub, SAM token families)
- [x] Use it in: logger, secret-redaction, message-comments, report-issue (drop its private `sk` alt),
      credential-setup-session, deployment-publish-jobs. workspace-deletion deliberately unchanged:
      only fixed templates reach `boundedDiagnostic` (`deletionFailureDiagnostic` drops the error message)
- [x] Append OpenAI `sk-…` and `sk-proj-…` (+ realistic `sk-ant-api03-…`, `github_pat_`) canaries to the shared fixture
- [x] Tests through real entry points: `log.*` output, VM agent error intake (`POST /api/nodes/:id/errors`)
      persisted rows, plus existing canary consumers; negative control (`task-runner-…` untouched)
- [x] Drift guard: no other API source file defines its own `sk-`/GitHub/SAM token regex
- [x] Revert the `secret-redaction.ts` fix once → tests red; restore (red: debug-agent-vm-incident
      "returns only bounded redacted summary data…", workers/diagnostic-incidents "durably correlates the
      error…", vm-agent-errors-secret-redaction "strips every canary…"). Logger revert → red: "log.* strips
      every credential token…", "a SAM PAT is redacted whole…", drift guard
- [x] Go canary tests still pass with the extended fixture (`go test ./internal/errorreport/...` ok)

### 4. Rate limits
- [x] Pure move: `/summarize` route from `chat.ts` into `chat-fork.ts` (separate commit 7721c9f4c)
- [x] `DEFAULT_RATE_LIMITS.SESSION_SUMMARIZE` (one bucket shared by summarize + fork-prepare, per user per hour)
- [x] Apply to both routes; update existing chat-fork tests for KV/auth
- [x] Adjacent fix: enforce the documented-but-dead `RATE_LIMIT_TRANSCRIBE` (30 per minute, as documented;
      window override `RATE_LIMIT_TRANSCRIBE_WINDOW_SECONDS`)
- [x] Tests through real routes: at-limit 429 + Retry-After + no AI call, shared bucket, per-user isolation,
      window rollover (default budget resolved through the real resolver, real `handleAppError`)
- [x] Revert limiter once → tests red; restore (chat-fork.ts without limiter: exactly the 4 rate-limit tests
      red, 3 behaviour tests green; transcribe.ts without limiter: exactly the 4 new tests red, 10 green)
- [x] Docs: `.env.example`, `reference/configuration.md`, env-reference skill (`reference/api.md` does not
      document these endpoints)

### Wrap-up
- [ ] Docs sync (security.md / configuration.md / api.md as affected)
- [ ] Update summarize backlog file with what shipped and what remains
- [ ] PR comment: each hardening, its test, revert evidence, bypass attempts

## Acceptance Criteria

- [ ] No platform secret value appears in any setup/admin platform-config response body
- [ ] A user whose allowance excludes a model's tier gets 403 on every platform-billed proxy route; null allows all
- [ ] OpenAI/Anthropic `sk-` keys are redacted by every API redactor, via one shared pattern
- [ ] summarize/fork-prepare (and transcribe) return 429 past their limits and recover after the window
- [ ] Each guard proven discriminating by a recorded revert
- [ ] Staging: setup/admin surfaces load; SAM-mode proxy request for an allowed model succeeds; no console errors
