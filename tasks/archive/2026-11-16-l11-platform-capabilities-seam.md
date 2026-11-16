# L11: Platform capabilities seam (landing slice from sam/selfhost-pass-2)

SAM task: 01M7K0FF1BX0BWGDT32PH49XNT. Landing plan: idea 01M72M9AEB933ZY8269D376DKC (part 5, row L11).

## Problem

An installation without some Cloudflare service (Workers AI, so no speech-to-text, read-aloud or
Cloudflare model catalog) shows mic, speaker and model-access controls that fail when used. The
integration branch added one resolver for "is this service here?", a public no-I/O endpoint, a web
hook, and gates on those controls. Later slices (L12, L14, L15, L20, L22) build on it.

## Research findings

- Integration branch resolver (`apps/api/src/services/platform-capabilities.ts`) imports modules
  that do not exist on main (`hosted-git/backend`, `analytics-d1-sink`, `r2-presign-config`,
  `agent-email/self-host-inbound`, `ai-proxy` gateway helpers). Trimmed to the capabilities whose
  inputs exist on main and that this slice's consumers read: `workersAi`, `speechToText`,
  `textToSpeech`. Public answer: `speechToText`, `textToSpeech`, `agentModelCalls`. Other fields
  arrive with their consumers in later slices; the web client fills unknown keys with "available".
- Integration branch route calls `resolvePublicPlatformCapabilities()` (speech endpoints, a settings
  read: slice L14). Here the route is synchronous with no I/O (rule 60).
- tts/transcribe: integration branch adds speech-endpoint fallbacks and a KV rate limit (L14). Here
  only the "no Workers AI binding -> FEATURE_UNAVAILABLE 404" refusal.
- agent-models: `WorkersAiUnavailableError` from `getAgentModelCatalog`, mapped to
  FEATURE_UNAVAILABLE in the REST catalog route and to `not_available` in agent-facing calls.
- `project-route-prefetch.ts` on the integration branch reverts main's Overview prefetch (F2): only
  the capabilities prefetch line is ported.
- Production (`sam-api-prod`, read 2026-11-16 20:31 UTC with the production debugging token,
  read-only): `AI` binding present (type `ai`); `TTS_ENABLED` unset; `LOG_TAIL_AVAILABLE` unset;
  tail consumer `sam-tail-worker-prod` attached; `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_ZONE_ID`
  present; `SETUP_TOKEN` present; no `ASSETS` (not an input to this slice). Every L11 capability
  resolves true.
- Integration route test lived under `tests/unit/selfhost/`; moved to `tests/unit/routes/`.

## Checklist

- [ ] API resolver `services/platform-capabilities.ts` (pure, trimmed)
- [ ] `errors.featureUnavailable` in `middleware/error.ts`
- [ ] Public route `GET /api/config/platform-capabilities` (no I/O, public-config cache headers)
- [ ] tts + transcribe refuse with FEATURE_UNAVAILABLE without the AI binding
- [ ] agent-models `WorkersAiUnavailableError` (catalog, route, list, run, project-settings, errors)
- [ ] Web api client, query options, stale time, hook, prefetch
- [ ] Voice gates: ProjectChatComposer, CommentComposer, SamComposer, ChatSession, ProjectAgentChat
- [ ] Read-aloud gates: AcpConversationItemView (+ list owners), TruncatedSummary
- [ ] Model gates: AgentModelAccessField, ProjectAgentModelsSection
- [ ] Tests: resolver (incl. Cloudflare-shaped env resolves all true via real resolver), route test
      (neutral location), web UI test, Playwright audit (375/1280, all-true and some-false)
- [ ] Docs: configuration reference mentions the endpoint and FEATURE_UNAVAILABLE

## Acceptance criteria

- Cloudflare-shaped env resolves every capability to true (test through the real resolver).
- Endpoint returns booleans only and does no D1/KV I/O.
- While capabilities load or on error, every control stays visible (no flicker on Cloudflare).
- With a capability false, its control is hidden and layout stays clean at 375 and 1280 px.
- Staging: endpoint all true; mic and read-aloud visible and working; model catalog unchanged.
