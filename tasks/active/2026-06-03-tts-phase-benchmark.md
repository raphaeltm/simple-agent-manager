# TTS Phase Benchmark Harness

## Problem

TTS generation is reliable but slow. We need a measured phase-by-phase breakdown of the cold staging path to determine whether latency is dominated by the upfront LLM cleanup/summary pass or by sequential per-chunk TTS generation. MP3 concatenation is expected to be near-zero but must be measured.

This is a throwaway measurement harness. It must not be merged to `main` or reach production. The workflow stops at a draft PR labeled `needs-human-review`.

## Research Findings

- Runbook source: SAM idea `01KT7BXS8QK64K953QF41NSP9D`.
- Existing TTS service: `apps/api/src/services/tts.ts`.
  - `generateSpeechAudio()` performs per-chunk R2 caching, so the benchmark must call `generateSpeechAudioChunk()` directly to measure cold model latency.
  - Existing exports include `getTTSConfig`, `cleanTextForSpeech`, `summarizeTextForSpeech`, `splitTextIntoChunks`, `generateSpeechAudioChunk`, `concatenateArrayBuffers`, `storeAudioInR2`, `buildR2Key`, and `fallbackStripMarkdown`.
  - Default chunk size is 1800 and max chunks is 8 after the prior Deepgram 2000-character limit fix.
- Existing TTS route: `apps/api/src/routes/tts.ts` uses `requireAuth()` and `requireApproved()`.
- Admin route pattern: `apps/api/src/routes/admin-ai-usage.ts` gates with `requireAuth()`, `requireApproved()`, and `requireSuperadmin()`.
- Auth middleware: `apps/api/src/middleware/auth.ts`; superadmin means `auth.user.role === 'superadmin'`.
- Staging rule: authenticate using `SAM_PLAYWRIGHT_PRIMARY_USER` against `https://api.sammy.party/api/auth/token-login`.
- Cloudflare rule: query staging D1 using `$CF_TOKEN` before guessing. The primary test user must be confirmed superadmin before running the benchmark.
- Testing rule: route tests must be behavioral vertical slices with realistic boundary mocks.

## Checklist

- [x] Create `apps/api/src/routes/tts-benchmark.ts` with a superadmin-gated `POST /` route.
- [x] Add the built-in markdown-heavy fixture sized for roughly seven 1800-character chunks.
- [x] Implement four benchmark variants over configurable iterations:
  - [x] `baseline-full`: LLM cleanup, sequential chunks, concat, store, delete.
  - [x] `parallel-chunks`: LLM cleanup, parallel chunks, concat/store if successful, capture errors without crashing.
  - [x] `no-cleanup`: regex markdown strip, sequential chunks, concat, store, delete.
  - [x] `summary`: LLM summary, sequential chunks, concat, store, delete.
- [x] Log `tts_benchmark.phase` events for corroboration in staging tail logs.
- [x] Mount the route at `POST /api/admin/tts-benchmark` in `apps/api/src/index.ts`.
- [x] Add behavioral route tests for non-superadmin 403 and superadmin reachability.
- [x] Run local API validation for the changed slice.
- [ ] Verify the primary staging test user is a superadmin via Cloudflare D1 query.
- [ ] Deploy the branch to staging through `deploy-staging.yml` and wait for green.
- [ ] Authenticate with `SAM_PLAYWRIGHT_PRIMARY_USER` and run `{ "iterations": 3 }` against staging.
- [ ] Capture raw JSON and tail-log corroboration.
- [ ] Create and upload `/benchmarks/tts/2026-06-03-tts-phase-benchmark.json`.
- [ ] Create and upload `/benchmarks/tts/2026-06-03-tts-phase-benchmark.md`.
- [ ] Open a draft PR only and label `needs-human-review`.

## Acceptance Criteria

- The harness route is superadmin-only and isolated to the draft branch.
- Benchmark results include per-run timings, summaries, chunk counts, bytes, and captured errors.
- Staging was used for the real measurement after confirming the test user role.
- Library contains both raw JSON and analysis Markdown artifacts.
- A draft PR exists and is not merged.

## References

- `apps/api/src/services/tts.ts`
- `apps/api/src/routes/tts.ts`
- `apps/api/src/routes/admin-ai-usage.ts`
- `apps/api/src/middleware/auth.ts`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/32-cf-api-debugging.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `tasks/archive/2026-03-22-fix-tts-chunk-size.md`
