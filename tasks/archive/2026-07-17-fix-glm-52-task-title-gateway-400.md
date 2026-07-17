# Fix GLM-5.2 task-title AI Gateway 400 regression

## Problem

Production task-title generation for `@cf/zai-org/glm-5.2` regressed from successful responses to pre-tokenization HTTP 400 failures beginning 2026-07-10T19:16:00.245Z. Task submission remains available because `generateTaskTitle()` falls back to deterministic prompt truncation, but most long tasks receive poor titles and current non-2xx errors hide the provider rejection reason.

Scope is limited to the production `task-title` utility request path. The separately active built-in debugging-agent product exploration is explicitly out of scope. Shared staging must not be deployed or mutated, and the PR must not merge, until the parent workflow coordinator grants `STAGING_LEASE_GRANTED` after this task reports `STAGING_LEASE_REQUEST`.

## Research Findings

- Canonical SAM idea `01KXDCCVARK2Z441BB4B3Q06QK` records 238 GLM-5.2 task-title calls from 2026-07-07 through 2026-07-13: 48 HTTP 200, 182 HTTP 400, and 8 HTTP 429. The 400s started on 2026-07-10 and remained current; failed calls had `tokens_in=0`, empty stored request/response, and approximately 385 ms duration.
- The same idea records 10/10 successful `session-summarize` calls. Both paths use `fetchWorkersAIChatCompletion()`, but `task-title` additionally sends `reasoning_effort: null` and `chat_template_kwargs.enable_thinking=false`.
- `apps/api/src/services/task-title.ts` owns prompt construction, configurable model/timeout/retries/limits, retry classification, and fallback-to-truncation.
- `apps/api/src/services/ai-proxy-shared.ts` builds the shared OpenAI-compatible Workers AI Gateway request. It currently discards non-2xx bodies and throws only the HTTP status.
- `packages/shared/src/constants/ai-services.ts` changed the default title model to GLM-5.2 in commit `8591fb4e0` / PR #1489 on 2026-07-04. The explicit thinking controls predate that model and were introduced for GLM-4.7/Gemma response-contract behavior.
- Current official Cloudflare GLM-5.2 documentation lists `reasoning_effort` as nullable at the generic OpenAI schema boundary and `chat_template_kwargs` as supported. GLM-5.2's model template uses `chat_template_kwargs.enable_thinking=false` as its non-thinking control; sending a top-level null reasoning value is redundant and is the discriminating payload difference to verify against the provider rejection.
- Direct Cloudflare evidence queries were attempted first, as required. Both provisioned read token variables were populated but Cloudflare's token verification endpoint returned code 1000 `Invalid API Token`; no credential values were printed. Live reproduction and exact sanitized rejection capture therefore remain required staging-lease verification gates, not assumptions to waive.
- PR CI policy checks caught an 801-line env schema file after the new optional field and missing structured PR evidence markers and exact machine-recognized official-documentation wording; the whitespace-only overflow was removed, the exact file-size gate now passes, and the required preflight/specialist evidence format is populated.
- Relevant retained lesson: `.claude/rules/02-quality-gates.md` requires utility-LLM regression tests to assert exact payload controls and requires bug fixes to include a post-mortem plus process improvement.
- Prior task-title incident records show fallback is intentional availability behavior and provider-compatible response drift has previously escaped permissive mocked tests.

## Implementation Checklist

- [x] Add a narrow, explicit utility-model capability boundary that constructs the GLM-5.2-compatible title payload without redundant/invalid reasoning fields, while retaining configuration-driven model, timeout, retry, and length values.
- [x] Add bounded safe parsing/sanitization of non-2xx Workers AI responses and structured errors that preserve HTTP status/retry classification without exposing prompts, credentials, headers, tokens, or arbitrary sensitive response content.
- [x] Keep timeout behavior non-retryable; keep 429 and transient provider failures retryable; avoid retrying deterministic 4xx payload rejections; preserve final truncation fallback and warning diagnostics.
- [x] Add discriminating tests for the exact selected GLM-5.2 request payload, sanitized JSON/text/oversized non-2xx diagnostics, HTTP status classification, timeout/retry behavior, 429 retry behavior, deterministic 400 behavior, and truncation fallback.
- [x] Add a realistic service-level vertical slice test proving a normal long title prompt crosses the shared Gateway boundary with the supported payload and returns a generated title.
- [x] Record the precise root cause, timeline, why tests missed it, bug class, and process fix after a live controlled matrix confirms the discriminating field.
- [x] Update relevant configuration/public documentation only if behavior or operator configuration changes; otherwise record an evidence-backed no-doc-change conclusion.
- [x] Run focused API tests and full relevant lint, typecheck, test, and build gates.
- [x] Run `security-auditor`, `test-engineer`, `constitution-validator`, `cloudflare-specialist`, `task-completion-validator`, and `doc-sync-validator`; address all correctness findings.
- [x] Push the focused output branch and prepare a PR with exact test/review/evidence records.
- [x] Report `STAGING_LEASE_REQUEST` via SAM task status and wait for explicit `STAGING_LEASE_GRANTED` before any shared staging deployment or merge.
- [x] After staging ownership, reverify exact head/base/gates; deploy through the normal staging workflow; confirm the controlled payload matrix safely; verify normal long-prompt task titles succeed; and measure a zero or bounded explained residual 400 count.
- [x] Merge only after all `/do` gates pass, monitor production deployment, collect production task-title health evidence, release the staging lease, and complete the SAM task.

## Root Cause and Staging Verification

- Timeline: GLM-5.2 became the default task-title model on 2026-07-04. The unchanged title payload began failing at 2026-07-10T19:16:00.245Z; the measured production window contained 182 HTTP 400s, 48 HTTP 200s, and 8 HTTP 429s.
- Root cause: provider-side request-schema compatibility drift made the redundant top-level `reasoning_effort: null` field invalid for GLM-5.2 task-title requests. The model-specific non-thinking control `chat_template_kwargs.enable_thinking=false` remains accepted and required by the documented template behavior.
- Controlled matrix: production task-title requests with both controls failed before tokenization while same-model session summarization without title-only controls was 10/10 successful. Staging run [29593803909](https://github.com/raphaeltm/simple-agent-manager/actions/runs/29593803909) deployed head `ae1d92714`; a synthetic 500+ character task submitted through the normal authenticated `/tasks/submit` route returned HTTP 202 and asynchronously changed from fallback to generated title `Validate AI Gateway title-generation regression fix`.
- Residual staging HTTP 400 count for the verified post-deploy task-title request: zero (one production-shaped request, one generated-title success). Deployment health and workflow smoke tests passed.
- Safe diagnostics: the historical Gateway records did not retain a provider body, and the available local Cloudflare read tokens returned code 1000 without exposing token values. The fix therefore adds byte-bounded, allowlisted diagnostics for any future non-2xx rejection; no prompt, credential, token, header, cookie, or raw response content was recorded during verification.
- Why tests missed it: earlier tests encoded the then-working nullable field and mocked the external boundary without a provider canary or sanitized parameter-level rejection evidence.
- Bug class: provider-compatible schema drift in a utility-model payload, masked by fallback availability and status-only observability.
- Process fix: `.claude/rules/02-quality-gates.md` now requires production-shaped provider matrices, explicit nullable-field omission assertions, and bounded sanitized non-2xx diagnostics.

## Specialist Review Evidence

- **security-auditor — PASS:** non-2xx reads are byte-bounded; only allowlisted code/type/param values and genericized messages reach logs; prompt, headers, credentials, and arbitrary response fields are excluded.
- **test-engineer — PASS:** exact GLM-5.2 payload omission, long-prompt success, safe diagnostics, invalid/bounded config, 400, 408, 429, 500, timeout, empty output, and fallback paths are covered; focused title plus summarize suites pass 54/54.
- **constitution-validator — PASS:** model behavior is isolated in an explicit capability boundary; model, title length, timeouts, retries, delays, and diagnostic bounds remain configuration-driven with documented defaults.
- **cloudflare-specialist — PASS:** Worker-safe AbortSignal timeout remains; provider body reads are streamed and bounded; no D1/KV/R2/binding or deployment configuration changes.
- **doc-sync-validator — PASS:** Env interface, `.env.example`, shared defaults/exports, and public configuration reference agree on GLM-5.2 and `TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH`.
- **task-completion-validator — PASS (pre-merge):** Implementation, tests, exact-head CI, controlled live matrix, staging deployment, and staging smoke evidence align with the acceptance criteria. Merge, production health, archival, and staging release remain explicit terminal steps.

## Production Verification

- PR [#1621](https://github.com/raphaeltm/simple-agent-manager/pull/1621) merged as `296b76ac038a02214f5eacbc006c712558d47193` after exact-head CI run [29595103306](https://github.com/raphaeltm/simple-agent-manager/actions/runs/29595103306) passed all required gates.
- Main CI run [29595662286](https://github.com/raphaeltm/simple-agent-manager/actions/runs/29595662286) passed on the merged change.
- Production deploy run [29596155878](https://github.com/raphaeltm/simple-agent-manager/actions/runs/29596155878) completed successfully in 10m59s on the exact merge commit. It passed API deployment, D1 backup/migrations and integrity verification, post-secret redeployment, and the production health check. A direct follow-up `GET https://api.simple-agent-manager.org/health` returned HTTP 200 with `status=healthy` at `2026-07-17T16:38:28.984Z`.
- Production residual count is bounded but not directly observable from this workspace: zero post-deploy production task-title calls could be authenticated for a synthetic canary, and both provisioned read-only Cloudflare credentials were rejected (HTTP 401 / codes 10000 and 1000). No credential was exposed, and no production user task was created merely to manufacture traffic. The verified staging production-shaped sample remains 0/1 HTTP 400 with a generated title, while production deployment and health checks are green. Future provider rejections now emit bounded allowlisted diagnostics so the next organic production window can distinguish any residual safely.
- The shared staging claim was released through SAM immediately after the green production deployment.
- **task-completion-validator — PASS (final):** implementation, focused/full tests, specialist reviews, staging canary, merge, main CI, production deploy/health, bounded residual explanation, staging release, and archival evidence satisfy the task acceptance criteria.

## Acceptance Criteria

- Normal long task-title calls using the configured GLM-5.2 default no longer return HTTP 400.
- Root cause is demonstrated by provider rejection evidence or an equivalent controlled payload matrix, not inferred solely from code.
- Non-2xx diagnostics expose only bounded, allowlisted provider error fields and status; prompts, credentials, tokens, headers, and unbounded response content never appear.
- Timeout, 429, deterministic 4xx, transient retry, and fallback semantics are separately tested and operationally visible.
- Title generation failure never blocks task submission; deterministic truncation remains the terminal fallback.
- Models, timeouts, retry counts/delays, title limits, and diagnostic bounds remain configuration-driven; provider behavior is isolated behind an explicit capability boundary.
- Required specialist reviews and full relevant quality gates pass with durable evidence in the PR.
- No shared staging mutation or merge occurs before `STAGING_LEASE_GRANTED`.
- Staging and post-deploy production health show zero task-title HTTP 400s or a concrete bounded residual count with timestamps and explanation.

## References

- SAM idea `01KXDCCVARK2Z441BB4B3Q06QK`
- `apps/api/src/services/task-title.ts`
- `apps/api/src/services/ai-proxy-shared.ts`
- `packages/shared/src/constants/ai-services.ts`
- `apps/api/tests/unit/services/task-title.test.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/32-cf-api-debugging.md`
- `tasks/active/2026-06-01-fix-task-title-generation-reasoning-output.md`
- `tasks/archive/2026-03-05-inconsistent-task-title-generation.md`
