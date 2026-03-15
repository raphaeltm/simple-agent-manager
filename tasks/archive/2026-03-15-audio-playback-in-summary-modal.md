# Add Audio Playback to TruncatedSummary Modal

## Problem

The `TruncatedSummary` component (green box in project chat view) shows task output summaries with a "Read more" modal, but has no audio playback button. Audio playback was added to `TaskDetail.tsx` and `MessageActions.tsx` but never wired into the summary modal — the most natural place users look for it in the chat view.

## Research Findings

### Key Files
- `apps/web/src/components/chat/TruncatedSummary.tsx` — target component (green box + modal)
- `apps/web/src/components/chat/ProjectMessageView.tsx` — renders TruncatedSummary at line 741, has `taskEmbed` with `.id` and `.outputSummary`
- `packages/acp-client/src/hooks/useAudioPlayback.ts` — hook for TTS playback
- `packages/acp-client/src/components/AudioPlayer.tsx` — player UI component
- `apps/web/src/pages/TaskDetail.tsx` — reference implementation of audio in task context (lines 58-140)
- `apps/web/src/lib/api.ts` — `getTtsApiUrl()` at line 1022

### Pattern from TaskDetail.tsx
```typescript
const audio = useAudioPlayback({
  text: task.outputSummary ?? '',
  ttsApiUrl: task.outputSummary ? getTtsUrl() : undefined,
  ttsStorageId: task.outputSummary ? `task-${task.id}` : undefined,
});
```

### Data Available at Call Site
`ProjectMessageView.tsx` line 741: `<TruncatedSummary summary={taskEmbed.outputSummary} />`
- `taskEmbed.id` — task ID (available)
- `taskEmbed.outputSummary` — summary text (already passed)

### Exports Available
`@simple-agent-manager/acp-client` exports both `useAudioPlayback` and `AudioPlayer`.

## Implementation Checklist

- [ ] Add `taskId` prop to `TruncatedSummary` component interface
- [ ] Import `useAudioPlayback` and `AudioPlayer` from `@simple-agent-manager/acp-client`
- [ ] Import `getTtsApiUrl` from `../../lib/api` (same pattern as ProjectMessageView.tsx)
- [ ] Wire up `useAudioPlayback` hook with `ttsStorageId: task-${taskId}`
- [ ] Add speaker button inside the "Read more" modal (next to the title or below text)
- [ ] Add `AudioPlayer` component below the speaker button when playing
- [ ] Add screen reader announcements for audio state
- [ ] Update the `TruncatedSummary` call site in `ProjectMessageView.tsx` to pass `taskId={taskEmbed.id}`
- [ ] Ensure audio stops when modal closes (cleanup)
- [ ] Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] When user opens "Read more" modal for a task summary, a speaker button is visible
- [ ] Clicking the speaker button triggers TTS playback of the summary
- [ ] AudioPlayer UI appears with seek, speed, skip controls during playback
- [ ] Closing the modal stops any active audio playback
- [ ] Accessible: speaker button has proper aria-label, screen reader announcements work
