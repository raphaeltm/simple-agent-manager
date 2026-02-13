# Voice-to-Text for Agent Chat

**Created**: 2026-02-13
**Status**: backlog

## Summary

Add a voice input button to the agent/chat interface that captures microphone audio, transcribes it via Cloudflare Workers AI (Whisper), and inserts the text into the chat prompt. This keeps the entire pipeline serverless and on-platform (no external STT services needed).

## Motivation

Typing on mobile is cumbersome, especially for longer prompts. A voice button lets users dictate their intent naturally. Since SAM is mobile-first and Cloudflare hosts Whisper models on Workers AI, this fits perfectly into our serverless architecture with minimal added infrastructure.

## Requirements

### Functional
- Voice button in the chat input area (next to the send button)
- Press-and-hold or toggle-to-record interaction (configurable)
- Visual recording indicator (pulsing icon, timer, waveform — pick one)
- Audio captured in browser, sent to API, transcribed, returned as text
- Transcribed text inserted into the chat input (user can review/edit before sending)
- Error states: microphone permission denied, transcription failure, audio too long

### Non-Functional
- Latency target: < 3 seconds for a 10-second recording
- Max recording duration: configurable (default 60 seconds)
- Supported audio format: WebM/Opus (MediaRecorder default) or WAV
- Mobile-first: button must be easily reachable with thumb (bottom-right of input area)

## Research Findings

### Cloudflare Workers AI — Whisper Models

Cloudflare hosts three Whisper variants:

| Model | ID | Pricing | Notes |
|-------|----|---------|-------|
| Whisper | `@cf/openai/whisper` | $0.00045/audio min | General-purpose, multilingual |
| Whisper Large v3 Turbo | `@cf/openai/whisper-large-v3-turbo` | $0.00051/audio min | Faster, more accurate |
| Whisper Tiny EN | `@cf/openai/whisper-tiny-en` | Beta (free?) | English-only, smallest/fastest |

**Recommendation**: Use `@cf/openai/whisper-large-v3-turbo` for quality. Consider `whisper-tiny-en` for English-only users who want lower latency. Model ID should be configurable per Constitution Principle XI.

**Free tier**: 10,000 Neurons/day included. Whisper uses ~41-47 neurons per audio minute, so free tier covers ~200-240 minutes of transcription per day.

**Alternative**: Cloudflare also hosts Deepgram models (`@cf/deepgram/nova-3`, `@cf/deepgram/flux`) which support real-time WebSocket STT. These could enable streaming transcription (show words as user speaks) but add complexity. Consider as a future enhancement.

### Workers AI Binding Configuration

Adding Workers AI to our API worker requires:

**1. wrangler.toml** — Add AI binding:
```toml
[ai]
binding = "AI"
```

**2. Env interface** (`apps/api/src/index.ts`) — Add binding type:
```typescript
export interface Env {
  // ... existing bindings ...
  AI: Ai; // Workers AI binding
}
```

**3. Usage in route handler**:
```typescript
const result = await c.env.AI.run('@cf/openai/whisper-large-v3-turbo', {
  audio: base64EncodedAudio, // or Uint8Array
});
// result.text = transcribed text
// result.words = [{ word, start, end }] (word-level timestamps)
// result.vtt = WebVTT subtitle format
```

### CF API Token Permissions

**Good news**: The AI binding does NOT require additional API token permissions. Unlike D1/KV/R2 which need explicit token scopes, the AI binding's permission is embedded in the binding itself — if the Worker has the `[ai]` binding declared, it can use Workers AI. No changes to `CF_API_TOKEN` permissions are needed.

However, the **Pulumi sync script** (`scripts/deploy/sync-wrangler-config.ts`) will need to be updated to preserve the `[ai]` section when rewriting wrangler.toml.

### Browser Audio Capture

Two viable approaches for capturing microphone audio in the browser:

**Option A: MediaRecorder API** (recommended)
- Supported in Chrome, Firefox, Edge, Safari 14.1+
- Records to WebM/Opus (Chrome) or MP4/AAC (Safari)
- Simple API: `navigator.mediaDevices.getUserMedia({ audio: true })` → `new MediaRecorder(stream)`
- Produces `Blob` that can be sent as `multipart/form-data` or base64-encoded
- No external dependencies needed

**Option B: Web Speech API (SpeechRecognition)**
- Browser-native STT — no server round-trip
- BUT: only works in Chrome/Chromium (not Firefox, not Safari)
- Uses Google's servers under the hood (privacy concern)
- Not suitable for our use case since we want Cloudflare-hosted inference

**Recommendation**: Use MediaRecorder API for audio capture, send to our API for Whisper transcription.

### Audio Format Considerations

- Whisper accepts raw audio bytes or base64-encoded audio
- MediaRecorder outputs WebM/Opus in Chrome, MP4/AAC in Safari
- Whisper handles both formats natively — no server-side conversion needed
- For large recordings, consider chunking (Cloudflare tutorial shows 1MB chunks)
- Practical limit: keep recordings under 60 seconds for chat use case

## Architecture

```
Browser (React)                    API Worker (Hono)           Workers AI
┌──────────────────┐              ┌──────────────────┐       ┌────────────┐
│ MediaRecorder API│              │ POST /api/        │       │ Whisper    │
│ getUserMedia()   │──audio blob──│   transcribe      │──AI───│ v3-turbo   │
│ Record button UI │              │                   │ bind  │            │
│ Chat input area  │◄──text──────│ { text: "..." }   │◄──────│ { text }   │
└──────────────────┘              └──────────────────┘       └────────────┘
```

### New API Endpoint

`POST /api/transcribe` — Accepts audio blob, returns transcribed text.
- Auth: requires valid session (same as other API routes)
- Input: `multipart/form-data` with audio file, or JSON with base64-encoded audio
- Output: `{ text: string, words?: Array<{ word, start, end }> }`
- Rate limit: configurable (e.g., `RATE_LIMIT_TRANSCRIBE` per hour)

### New UI Component

`VoiceButton` — Renders in the chat input toolbar.
- States: idle, recording, processing, error
- Permissions: handles `getUserMedia` permission flow gracefully
- Mobile: minimum 44px touch target, positioned for thumb reach

## Infrastructure Changes Required

### wrangler.toml
- Add `[ai]` binding section (top-level and per-environment)

### sync-wrangler-config.ts
- Update to preserve `[ai]` section when rewriting config

### Env interface
- Add `AI: Ai` binding to `Env` type

### CF API Token
- **No changes needed** — AI binding permissions are implicit

### Pulumi
- **No changes needed** — Workers AI doesn't require separate resource provisioning

### Constitution Compliance
- `WHISPER_MODEL_ID` — configurable model (default: `@cf/openai/whisper-large-v3-turbo`)
- `MAX_AUDIO_DURATION_SECONDS` — configurable max recording length (default: 60)
- `RATE_LIMIT_TRANSCRIBE` — configurable rate limit (default: 30/hour)

## Plan

### Phase 1: Infrastructure & API (Backend)
1. Add `[ai]` binding to wrangler.toml (all environments)
2. Update `Env` interface with `AI: Ai` binding
3. Update `sync-wrangler-config.ts` to handle AI binding
4. Create `POST /api/transcribe` route with Whisper integration
5. Add rate limiting and input validation (file size, duration)
6. Add unit/integration tests for transcription endpoint

### Phase 2: UI (Frontend)
1. Create `VoiceButton` component with recording states
2. Integrate MediaRecorder API for audio capture
3. Add microphone permission handling with user-friendly prompts
4. Wire into chat input area (alongside send button)
5. Add visual feedback: recording indicator, processing spinner
6. Mobile-responsive styling (56px touch target)
7. Add unit tests for component states

### Phase 3: Polish & Edge Cases
1. Handle Safari audio format differences (MP4 vs WebM)
2. Add configurable max duration with countdown
3. Error handling: network failure mid-upload, model timeout
4. Accessibility: keyboard shortcut for voice toggle, screen reader announcements
5. Optional: audio level visualization during recording

## Checklist
- [ ] Add `[ai]` binding to wrangler.toml
- [ ] Update `Env` interface with AI binding type
- [ ] Update sync-wrangler-config.ts to preserve AI binding
- [ ] Create `POST /api/transcribe` endpoint
- [ ] Add rate limiting for transcription
- [ ] Add configurable env vars (model ID, max duration, rate limit)
- [ ] Create VoiceButton component
- [ ] Integrate MediaRecorder API
- [ ] Handle microphone permissions UX
- [ ] Wire into chat input area
- [ ] Add recording/processing visual feedback
- [ ] Mobile-responsive styling
- [ ] Unit tests for API endpoint
- [ ] Unit tests for UI component
- [ ] Integration test for full flow
- [ ] Update CLAUDE.md/AGENTS.md with new endpoint and env vars
- [ ] Update self-hosting docs with Workers AI pricing note

## Cost Estimate

At $0.0005/audio minute:
- 100 voice messages/day averaging 15 seconds each = 25 minutes = $0.0125/day
- Monthly cost for moderate usage: ~$0.38
- Free tier (10k neurons/day) covers ~200+ audio minutes/day — more than enough for most users

## Implementation Notes

_To be filled during implementation._

## Issues & Failures

_To be filled during implementation._
