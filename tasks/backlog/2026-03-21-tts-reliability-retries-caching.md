# TTS Reliability: Retries, Per-Chunk Caching, Error Surfacing

## Problem

The TTS pipeline in `apps/api/src/services/tts.ts` chains multiple Workers AI calls sequentially (1 Gemma 3 cleanup/summary call + N Deepgram Aura 2 chunk calls). Any single failure kills the entire synthesis with no retry. The Deepgram model on Workers AI has ~50% per-call reliability, so multi-chunk requests compound to near-zero success.

## Research Findings

### Current Architecture (tts.ts)
- `synthesizeSpeech()` orchestrates: R2 cache check → text cleanup/summary (LLM) → chunking → audio generation → R2 store → return
- `generateSpeechAudioChunk()` calls `ai.run()` with a `Promise.race()` timeout — no retry on failure
- `generateSpeechAudio()` loops through chunks sequentially, calling `generateSpeechAudioChunk()` — any chunk failure aborts the whole request
- `cleanTextForSpeech()` and `summarizeTextForSpeech()` already have try/catch that falls back to regex — but only try once before falling back
- R2 caching is per-final-audio (whole concatenated result), so partial chunk progress is lost on failure

### Current Frontend (useAudioPlayback.ts)
- On server TTS failure, silently falls back to browser `speechSynthesis` — no error surfaced to user
- No `error` or `lastError` field in the hook return type
- `AudioPlayer.tsx` has no error display state

### Constants (shared/constants.ts)
- All TTS constants use `DEFAULT_` prefix with env var overrides — compliant pattern to follow
- No retry-related constants exist yet

### Config (TTSConfig, TTSEnvVars, getTTSConfig)
- Clean pattern: interface field + env var string field + `parsePositiveInt()` in getter
- Need to add `retryAttempts`, `retryBaseDelayMs` fields

## Implementation Checklist

### 1. Add retry constants and config
- [ ] Add `DEFAULT_TTS_RETRY_ATTEMPTS = 3` and `DEFAULT_TTS_RETRY_BASE_DELAY_MS = 500` to `packages/shared/src/constants.ts`
- [ ] Add `retryAttempts` and `retryBaseDelayMs` to `TTSConfig` interface
- [ ] Add `TTS_RETRY_ATTEMPTS` and `TTS_RETRY_BASE_DELAY_MS` to `TTSEnvVars` interface
- [ ] Add parsing to `getTTSConfig()`

### 2. Add retry utility function
- [ ] Create a `retryWithBackoff()` helper in `tts.ts` — exponential backoff with jitter
- [ ] Parameters: fn, maxAttempts, baseDelayMs
- [ ] Logs each retry attempt with attempt number, error, and delay

### 3. Add retry to `generateSpeechAudioChunk()`
- [ ] Wrap the `ai.run()` + response handling in `retryWithBackoff()`
- [ ] Use config.retryAttempts and config.retryBaseDelayMs
- [ ] Log retry attempts with chunk context (chunk index if available)

### 4. Add retry to LLM cleanup/summary
- [ ] Wrap the `agent.generate()` call in `cleanTextForSpeech()` with retry before falling back to regex
- [ ] Wrap the `agent.generate()` call in `summarizeTextForSpeech()` with retry before falling back to truncation
- [ ] Keep existing fallback behavior as final fallback after all retries exhausted

### 5. Per-chunk R2 caching
- [ ] Add `buildChunkR2Key()` — key format: `{prefix}/{userId}/{storageId}_chunk_{index}_{hash}.{encoding}`
- [ ] In `generateSpeechAudio()`, before generating each chunk: check R2 for cached chunk audio
- [ ] After each chunk succeeds: store it in R2 immediately
- [ ] On retry/re-request, skip chunks that already exist in R2 cache
- [ ] Pass R2 bucket through to `generateSpeechAudio()` and `generateSpeechAudioChunk()` (new parameter)
- [ ] Use a simple hash of chunk text content for the cache key

### 6. Surface errors to frontend
- [ ] Add `error: string | null` and `lastError: string | null` to `UseAudioPlaybackReturn` interface
- [ ] Set `error` when server TTS fails (extract error message from response)
- [ ] Set `lastError` to persist error after state returns to idle
- [ ] Clear `error` on new play attempt, keep `lastError` until next successful play
- [ ] Pass error through the synthesize endpoint — change `throw errors.internal('Failed to generate audio')` to include the actual error message

### 7. Show error in AudioPlayer UI
- [ ] Add `error` prop to `AudioPlayerProps`
- [ ] Display error message in the player when present (red text below controls)
- [ ] Add `error` prop to `MessageActions` AudioPlayer usage

### 8. Tests
- [ ] Test `retryWithBackoff()` — succeeds on Nth attempt, exhausts retries, backoff timing
- [ ] Test `generateSpeechAudioChunk()` retry — fails then succeeds
- [ ] Test `cleanTextForSpeech()` retry — retries before falling back to regex
- [ ] Test `summarizeTextForSpeech()` retry — retries before falling back
- [ ] Test per-chunk R2 caching — cache hit skips generation, cache miss generates and stores
- [ ] Test `getTTSConfig()` with new retry env vars
- [ ] Update existing tests that may be affected by new R2 parameter

## Acceptance Criteria

- [ ] TTS audio generation retries up to 3 times per chunk with exponential backoff
- [ ] LLM cleanup/summary retries before falling back to regex stripping
- [ ] Individual chunk audio is cached in R2 — partial progress survives failures
- [ ] Frontend displays actual error messages when TTS fails (not silent fallback)
- [ ] All retry/caching constants are configurable via environment variables
- [ ] All existing TTS tests continue to pass
- [ ] New tests cover retry logic, chunk caching, and error surfacing

## References

- `apps/api/src/services/tts.ts` — TTS service
- `apps/api/src/routes/tts.ts` — TTS HTTP endpoints
- `packages/shared/src/constants.ts` — TTS constants (lines ~398-436)
- `packages/acp-client/src/hooks/useAudioPlayback.ts` — Frontend playback hook
- `packages/acp-client/src/components/AudioPlayer.tsx` — Audio player UI
- `packages/acp-client/src/components/MessageActions.tsx` — Message action buttons
- `apps/api/tests/unit/services/tts.test.ts` — TTS service tests
