# Global Persistent Audio Playback Player

## Problem

TTS audio playback (chat messages, task summaries) stops when users navigate away because each component owns its own `useAudioPlayback` hook instance. The hook's cleanup effect stops audio on unmount. The player needs to live at the app shell level so audio keeps playing across route changes.

## Research Findings

### Current Architecture
- `useAudioPlayback` hook in `packages/acp-client/src/hooks/useAudioPlayback.ts` — manages HTMLAudioElement, blob URL caching, abort controller, server TTS + browser fallback
- `AudioPlayer` component in `packages/acp-client/src/components/AudioPlayer.tsx` — inline player UI with seek bar, speed control, skip buttons
- Three consumers:
  1. `MessageActions.tsx` (acp-client) — per-message TTS button + inline AudioPlayer
  2. `TruncatedSummary.tsx` (apps/web) — task summary modal TTS
  3. `TaskDetail.tsx` (apps/web) — task output section TTS

### Key Design Decisions
- GlobalAudioContext must be mounted above the router (in App.tsx or ProtectedLayout) so it never unmounts during navigation
- The existing `useAudioPlayback` hook logic is the foundation — lift the audio element ownership to the context
- The inline AudioPlayer component stays in acp-client but consumers switch to the global context
- AppShell layout needs modification to include the persistent player bar

### Files to Modify
- `apps/web/src/App.tsx` — wrap with GlobalAudioProvider
- `apps/web/src/components/AppShell.tsx` — add GlobalAudioPlayer in layout
- `packages/acp-client/src/components/MessageActions.tsx` — replace useAudioPlayback with useGlobalAudio
- `apps/web/src/components/chat/TruncatedSummary.tsx` — replace useAudioPlayback with useGlobalAudio
- `apps/web/src/pages/TaskDetail.tsx` — replace useAudioPlayback with useGlobalAudio
- `apps/web/src/app.css` — add slide animations
- `packages/ui/src/tokens/theme.css` — add `--sam-z-player: 15`

### New Files
- `apps/web/src/contexts/GlobalAudioContext.tsx` — context + provider + hook
- `apps/web/src/components/GlobalAudioPlayer.tsx` — persistent player UI
- `apps/web/tests/playwright/global-audio-player-audit.spec.ts` — visual tests

## Implementation Checklist

- [ ] Add `--sam-z-player: 15` to theme.css and `--z-index-player` to app.css theme mapping
- [ ] Add slide-in/slide-out keyframe animations to app.css
- [ ] Create `GlobalAudioContext.tsx` — lift useAudioPlayback logic into a React context provider
- [ ] Create `GlobalAudioPlayer.tsx` — persistent player bar UI matching the spec
- [ ] Mount `GlobalAudioProvider` in App.tsx above the router
- [ ] Add `GlobalAudioPlayer` to AppShell.tsx layout (mobile: after main, desktop: spanning full width below sidebar+main)
- [ ] Update `MessageActions.tsx` — replace local useAudioPlayback with useGlobalAudio, remove inline AudioPlayer
- [ ] Update `TruncatedSummary.tsx` — replace local useAudioPlayback with useGlobalAudio
- [ ] Update `TaskDetail.tsx` — replace local useAudioPlayback with useGlobalAudio
- [ ] Add CSS custom property `--sam-player-height` for layout reactivity
- [ ] Write Playwright visual audit tests with all required scenarios and viewports
- [ ] Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] Audio continues playing when navigating between pages
- [ ] Player bar appears at bottom of app shell when audio is active
- [ ] Player bar disappears when audio stops or is dismissed
- [ ] All controls work: play/pause, skip forward/back, seek, speed, close
- [ ] New audio replaces current playback immediately
- [ ] "Go to source" navigation doesn't stop playback
- [ ] Mobile layout: 72px player, all touch targets ≥ 44px
- [ ] Desktop layout: 56px player, expandable to ~80px
- [ ] No horizontal overflow at any viewport
- [ ] Accessible: role="region", aria-label, aria-live announcements
- [ ] Playwright visual tests pass at 375x667 and 1280x800

## References

- SAM idea `01KMT2XYNPR5FW3ZENDRC34B5F`
- Task spec in dispatch description
