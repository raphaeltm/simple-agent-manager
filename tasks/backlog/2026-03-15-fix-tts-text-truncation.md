# Fix TTS Text Truncation

## Problem

Audio playback of agent messages and task summaries cuts off mid-text. The user reported that a ~4,500 character agent response stops playing at roughly "That's an unusually hard constraint" — well before the end of the content.

## Root Cause Analysis

Three sequential truncation layers clip text before it reaches the Deepgram Aura 2 TTS model:

### 1. LLM Cleanup Default Max Tokens = 256 (PRIMARY)

`apps/api/src/services/tts.ts:113` — The Gemma 3 12B cleanup model (`cleanTextForSpeech()`) converts markdown to plain text via `agent.generate()` with **no `maxOutputTokens` setting**. Cloudflare Workers AI defaults to `max_tokens: 256`, producing ~800-1000 characters before stopping. This is the main cause of audio cutoff.

### 2. Task Summary Storage Cap = 2,000 chars

`apps/api/src/routes/mcp.ts:481` — Task output summaries are hard-truncated to 2,000 chars via `summary.slice(0, outputSummaryMaxLength)`. This affects task TTS but not agent message TTS.

### 3. TTS Input Cap = 5,000 chars

`apps/api/src/services/tts.ts:306` — The TTS pipeline truncates input to 5,000 chars. Not currently hit due to upstream truncation, but will clip longer content once #1 and #2 are fixed.

### No Diagnostic Logging

- `tts.ts:206` logs `textLength` after truncation, not before
- No logging of LLM cleanup input vs output length to detect when Gemma drops content

## Research Findings

- **Mastra agent.generate()** supports `modelSettings: { maxOutputTokens: N }` per [Mastra docs](https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/agents/generate.mdx)
- **Workers AI default max_tokens = 256** per [CF Workers AI docs](https://developers.cloudflare.com/workers-ai/models)
- **Deepgram Aura 2** has no documented text input character limit
- **DB schema** uses `text('output_summary')` — no column size constraint
- **Agent messages** are not truncated at storage time, only task summaries are
- **Constants** in `packages/shared/src/constants.ts` — all limits are configurable via env vars (constitution-compliant)

### Key Files

| File | Role |
|------|------|
| `apps/api/src/services/tts.ts` | TTS pipeline: cleanup → generate → cache |
| `apps/api/src/routes/tts.ts` | TTS HTTP endpoints |
| `apps/api/src/routes/mcp.ts` | Task completion (summary truncation) |
| `packages/shared/src/constants.ts` | Default constants for all limits |
| `packages/acp-client/src/hooks/useAudioPlayback.ts` | Frontend playback hook |

## Implementation Checklist

- [ ] Set `maxOutputTokens: 4096` on the Gemma 3 12B cleanup `agent.generate()` call in `tts.ts`
- [ ] Add configurable constant `DEFAULT_TTS_CLEANUP_MAX_TOKENS` in `packages/shared/src/constants.ts`
- [ ] Add `TTS_CLEANUP_MAX_TOKENS` env var support in `getTTSConfig()` and `TTSConfig`/`TTSEnvVars` interfaces
- [ ] Raise `DEFAULT_TTS_MAX_TEXT_LENGTH` from 5,000 to 10,000
- [ ] Raise `DEFAULT_OUTPUT_SUMMARY_MAX_LENGTH` from 2,000 to 10,000
- [ ] Add diagnostic logging: log original text length, post-cleanup text length, and ratio in `cleanTextForSpeech()`
- [ ] Raise `DEFAULT_TTS_TIMEOUT_MS` from 30,000 to 60,000 (longer text needs more generation time)
- [ ] Update existing tests to reflect new defaults
- [ ] Add test for cleanup max tokens being passed through to agent.generate()
- [ ] Invalidate R2 cache consideration: existing cached audio for truncated text — document that re-generation requires cache bust

## Acceptance Criteria

- [ ] Agent messages longer than 1,000 characters produce complete audio (not truncated)
- [ ] Task summaries up to 10,000 characters are stored without truncation
- [ ] LLM cleanup step outputs text proportional to input length (not capped at ~256 tokens)
- [ ] All TTS limits are configurable via environment variables
- [ ] Diagnostic logs show input vs output text lengths for the cleanup step
- [ ] Existing tests pass with updated defaults

## References

- `packages/shared/src/constants.ts:318-340` — TTS constants
- `apps/api/src/services/tts.ts` — Full TTS service
- `.claude/rules/03-constitution.md` — No hardcoded values (Principle XI)
