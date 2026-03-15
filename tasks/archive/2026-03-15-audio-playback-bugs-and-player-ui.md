# Fix Audio Playback Bugs & Implement Playback UI

## Problem

The TTS audio feature has several bugs and needs a dedicated playback UI:

1. **Double playback**: Clicking the play button can trigger two simultaneous audio streams because `playServerTTS()` has no mutual exclusion — no AbortController for in-flight fetch requests, and `stopPlayback()` doesn't cancel pending requests.
2. **Unnecessary regeneration**: When stopping then replaying, the entire synthesis/fetch chain runs again even though audio was already generated and cached. The blob URL is revoked on stop, forcing a full re-fetch.
3. **Incomplete generation for long messages**: Text is truncated at 5000 chars (`DEFAULT_TTS_MAX_TEXT_LENGTH`). The 30s timeout (`DEFAULT_TTS_TIMEOUT_MS`) may also be insufficient for very long text.
4. **Blob URL leak in error handler**: `audio.onerror` at line 175 of `MessageActions.tsx` doesn't revoke `blobUrlRef.current`.
5. **No playback controls**: Users can only play/stop — no seek, speed, rewind, or fast-forward.

## Research Findings

### Key Files
- `packages/acp-client/src/components/MessageActions.tsx` — Main TTS playback logic (420 lines)
- `packages/acp-client/src/components/MessageBubble.tsx` — Renders MessageActions for agent messages
- `apps/api/src/services/tts.ts` — Backend TTS pipeline (331 lines)
- `apps/api/src/routes/tts.ts` — TTS API endpoints
- `packages/shared/src/constants.ts` — TTS config constants (lines 313-339)
- `packages/acp-client/src/components/MessageActions.test.tsx` — Existing tests (529 lines)

### Root Causes

**Double playback**: `playServerTTS()` is async but `toggleSpeak()` only checks `isSpeaking || isLoading` synchronously. Between `setIsLoading(true)` (line 123) and the React re-render, a second click can pass the guard. Also, no `AbortController` means stopping playback doesn't abort in-flight requests — the old request completes and plays audio even after user clicked stop.

**Regeneration**: `stopPlayback()` (line 94-105) sets `audioRef.current = null` and doesn't preserve the blob URL for replay. `audio.onended` (line 167-173) revokes the blob URL. So clicking play again always triggers a full re-fetch cycle.

**Long message truncation**: Backend truncates at `maxTextLength` (default 5000 chars) at line 306 of `tts.ts`. No notification is sent to the client that text was truncated.

### Architecture for Playback UI

The playback UI should be a new component (`AudioPlayer`) that:
- Receives the audio blob URL and controls an HTML5 `<audio>` element
- Provides seek bar, speed control, skip forward/back buttons
- Is rendered as an overlay/bottom sheet that appears when audio starts
- Can be dismissed (stops audio) or minimized
- Uses `audio.currentTime`, `audio.duration`, `audio.playbackRate` for controls

## Implementation Checklist

### Bug Fixes

- [x] 1. Add `AbortController` to `playServerTTS()` — abort in-flight requests when `stopPlayback()` is called or component unmounts
- [x] 2. Add a `playbackLockRef` (boolean ref) as a re-entrance guard to prevent `playServerTTS()` from running concurrently
- [x] 3. Cache the audio blob URL across play/stop cycles — don't revoke on stop, only revoke when new audio is generated or component unmounts
- [x] 4. Fix blob URL leak in `audio.onerror` handler — add `URL.revokeObjectURL(blobUrlRef.current)`
- [x] 5. When stopping during loading, the abort should cancel both the synthesis fetch and the audio fetch

### Playback UI

- [x] 6. Create `AudioPlayer` component with: seek bar (range input), current time / duration display, play/pause toggle, playback speed selector (0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x), skip back 10s / forward 10s buttons
- [x] 7. Render `AudioPlayer` as a floating overlay/bottom sheet that appears when audio starts playing
- [x] 8. Wire `AudioPlayer` into `MessageActions` — when audio starts, show the player; when dismissed, stop audio
- [x] 9. Support closing the player UI (stops audio and returns to initial state)

### Refactoring

- [x] 10. Extract audio state management from `MessageActions` into a custom hook (`useAudioPlayback`) to keep component clean
- [x] 11. Move server TTS fetch logic into the hook, with proper abort/cache/lock handling

### Tests

- [x] 12. Test: rapid double-click only triggers one API call (re-entrance guard)
- [x] 13. Test: stopping during loading aborts the fetch
- [x] 14. Test: replaying after stop reuses cached blob URL (no new API call)
- [x] 15. Test: blob URL is cleaned up on error (handled in hook's onerror handler)
- [x] 16. Test: AudioPlayer renders with correct controls (seek, speed, skip)
- [x] 17. Test: playback speed changes audio playbackRate

## Acceptance Criteria

- [x] Clicking play twice rapidly only produces a single audio stream
- [x] Stopping then replaying does not re-fetch from the server (uses cached blob)
- [x] AbortController cancels in-flight requests when stopping
- [x] Audio player UI appears with seek bar, speed control, and skip buttons
- [x] Playback speed can be changed (0.5x to 2x)
- [x] User can seek forward/backward in the audio
- [x] All existing MessageActions tests still pass
- [ ] No blob URL leaks on error or unmount

## References

- `packages/acp-client/src/components/MessageActions.tsx` — primary file to modify
- `packages/acp-client/src/components/MessageBubble.tsx` — integration point
- `apps/api/src/services/tts.ts` — backend (no changes needed for bug fixes)
- `packages/shared/src/constants.ts` — TTS constants
