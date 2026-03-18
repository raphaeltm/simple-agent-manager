# TTS Long Text: Chunking & Summarization

## Problem

Longer text fails to convert to audio via the Deepgram Aura 2 TTS model on Cloudflare Workers AI. The model has an internal per-request text length limit. Currently, the `synthesizeSpeech()` pipeline sends all text (up to 10,000 chars) in a single `ai.run()` call, which fails for longer content.

Previous fix (task `2026-03-15-fix-tts-text-truncation`) raised limits (cleanup tokens 256→4096, text cap 5000→10000, timeout 30s→60s) but did not address the fundamental single-request limit.

## Root Cause

`generateSpeechAudio()` in `apps/api/src/services/tts.ts:182` sends the entire cleaned text to the TTS model in one call. When the text exceeds the model's internal limit, the request fails silently or returns an error.

## Research Findings

### Key Files

| File | Role |
|------|------|
| `apps/api/src/services/tts.ts` | TTS pipeline: cleanup → generate → cache |
| `apps/api/src/routes/tts.ts` | TTS HTTP endpoints |
| `packages/shared/src/constants.ts:347-376` | TTS constants |
| `packages/acp-client/src/hooks/useAudioPlayback.ts` | Frontend playback hook |
| `apps/api/tests/unit/services/tts.test.ts` | TTS service tests |

### Architecture

- Text → LLM cleanup (Gemma 3 12B) → clean text → Deepgram Aura 2 → MP3 → R2 cache
- Frontend fetches via POST /api/tts/synthesize → GET /api/tts/audio/:storageId
- MP3 frames are self-contained — MP3 files can be concatenated by appending buffers

### Two Solutions

**1. Text Chunking (primary fix)**
- Split cleaned text into chunks at sentence boundaries (~4000 chars each)
- Generate audio for each chunk via separate `ai.run()` calls
- Concatenate the resulting MP3 ArrayBuffers into a single audio file
- Store the concatenated result in R2 as before
- This is transparent to the frontend — same API, same playback

**2. Summarization Mode (for very long texts)**
- When text exceeds a configurable threshold (e.g., 50,000 chars), use the LLM to produce a spoken summary instead of reading verbatim
- Reuse the existing cleanup LLM step but with a different prompt ("summarize for audio")
- Add a `mode` parameter to the synthesize API: `"full"` (default, with chunking) or `"summary"`
- Frontend can show indicator that summary mode was used

## Implementation Checklist

### Backend — Chunking

- [ ] Add `DEFAULT_TTS_CHUNK_SIZE` constant (4000 chars) in `packages/shared/src/constants.ts`
- [ ] Add `TTS_CHUNK_SIZE` env var support in `TTSConfig`, `TTSEnvVars`, and `getTTSConfig()`
- [ ] Create `splitTextIntoChunks(text: string, maxChunkSize: number): string[]` in `tts.ts`
  - Split at sentence boundaries (`. `, `! `, `? `, newlines)
  - Fallback: split at word boundaries if no sentence boundary found within limit
  - Never split mid-word
- [ ] Modify `generateSpeechAudio()` to accept chunked text: if text > chunk size, split and generate each chunk, then concatenate ArrayBuffers
- [ ] Add logging for chunk count and per-chunk generation times
- [ ] Remove the hard text truncation in `synthesizeSpeech()` — with chunking, we can handle any length

### Backend — Summarization

- [ ] Add `DEFAULT_TTS_SUMMARY_THRESHOLD` constant (50000 chars) in `packages/shared/src/constants.ts`
- [ ] Add `TTS_SUMMARY_THRESHOLD` env var support
- [ ] Add summarization prompt in `tts.ts` for condensing very long text
- [ ] Add `mode` field to synthesize request body: `"full"` | `"summary"` (default: auto-detect based on length)
- [ ] When mode is "summary" or text exceeds threshold, summarize via LLM before TTS
- [ ] Add `summarized: boolean` to synthesize response so frontend can indicate it

### Frontend

- [ ] Update `useAudioPlayback` to pass `mode` parameter if needed
- [ ] Show indicator in AudioPlayer when content was summarized (optional, nice-to-have)

### Tests

- [ ] Unit test: `splitTextIntoChunks` splits at sentence boundaries
- [ ] Unit test: `splitTextIntoChunks` handles text shorter than chunk size (no split)
- [ ] Unit test: `splitTextIntoChunks` handles text with no sentence boundaries (word boundary fallback)
- [ ] Unit test: `generateSpeechAudio` with chunking — calls ai.run once per chunk, returns concatenated buffer
- [ ] Unit test: synthesizeSpeech with long text — uses chunking, stores concatenated audio
- [ ] Unit test: summarization mode — uses summary prompt instead of cleanup prompt
- [ ] Update existing tests to work with new chunking behavior

### Configuration

- [ ] Update `apps/api/.env.example` with new env vars
- [ ] Raise `DEFAULT_TTS_MAX_TEXT_LENGTH` to 100000 (with chunking, we can handle much more)

## Acceptance Criteria

- [ ] Text of 20,000+ characters successfully converts to complete audio (not truncated)
- [ ] Audio from chunked text plays seamlessly (no gaps or artifacts at chunk boundaries)
- [ ] Very long text (50,000+ chars) automatically summarizes for audio
- [ ] All TTS limits remain configurable via environment variables
- [ ] Existing tests pass with new chunking behavior
- [ ] New tests cover chunking logic, concatenation, and summarization

## References

- `tasks/archive/2026-03-15-fix-tts-text-truncation.md` — Previous truncation fix
- `apps/api/src/services/tts.ts` — TTS service implementation
- `.claude/rules/03-constitution.md` — No hardcoded values
