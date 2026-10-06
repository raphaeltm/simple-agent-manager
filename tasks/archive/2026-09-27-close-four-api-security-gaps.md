# Close Four Pre-Existing API Security Gaps

**Created**: 2026-09-27
**SAM task**: `01M3J7GT7YPGCX735V6AWZCAG1`
**Branch**: `sam/close-four-pre-existing-wzcag1`
**Merge rule**: stop WITHOUT merging after CI green + local specialist review (incl.
security-auditor) + staging verification. An independent adversarial reviewer merges.

Specs (treated as input, every claim re-verified against current code below):

- `tasks/archive/2026-08-18-setup-config-echoes-plaintext-secrets.md`
- `tasks/archive/2026-05-19-enforce-allowed-model-tiers-at-proxy.md`
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
- [x] `packages/shared`: `PLATFORM_AI_MODEL_TIERS` (exhaustive over the union), `isPlatformAIModelTier`,
      `getPlatformAIModelTier(modelId)` derived from `PLATFORM_AI_MODELS`; export + shared tests
- [x] `services/ai-model-tier-gate.ts`: read allowance once via `getAdminAiAllowance` (Valibot-validated), decide
      allowed / tier-not-allowed / uncataloged-model; null = all tiers; malformed stored value fails closed
- [x] Wire gate into `/ai/v1/chat/completions`, `/ai/v1/responses`, `/ai/anthropic/v1/messages`,
      `/ai/anthropic/v1/messages/count_tokens` after model validation, before the usage gate / upstream auth / fetch
      (after pure-move splits of ai-proxy.ts 655→356 and ai-proxy-anthropic.ts 582→478)
- [x] 403 with clear message in each route's native error format
- [x] Admin allowance route: reject unknown tier names (400); reuse `getAdminAiAllowance` (drop duplicate)
- [x] Route tests per route: allowed passes (owner-path control), disallowed → 403 and no upstream fetch,
      null → all allowed, uncataloged model under restriction → 403, malformed allowance → 403, thrown KV read → 500
      without spend, admin-route vertical slice
- [x] Machine-checked enumeration: every proxy route file that forwards with platform credentials runs the gate
      (`ai-proxy-model-tier-coverage.test.ts`; also pins passthrough as platform-credential-free)
- [x] Revert gate once per route family → tests red; restore (ai-proxy.ts gate calls removed: 10 red —
      4 denial cases × chat/completions+responses, operator-model, admin vertical; Anthropic gate calls removed:
      9 red — 4 denial cases × messages+count_tokens, untiered native model; gate mutations: unreadable→allowed
      reddens exactly the 4 fail-closed tests, untiered→allowed exactly the 2 untiered tests; one handler's gate
      removed reddens the coverage test)

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

### 5. Specialist review round (9 reviewers on head 27c97ce2e; 0 CRITICAL, 1 HIGH)
- [x] HIGH (security-auditor): the native Anthropic routes had no operator allowlist, so for every
      unrestricted user (all of them today) any `claude-*` ID reached platform credentials, and
      `AI_PROXY_ALLOWED_MODELS` did not apply to them. Pre-existing; fixed here:
      `validateAnthropicAllowedModel` (`ai-proxy-anthropic-support.ts`) runs the same `getAllowedModels`
      check as `validateAllowedModel` on both handlers, before the tier gate, with an Anthropic-format
      `400 invalid_request_error` and a `model_not_allowed` warn log. Rollout evidence (read-only AI Gateway
      logs): production Anthropic traffic (Apr 25 – May 1, the whole retained window) used only
      `claude-haiku-4-5-20251001` and `claude-opus-4-6`; staging (Apr 21 – Sep 8) used catalogued IDs apart
      from a retired `claude-sonnet-4-20250514` (May) and 401-ing typos. `AI_PROXY_ALLOWED_MODELS` is set in
      neither GitHub Environment nor the staging Worker, so the default (the catalog) applies.
      Revert proof: dropping the check from `/messages` reddens exactly 3 tests (that handler's coverage
      row + the 2 new allowlist tests); from `/count_tokens`, the same 3 for that route.
- [x] Coverage test now pairs gates per POST handler (test-engineer MEDIUM, architecture/TCV/CF LOW):
      each handler must call the allowlist gate and the tier gate before its first platform-spend call;
      comments are stripped first; the handler set is pinned to the 4 known handlers. Mutation: the
      `/responses` tier gate replaced by a trailing `// enforceModelTier(…)` comment → exactly that row red.
- [x] `RATE_LIMIT_SESSION_SUMMARIZE_WINDOW_SECONDS` (constitution MEDIUM), default
      `DEFAULT_SESSION_SUMMARIZE_WINDOW_SECONDS = 3600`; env.ts + docs. Revert proof: dropping the override
      reddens exactly "honours RATE_LIMIT_SESSION_SUMMARIZE_WINDOW_SECONDS…" (`expected '2700' to be '300'`).
- [x] One regex pass for credential tokens (performance MEDIUM): 477 → 108 ns per realistic log string.
      All three families are now case-insensitive (no `SAM_PAT_`/`SAM_WH_` identifier exists in the repo).
      Boundary tests at 7 vs 8 body characters per family and a token spanning the whole string
      (test-engineer MEDIUM + LOW).
- [x] Session–idea routes moved from `chat.ts` (579 → 476 lines) to `chat-ideas.ts`, mounted at the same
      position (architecture MEDIUM); new `chat-ideas.test.ts` through the real `chatRoutes` mount with real
      SQLite. Revert proof: dropping the `project_id` predicate reddens exactly the cross-project attack
      test; the same-project control stays green.
- [x] Docs: `AI_PROXY_ALLOWED_MODELS` in `reference/configuration.md`, the allowlist and KV-propagation
      delay in `reference/api.md` (CF + security LOW), `guides/agents.md`, `security.md` says where
      `Bearer`/`Basic` values are handled (architecture MEDIUM: they stay per-redactor on purpose — English
      words whose safe threshold differs between logs and user-visible text); stale summarize-route
      reference in the backlog file (doc-sync LOW)
- [x] Declined with reasons (recorded in the PR): per-isolate cache for the allowance read (adds
      staleness to a security gate, KV already edge-caches); structured `code` in the Anthropic 403 (native
      error envelope fidelity); unprefixed 40-hex GitHub PATs (that is the git SHA shape); limiter ordering
      before the project-capability check (per-user bucket, and it bounds D1 work for abusive callers).
      Follow-up ideas: duplicate `getUserBudgetSettings` KV read in `checkAiUsageGate`; rate bound for
      automatic task-title Workers AI calls; central redaction in `persistError`; Go redactor SAM shapes.

### Wrap-up
- [x] Docs sync: architecture/security.md (setup responses + redaction), reference/configuration.md,
      reference/api.md (admin AI allowances), guides/agents.md, apps/api/.env.example, env-reference + api-reference skills
- [x] Update summarize backlog file with what shipped and what remains
- [x] PR comment: each hardening, its test, revert evidence, bypass attempts — PR #2168
      (https://github.com/raphaeltm/simple-agent-manager/pull/2168#issuecomment-5860564803). Not merged by its
      author: the orchestrator runs the independent adversarial review and merges.

## Acceptance Criteria

- [x] No platform secret value appears in any setup/admin platform-config response body (setup.test.ts,
      admin-platform-config.test.ts)
- [x] A user whose allowance excludes a model's tier gets 403 on every platform-billed proxy route; null allows all
      (ai-proxy-model-tiers.test.ts, ai-proxy-model-tier-coverage.test.ts)
- [x] Every platform-billed proxy route, the native Anthropic ones included, refuses a model outside the operator
      allowlist for every caller (ai-proxy-model-tiers.test.ts, ai-proxy-model-tier-coverage.test.ts)
- [x] OpenAI/Anthropic `sk-` keys are redacted by every API redactor, via one shared pattern
      (credential-token-redaction.test.ts incl. drift guard, logger, VM error intake, canary consumers)
- [x] summarize/fork-prepare (and transcribe) return 429 past their limits and recover after the window
      (chat-fork.test.ts, transcribe.test.ts)
- [x] Each guard proven discriminating by a recorded revert (see checklist notes above)
- [x] Staging: setup/admin surfaces load; SAM-mode proxy request for an allowed model succeeds; no console errors
      (see Staging Verification below; the tier 403 was verified by the route tests AND by a live staging
      request — an admin restriction on a real user, refused on that user's real Claude Code traffic)

## Staging Verification (2026-09-27, deploy run 36353322517, head c705f819c, Worker version 02fb06d2)

- **Surfaces:** `/dashboard`, `/projects`, `/settings`, `/admin`, `/admin/ai-proxy`, `/admin/credentials` and
  `/setup` at 1280 and 375 px, all with 0 console errors and 0 API 5xx. The one `networkidle` timeout on
  `/admin/credentials` came from the harness: every API call returned 200, and the aborted `POST /api/t`
  is the analytics beacon. Staging setup is open; `PUT /api/setup/config` with a wrong token returns
  `401`, and `GET /api/admin/platform-config` returns only the key `status`.
- **SAM-mode request for an allowed model succeeds:** used the secondary staging user (`claude-code`
  `providerMode=sam` and no Claude credential of its own; the primary user has its own OAuth token and so
  never uses the proxy). Instant session `d06c92cd…` replied `PONG`. The tail showed
  `agent_key.ai_proxy_sam_provider`, 3 × `POST /ai/anthropic/v1/messages → 200` and
  `ai_proxy_anthropic.forward` with `modelId: claude-sonnet-4-5-20250929`, `billingMode: unified`; the
  AI Gateway `sam` logs show the same 3 calls with status 200.
- **Operator allowlist (direct staging request from inside the SAM workspace, using its own proxy token):**
  - `v1/messages` with the uncatalogued `claude-sonnet-4-20250514` → `400 invalid_request_error`
    ("Model … is not available. Allowed models: claude-haiku-4-5-20251001, claude-sonnet-4-5-20250929, …");
  - `count_tokens` with the same model → `400`;
  - 2 × `ai_proxy_anthropic.model_not_allowed` logged.
  - Control: `count_tokens` with a catalogued model passed both gates and then failed UPSTREAM with `401
    "x-api-key header is required"`. That is a pre-existing unified-billing bug in code identical to
    `main` (idea `01M3JFM6AG6H1XNYKEQD64W8E5`).
- **Tier 403 (route test + live staging request):**
  1. The superadmin wrote `['frontier']` → `400` ("allowedModelTiers must be null or an array of:
     low-cost, standard, premium"), then `['low-cost']` → `200`.
  2. 75 s later, a fresh session `64278215…` was refused: Claude Code's calls got `403`, the chat shows
     "API Error: 403 Model 'claude-sonnet-4-5-20250929' is in the standard tier, which your account is not
     allowed to use. Allowed tiers: low-cost." and 4 × `ai_proxy_anthropic.model_tier_denied`
     (`tier_not_allowed`, `standard`, `[low-cost]`) were logged, with no upstream spend.
  3. `DELETE` → `null`; 75 s later, a fresh session `1e6a4bd5…` replied `PONG`.
- **Rate limits:** `summarize` → `200` with `X-RateLimit-Limit: 30`, `Remaining: 29`; `transcribe` (1 s of
  silent WAV) → `200` with `30` / `29`. These are the deployed defaults; no override is set.
- **Non-proxy path unaffected:** the primary user's Instant session `a6e17b79…` (own OAuth) replied `PONG`.
- **Unrelated, pre-existing, filed:**
  - An idle-slept Instant session cannot be woken, because the sleep transition marks the node
    `unhealthy` and delivery refuses unhealthy nodes (idea `01M3JFFC8R6J1YE0HX0J3PS4TN`). This is why
    each check above used a fresh session.
  - Task-failure banner classification for proxy refusals (idea `01M3JG4JNJKQBYVWBC5Y5XR2EX`).
  - Two `DELETE /api/admin/ai-allowance` requests stalled 30–45 s on I/O (1–2 ms CPU, client-canceled)
    right after a burst of 4 session stops; three immediate retries succeeded in 0.7–1.7 s, and this
    branch does not change that handler.
- **Cleanup:** all 5 workspaces and nodes created are `deleted`; staging KV has 0 `ai-admin-allowance:*`
  keys. Screenshots are in `.codex/tmp/playwright-screenshots/` (`staging-*`, `staging2-restricted-1280`,
  `staging2-allowlist-1280`, `staging2-restored-375`).
