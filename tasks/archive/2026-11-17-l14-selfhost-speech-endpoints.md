# L14: self-host speech endpoints (TTS/STT through an OpenAI-compatible endpoint)

SAM task 01M7M46DHXHMQAPH6QRR1H032H, landing plan idea 01M72M9AEB933ZY8269D376DKC (part 6, row L14).
Source: integration branch `sam/selfhost-pass-2` (`speech-endpoint-settings.ts`, `speech-endpoints.ts`,
route and `tts.ts` changes), ported by hand onto a fresh branch from main.

## Problem

On a Workers-compatible runtime without the Workers AI binding (the self-host celld build), the chat
microphone and server read-aloud answer FEATURE_UNAVAILABLE (L11). The integration branch lets an
admin point both at an OpenAI-compatible endpoint (`/audio/transcriptions`, `/audio/speech`).

## Placement decision (Raphaël's Nov 14 rule)

Case 1: the path runs only without the Workers AI binding. Evidence from `sam/selfhost-pass-2`:

- `routes/transcribe.ts`: `const endpoint = ai ? null : await resolveSpeechEndpoint(...)`.
- `routes/tts.ts`: `const ai = binding ?? (await resolveSpeechEndpoint(...))`.
- `resolvePublicPlatformCapabilities`: "With the Workers AI binding no speech setting is read".
- Setting description: "Used only where Cloudflare Workers AI is not available."

There is no admin choice to use an endpoint on Cloudflare (unlike L12), so the implementation lives
under `apps/api/src/selfhost/speech/` (never imported by `src/index.ts`) and the Worker keeps only a
seam: `services/speech-backend.ts` (interface + installer) and an admin-settings registry install
point (`installAdminSettingDefinitions`).

## Research findings

- L11 seam: `services/platform-capabilities.ts` (`getWorkersAiBindingOrNull`, `publicPlatformCapabilities`),
  `errors.featureUnavailable`, `routes/platform-capabilities.ts`.
- L5a: `guardedFetch` in `packages/worker-core/src/network-hosts`; per-hop host validation, cross-origin
  hops drop credential headers; `init.signal` spans every hop.
- L17a (PR #2831, open) uses the same pattern: self-host-only code under `src/selfhost/`, an installer
  the self-host entry calls, and an import-graph test. Its `tests/helpers/selfhost-only-modules.ts`
  may supersede this PR's own guard test when it merges.
- Admin settings registry was a static const; settings only the self-host build has need an install point.
- Integration's TTS rate limit used a new `RATE_LIMIT_TTS_SYNTHESIZE` env var; policy 9017df94 says
  tunables are admin settings, so it becomes `speech.synthesis.maxRequestsPerHour` in the self-host module.
- Integration's `guardedFetchWithDeadline` and `isAcceptableOperatorEndpoint` are not on main: use
  `guardedFetch` + `AbortSignal.timeout`, and the `validLlmBaseUrl` rule.
- The self-host entry generator (`scripts/selfhost/celld-project.ts`) is not on main yet; the integration
  packager (L22) must call `installSpeechEndpoints()` from the self-host entry.

## Checklist

- [x] `services/speech-backend.ts`: interface, installer, resolvers gated on the binding, async capabilities
- [x] Admin settings registry install point; resolution and mutations read `adminSettingsRegistry()`
- [x] Routes: transcribe, tts (admit + 503 hiding backend errors), platform-capabilities
- [x] `services/tts.ts`: `SpeechAudioSource`, regex markdown strip and chunk-bounded text without Workers AI
- [x] `selfhost/speech/{settings,endpoints,index}.ts` ported from integration, every fetch through `guardedFetch`
- [x] Tests: vertical slice through routes + settings store + guardedFetch; Cloudflare control; nothing-installed control;
      import-graph guard; each guard mutation-checked
- [x] Docs: API reference capabilities paragraph, chat-features voice/TTS note
- [x] Reviewers: security-auditor and cloudflare-specialist (no CRITICAL/HIGH; retry amplification, truncation log,
      capability log fixed), task-completion-validator (WARN, no CRITICAL/HIGH; added no-retry, empty-audio, truncation,
      timeout and capability-fallback tests, each mutation-checked)
- [x] API lint + typecheck; related suites (31 files, 467 tests) pass
- [ ] Staging: read-aloud plays audio, mic returns text, capabilities both true (Cloudflare unchanged)

## Notes

- Retry: the integration branch retried each endpoint chunk 3x. Dropped: every call spends the admin's endpoint and
  a 4xx would only repeat; a transient failure answers 503 and the client can retry the read-aloud.
- No audio-duration limit exists on main or on the integration branch; size (`MAX_AUDIO_SIZE_BYTES`), TTS text and
  chunk limits and the endpoint timeout are the configurable bounds.
- Staging can only prove the Cloudflare path (binding present): nothing on main calls `installSpeechEndpoints()`.

## Acceptance criteria

- Cloudflare with nothing configured: read-aloud and mic behave exactly as today, with no extra read
  (test: "with the Workers AI binding the backend is never consulted"; staging).
- Every outbound speech fetch uses `guardedFetch`; outbound-fetch baseline not raised.
- Audio size (`MAX_AUDIO_SIZE_BYTES`), TTS text/chunk limits and the endpoint timeout stay configurable.
- `src/index.ts` never reaches `src/selfhost/` (import-graph test).

## Takeover validation (2026-11-17)

Task 01M7NBJG2R8Z6W3R5AZJQ2FZ6B resumes existing PR #2840 and branch. Main merged with
#2841 safe deploy workflow (0c672ddbf); `quality:no-secret-readback` passes.

- [x] Resolve Codex synthesis voice P1: require configured voice before advertising TTS; route regression.
- [x] Resolve non-audio response P1: reject declared non-audio media before caching; JSON/HTML route regressions.
- [x] Resolve response bound P2: `speech.synthesis.maxAudioBytes` (8 MiB default, max32 MiB), streamed byte
  counter and declared-length precheck; cancellation/no-cache regressions and exact-boundary controls.
- [x] Resolve partial-cache P2: disable endpoint partial caching, preserving Workers AI caching. Endpoint,
  model and voice changes across failed request/retry exercise real routes/settings and final R2 output.
- [x] Resolve capability browser-cache P2: no-store without Workers AI; Cloudflare public config unchanged.
- [x] Focused7files153tests pass. Mutation checks fail for removed voice/MIME/size/cache guards, then restored.
- [x] Security/Cloudflare/completion delta reviews PASS (no blockers); prior unchanged-area evidence retained.
- [ ] New-head full CI, live Cloudflare staging, cleanup/release, coordinator hold lift, normal merge.

OpenAI speech reference verified Nov17: https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
requires voice. Compatibility providers should configure their own valid voice. Missing audio MIME is accepted for
compatible raw-byte endpoints; known non-audio is refused. Endpoint partial retries now spend regeneration calls
instead of introducing a new cache-identity contract. The existing final-audio cache behavior is unchanged.

- [x] Sixth automated finding (transcription JSON unbounded): reuse shared bounded stream reader before JSON parsing, configurable speech.transcription.maxResponseBytes (1MiB default,4MiB max); three route regressions RED before fix and GREEN with exact13-byte control; delta security/Cloudflare/completion PASS.
