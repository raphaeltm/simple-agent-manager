# Voice Input Silent Failure on Stop

**Created**: 2026-02-14
**Priority**: High
**Relates to**: VoiceButton component, `POST /api/transcribe` endpoint

## Summary

Voice input silently fails: the user can speak and sees the button pulsing in response to their voice (audio visualization works), but when they click stop, nothing happens. No transcription text appears, no error is shown.

## Context

Voice input was added as part of the voice-to-text feature. The `VoiceButton` component in `packages/acp-client` records audio via the MediaRecorder API, then sends it to `POST /api/transcribe` (Workers AI Whisper) for transcription. The result should be inserted into the chat input.

## Symptoms

- Recording starts successfully (button pulses with voice)
- Clicking stop produces no visible result
- No error message shown to the user
- No transcription text inserted into the input

## Investigation Areas

- Check if the MediaRecorder `stop` event fires and produces a valid Blob
- Check if the `POST /api/transcribe` request is actually sent (network tab)
- Check if the response is received but not handled
- Check error handling — are errors being swallowed silently?
- Check the audio format/encoding sent to Workers AI (Whisper expects specific formats)
- Check if the `onTranscription` callback is wired up correctly from `VoiceButton` to the chat input
