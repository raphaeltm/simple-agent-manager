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

- [ ] Capability resolver `services/platform-capabilities.ts` (sync, from bindings/settings) + public
      `/api/config/platform-capabilities`
- [ ] AI Gateway capability: one `resolveAiGatewayId` used by every gateway site; cron + budget
      skip quietly with a skip reason
- [ ] `Env.AI` optional; transcribe/TTS/classifier/catalog guarded; FEATURE_UNAVAILABLE error
- [ ] Analytics admin routes, observability log search, debug tool: not-available state
- [ ] Guided setup + Instant gated on container runtime capability (`CONTAINER_RUNTIME_AVAILABLE`)
- [ ] OpenAI-compatible LLM admin settings (base URL, encrypted API key, models) + one chat
      target resolver; rewire task titles, diagnosis, /ai/v1 Workers AI route, SAM agent,
      project agent, operator
- [ ] Agent-model catalog: clean not-available state without Workers AI
- [ ] Presign: configurable endpoint/bucket/prefix/path-style/region; consolidate S3 client;
      key-mapping tests
- [ ] Shared client IP helper
- [ ] Web: capabilities hook; hide voice input and server TTS when unavailable; Playwright audit
- [ ] Tests in both configurations for each guard
- [ ] celld verification: GET crawl + crons, zero 5xx, zero error logs from absent services
- [ ] PR body: service table, verified vs not, open questions

## Acceptance criteria

- Cloudflare configuration (all bindings + settings): behaviour unchanged (tests).
- Absent configuration: no 5xx from absent services, no error-level logs from absent services in
  crons, UI hides voice/TTS, guided setup not advertised.
- OpenAI-compatible endpoint configured: task titles, SAM agent, diagnosis, /ai/v1 Workers AI
  route reach it with the configured model and key; key stored encrypted.
- Presigned keys map to `<prefix><r2Key>` against the configured bucket; default unchanged.
