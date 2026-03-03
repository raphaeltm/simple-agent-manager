# Voice Input for Project Chat

## Problem

The workspace chat (via AgentPanel/acp-client) has a voice input button using Cloudflare Workers AI Whisper for speech-to-text. The project chat — both the new task input (ChatInput in ProjectChat.tsx) and the follow-up input (FollowUpInput in ProjectMessageView.tsx) — lacks this feature.

## Approach

Reuse the existing `VoiceButton` component from `@simple-agent-manager/acp-client` and the `getTranscribeApiUrl()` utility from `apps/web/src/lib/api.ts`. Wire them into both project chat input components.

## Checklist

- [x] Import VoiceButton into ProjectChat.tsx and add to ChatInput
- [x] Import VoiceButton into ProjectMessageView.tsx and add to FollowUpInput
- [x] Wire onTranscription callback to append text with proper spacing
- [x] Update test mocks for getTranscribeApiUrl and VoiceButton
- [x] Verify typecheck, lint, and all tests pass

## Acceptance Criteria

- Voice button appears next to Send in the new task input
- Voice button appears next to Send in the follow-up input (active/idle sessions)
- Transcribed text appends to current input with proper spacing
- All existing tests continue to pass
