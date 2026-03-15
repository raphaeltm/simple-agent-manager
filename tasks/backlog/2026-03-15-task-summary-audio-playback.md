# Task Summary Audio Playback

## Problem

The audio generation system (TTS via Cloudflare Workers AI) works well for agent chat messages. Task summaries (`outputSummary`) displayed on the TaskDetail page should also support audio playback, allowing users to listen to task completion summaries.

## Research Findings

### Existing Audio Infrastructure (fully reusable)
- **Hook**: `useAudioPlayback()` in `packages/acp-client/src/hooks/useAudioPlayback.ts` — handles server TTS, browser fallback, blob caching, abort, seek, speed control
- **Component**: `AudioPlayer` in `packages/acp-client/src/components/AudioPlayer.tsx` — seek bar, skip, speed selector, play/pause/stop
- **API**: `POST /api/tts/synthesize` + `GET /api/tts/audio/:storageId` in `apps/api/src/routes/tts.ts`
- **Service**: `synthesizeSpeech()` in `apps/api/src/services/tts.ts` — markdown cleanup via LLM, TTS via Deepgram Aura 2, R2 caching
- Both hook and component are exported from `@simple-agent-manager/acp-client`

### Current Usage Pattern (in chat messages)
- `ProjectMessageView.tsx` uses `getTtsApiUrl()` from `apps/web/src/lib/api.ts` to get TTS base URL
- Passes `ttsApiUrl` and `ttsStorageId` (message ID) to `AcpMessageBubble` which uses `MessageActions`
- `MessageActions` calls `useAudioPlayback({ text, ttsApiUrl, ttsStorageId })`
- Shows speaker button + AudioPlayer when active

### Task Summary Display (target for integration)
- `TaskDetail.tsx` at `apps/web/src/pages/TaskDetail.tsx`
- Output section (lines 291-323) shows `task.outputSummary`, `task.outputBranch`, `task.outputPrUrl`
- Task ID (`task.id`) is unique and suitable as `ttsStorageId`
- Storage key pattern: `tts/{userId}/task-{taskId}.mp3` (prefix with "task-" to avoid collision with message IDs)

## Implementation Checklist

- [ ] Import `useAudioPlayback` and `AudioPlayer` from `@simple-agent-manager/acp-client`
- [ ] Import `getTtsApiUrl` from `../lib/api`
- [ ] Add `useAudioPlayback` hook call in TaskDetail component with `task.outputSummary` text
- [ ] Add speaker button in the Output section header (next to "Output" heading)
- [ ] Show `AudioPlayer` component when audio is active (state !== 'idle')
- [ ] Use `task-${task.id}` as the TTS storage ID to namespace separately from message audio
- [ ] Add unit test for the audio integration in TaskDetail
- [ ] Verify lint, typecheck, and build pass

## Acceptance Criteria

- [ ] TaskDetail Output section shows a speaker/play button when `outputSummary` exists
- [ ] Clicking the button generates and plays audio of the task summary via server TTS
- [ ] AudioPlayer with seek, speed, skip controls appears during playback
- [ ] Audio is cached in R2 and reused on subsequent plays
- [ ] No regressions to existing task detail functionality
- [ ] No regressions to existing chat message audio playback

## References

- Recent audio PR: #401 (fix: resolve audio double playback bugs and add player UI)
- `packages/acp-client/src/hooks/useAudioPlayback.ts`
- `packages/acp-client/src/components/AudioPlayer.tsx`
- `apps/web/src/pages/TaskDetail.tsx`
