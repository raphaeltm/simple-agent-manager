# Fix Voice Input and Add Visual Audio Feedback

## Summary

Voice input (the microphone button in the agent chat) doesn't appear to be working. Additionally, there's no visual feedback while recording — the user can't tell if the mic is active or if their speech is being picked up. The button should have a dynamic glow effect that responds to the user's voice amplitude.

## Current Behavior

- Tapping the mic button does not produce a transcription (needs investigation — could be permissions, API endpoint, or audio capture issue)
- While recording, there's no visual indication of audio input level
- User has no confidence the mic is actually listening

## Desired Behavior

1. **Fix voice input** — Diagnose and fix why transcription isn't working (permissions, API, audio capture, or encoding issue)
2. **Visual audio feedback** — While recording, the mic button should have a glow/pulse effect that responds to the user's speech:
   - Idle/silence: subtle steady glow (indicates recording is active)
   - Speaking: glow gets brighter and larger proportional to voice amplitude
   - This gives immediate feedback that the mic is working and picking up speech

## Implementation Notes

### Debugging Voice Input

Key files to investigate:
- `packages/acp-client/src/components/VoiceButton.tsx` — the mic button component
- `apps/api/src/routes/` — the `POST /api/transcribe` endpoint
- Check: MediaRecorder permissions, audio format/encoding, API endpoint URL construction, error handling

### Visual Feedback

- Use the Web Audio API (`AudioContext` + `AnalyserNode`) to get real-time amplitude data from the microphone stream
- Map amplitude to CSS properties on the button (e.g. `box-shadow` size/opacity, or a radial gradient)
- Use `requestAnimationFrame` for smooth animation
- The glow should be smooth (not jittery) — apply some smoothing/easing to the amplitude values
- Color: blue or green glow to indicate active recording (avoid red, which implies error)
- Must work on mobile (primary platform) — test touch interactions and performance

### Accessibility

- The visual glow is supplementary — the button should still have clear text/icon state changes for recording vs idle
- Screen readers should announce recording state changes
