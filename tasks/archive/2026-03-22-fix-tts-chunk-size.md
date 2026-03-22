# Fix TTS Chunk Size Exceeding Deepgram Aura 2 Limit

## Problem

The `DEFAULT_TTS_CHUNK_SIZE` constant is set to 4000 characters, but Cloudflare Workers AI Deepgram Aura 2 (`@cf/deepgram/aura-2-en`) enforces a hard 2000 character limit. Any chunk over 2000 chars returns a 413 error: `Input text exceeds maximum character limit of 2000`. This causes most TTS requests for non-trivial text to fail.

## Research Findings

- **Constants**: `packages/shared/src/constants.ts` lines 427, 431, 436
  - `DEFAULT_TTS_CHUNK_SIZE = 4000` — exceeds 2000 char model limit
  - `DEFAULT_TTS_MAX_CHUNKS = 8` — unchanged
  - `DEFAULT_TTS_SUMMARY_THRESHOLD = 30000` — should be aligned to new chunk size × max chunks
- **TTS service**: `apps/api/src/services/tts.ts` — uses constants via `getTTSConfig()`, all configurable via env vars
- **Tests**: `apps/api/tests/unit/services/tts.test.ts` — several assertions reference old values:
  - Lines 249, 258: `toBeLessThanOrEqual(4000)` in summary fallback tests
  - Line 467: `chunkSize: 4000` in generateSpeechAudio test
  - Lines 806, 808: `toBe(4000)` and `toBe(30000)` in getTTSConfig defaults test

## Implementation Checklist

- [ ] Change `DEFAULT_TTS_CHUNK_SIZE` from `4000` to `1800` in `packages/shared/src/constants.ts`
- [ ] Change `DEFAULT_TTS_SUMMARY_THRESHOLD` from `30000` to `14400` (1800 × 8) in `packages/shared/src/constants.ts`
- [ ] Update comments referencing the old values
- [ ] Update test assertions that hardcode `4000` or `30000` for these defaults
- [ ] Add test verifying `splitTextIntoChunks` never produces chunks exceeding max size
- [ ] Run `pnpm typecheck && pnpm lint && pnpm test` to confirm all pass

## Acceptance Criteria

- [ ] `DEFAULT_TTS_CHUNK_SIZE` is 1800 (safe margin under 2000 hard limit)
- [ ] `DEFAULT_TTS_SUMMARY_THRESHOLD` is 14400 (aligned to chunk size × max chunks)
- [ ] All existing tests pass with updated values
- [ ] New test validates no chunk exceeds configured max size
- [ ] No hardcoded magic numbers — values remain configurable via env vars
