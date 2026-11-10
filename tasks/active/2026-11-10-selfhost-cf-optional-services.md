# Self-host pass 2, T3: SAM API runs cleanly without Cloudflare-only services

Coordinator task: 01M72KTXWD8FJ0Z7TXKN5GF20J. Integration branch: `sam/selfhost-pass-2`.
Idea: 01M72M9AEB933ZY8269D376DKC (sections 2 and 5, conditions 8 and 9).

## Problem

On celld (and any non-Cloudflare runtime) the unmodified Worker boots, but several routes and
crons assume Cloudflare services exist and return 5xx, log errors every hour, or advertise
features that cannot work (spike Track A F13-F17, F20; Track C item 6).

## Hard constraint

A Cloudflare deployment with every binding and setting present behaves exactly as today. Every
change is a guard or an alternative that only activates when a binding/credential/setting is
absent or explicitly configured. Tests cover both configurations (apps/api rule 69).

## Research findings

- AI Gateway call sites gate on `env.AI_GATEWAY_ID` only, but wrangler.toml ships
  `AI_GATEWAY_ID="sam"`, so on celld every gateway path builds
  `gateway.ai.cloudflare.com/v1/undefined/...` (F14, F17). Sites: ai-monthly-cost-cron,
  usage.ts (/ai, /ai/budget), admin-costs, admin-ai-usage, ai-proxy-shared URL builders,
  ai-proxy-upstream (OpenAI URLs), agent-loop-helpers (duplicate Anthropic builder),
  agent-models/workers-ai.ts.
- `buildWorkersAIGatewayUrl` callers: fetchWorkersAIChatCompletion (task titles),
  debug-agent-tools.complete (diagnosis runner), ai-proxy-upstream.forwardToWorkersAI,
  agent-loop callWorkersAILLM (SAM + project agent), operator/model.ts (Mastra operator).
- `env.AI` typed non-optional; direct users: transcribe.ts (500, no flag), tts.ts (500 leaks
  internal message), stalled-task-classifier (F20: throws inside Promise.race construction ->
  orphan timer -> unhandled rejection), agent-models catalog/workers-ai (clean 503).
- Analytics admin routes call `queryAnalyticsEngine` which throws `errors.internal` when
  CF_ACCOUNT_ID is unset (500).
- Workers Observability search: worker-log-query returns 400; debug agent tool calls it raw.
- Guided credential setup advertises `enabled` from binding presence alone (F15). SANDBOX_ENABLED
  is NOT set on Cloudflare production, so gating on it would break Cloudflare; a container
  runtime declaration is needed (binding presence cannot tell celld's plain DO from a container).
- Artifacts and email are already binding-gated (`ARTIFACTS_ENABLED && ARTIFACTS`,
  `hasAgentEmailBinding`); resolver should reuse them.
- Presign: `r2-s3-client.ts` hardcodes `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  compose-image-artifacts.ts has a duplicate S3 client (rule 24). celld stores R2 objects at
  `r2/<bucket_name>/<key>`; metadata header `x-amz-meta-celld-r2`.
- CF-Connecting-IP read in 12 places with inconsistent fallbacks (XFF whole string vs first entry).
- Admin settings registry supports secret settings stored encrypted in `platform_credentials`
  (`credential: {provider, kind}`), rendered generically by AdminSettings.tsx.

## Implementation checklist

- [x] Capability resolver `services/platform-capabilities.ts` (sync, from bindings/settings) + public
      `/api/config/platform-capabilities`
- [x] AI Gateway capability: one `resolveAiGatewayId` used by every gateway site; cron + budget
      skip quietly with a skip reason
- [x] `Env.AI` optional; transcribe/TTS/classifier/catalog guarded; FEATURE_UNAVAILABLE error
- [x] Analytics admin routes, observability log search, debug tool: not-available state
- [x] Guided setup + Instant gated on container runtime capability (`CONTAINER_RUNTIME_AVAILABLE`)
- [x] OpenAI-compatible LLM admin settings (base URL, encrypted API key, models) + one chat
      target resolver; rewire task titles, diagnosis, /ai/v1 Workers AI route, SAM agent,
      project agent, operator
- [x] Agent-model catalog: clean not-available state without Workers AI
- [x] Presign: configurable endpoint/bucket/prefix/path-style/region; consolidate S3 client;
      key-mapping tests
- [x] Shared client IP helper
- [x] Web: capabilities hook; hide voice input and server TTS when unavailable; Playwright audit
- [x] Tests in both configurations for each guard
- [x] celld verification: GET crawl + crons, zero 5xx, zero error logs from absent services
- [ ] PR body: service table, verified vs not, open questions

## Acceptance criteria

- Cloudflare configuration (all bindings + settings): behaviour unchanged (tests).
- Absent configuration: no 5xx from absent services, no error-level logs from absent services in
  crons, UI hides voice/TTS, guided setup not advertised.
- OpenAI-compatible endpoint configured: task titles, SAM agent, diagnosis, /ai/v1 Workers AI
  route reach it with the configured model and key; key stored encrypted.
- Presigned keys map to `<prefix><r2Key>` against the configured bucket; default unchanged.

## Progress log (tracked; .do-state.md is wiped on workspace restarts)

### celld verification (done 2026-11-10, celld 0.6.3 real node + pgsty/minio; no AI/Analytics/Artifacts/email, no CF account, AI_GATEWAY_ID="sam")
- /api/config/platform-capabilities all false; instant-runtime false; guided setup `enabled:false`.
- transcribe, tts, agent-models catalog, worker log search, admin analytics: 404 FEATURE_UNAVAILABLE. Admin analytics was a 500 on celld (ANALYTICS_DATASET is only generated by the CF deploy) until the router gate in 1e93adb4f; the unit fixture had hidden it.
- usage/ai, usage/ai/budget, admin/costs: 200, no gateway calls.
- Real scheduled() for all three crons: */5 failedSweeps=[]; hourly monthlyCostSkipReason=ai_gateway_unavailable, 0 errors; daily 5 jobs fulfilled.
- GET crawl, 303 web-client paths: 103x200, 185x404 (fake ids), 6x400, 5x401, 3x403, 1x500. The 500 is repository-access/discover calling GitHub with a seeded fake installation (Track A F13c), not Cloudflare.
- Error-level logs in the window: 3 (that 500; two better-auth 404s for a fake api-token id). None from an absent Cloudflare service.
- LLM endpoint set via PATCH /api/admin/settings (key never returned) to a local mock: SAM agent turn completed (model agentModel, 18 tools); project agent streamed (28 tools); task title (taskTitleModel); diagnosis and /ai/v1 Workers AI route (default model). Every call had the Bearer key and no cf-aig-metadata.
- Presign: API presigned PUT -> /celld-fleet/r2/<bucket>/temp-uploads/... 200, R2 binding head/get/list agree (size, content type, bytes). Binding PUT -> presigned GET returns bytes + content type. Prefix-scoped credential denied on deploy/, cells/, other r2 bucket, manifest.json.

### Review status
- constitution-validator: ADDRESSED (4657787ef)
- security-auditor: 0 CRIT/HIGH; fixing MEDIUMs (R2 key traversal guard, client IP validation) + LOWs (no redirects, metadata/link-local hosts d5de46953, R2 partial config/prefix slash, third-party error body logging)
- cloudflare-specialist: 0 CRIT/HIGH; fixing M1 (read baseUrl first), M2 (container runtime gates start paths), M3 (fail closed only when endpoint configured), L1/L2/L3; M4 documented (proxy accounting uses requested model id)
- task-completion-validator: FAIL -> fixing: LlmUnavailableError handling in agent loop/operator/diagnosis + tests; /ai/v1, diagnosis, operator endpoint tests; client IP sites; agent-loop split; trim unused public flags; Playwright spec commit. Decisions to record: catalog stays 404 (run_ai_model is Workers-AI-shaped), public docs out of scope per coordinator.
- test-engineer, ui-ux-specialist: interrupted by restarts; resume.

### Remaining (commits 4203b1256..0251efe18 done)
- [x] llm-chat-target: baseUrl-first read, fail closed when configured+unreadable, redirect:'error' for endpoint targets
- [x] LlmUnavailableError handling: agent loop, operator, diagnosis + tests
- [x] R2: key traversal guard, prefix trailing slash, R2_S3_* without endpoint -> null, endpoint host rule, client cache key incl. secret
- [x] container runtime gate in getVmAgentContainerConfig + sandbox; workers-ai.ts binding gateway check restored
- [x] client IP value validation; chat-load-diagnostics + app-error-handler via helper
- [x] ai-proxy-upstream: no third-party error body in logs
- [x] split agent-loop LLM calls out; trim public capabilities to consumed flags
- [x] tests: /ai/v1 endpoint + 404, diagnosis endpoint, operator endpoint
- [x] Playwright spec + screenshots (spec fixed: epoch timestamps, held TTS; comment composer case added)
- [x] draft PR vs sam/selfhost-pass-2 (#2622 kept); publish URL + SHA to channel at the end

### Continuation (task 01M739ZV3VS1YV1RYZC53MVN7M, 2026-11-10, after the workspace eviction)
- Merged origin/sam/selfhost-pass-2 twice: T1 (abf141a55; env.ts conflict, kept AI optional + ASSETS) and T2
  (b7ce7341f; index.ts conflict, T2 moved the ws-* proxy imports out). T1's generator names agree:
  CONTAINER_RUNTIME_AVAILABLE="false", R2_S3_BUCKET/R2_S3_KEY_PREFIX (trailing slash)/R2_S3_ENDPOINT/R2_S3_REGION.
- test-engineer: H1 compose presign both stores + traversal, H2 settings API never returns key, M1/M2 (real
  gap: an unreadable endpoint setting fell back to Cloudflare; now refused once this isolate saw an endpoint;
  a cold isolate keeps the pre-endpoint route so Cloudflare is unchanged), M3, M4, M5 (IPv6 validation was
  loose), M6, M7, L1 fixed. Deferred LOW: L5 classifier via sweep, L6 daily skipReason log line (pass-through;
  source unit-tested), L7, L8 byte-identical presign signing, L9 snapshot presign operator store.
- Found via test-engineer: OpenAI forwarders sent the Cloudflare token as cf-aig-authorization to
  api.openai.com when the gateway was unaddressable, and cf-aig-metadata went to direct providers. Fixed at
  resolveUnifiedBillingToken + aiGatewayOnlyHeaders.
- ui-ux-specialist: HIGH comment composer kept pr-14 without a mic (fixed + Playwright measured case);
  capabilities error was cached as success (now throws except 404; project route prefetches); endpoint-error
  spec now clicks read-aloud. security-auditor delta: 0 CRIT/HIGH/MED; LOW-2 canonical IP keys and LOW-3
  unified-billing save guard fixed; LOW-1 (cold-isolate outage) documented as an open question.
