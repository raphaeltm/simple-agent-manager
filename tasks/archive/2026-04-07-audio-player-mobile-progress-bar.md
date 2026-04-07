# Audio Player Mobile Progress Bar Redesign

## Problem

The global audio player's progress bar/scrubber is unusable on mobile. The current layout puts all controls and the progress bar in a single row:

```
[SkipBack] [Play] [SkipFwd] [---progress---] [Source] [Expand] [Close]
```

On a 375px viewport, the buttons (3x 56px + close 44px + source ~80px) consume ~292px, leaving ~50px for the progress bar — too small to see or interact with.

## Research Findings

- **Component**: `apps/web/src/components/GlobalAudioPlayer.tsx`
- **Context**: `apps/web/src/contexts/GlobalAudioContext.tsx`
- **Integration**: Rendered in `AppShell.tsx` as grid row 2 (desktop) or flex item (mobile)
- **Current green accent**: A 2px green bar appears above the controls when playing (lines 83-91) — purely decorative, not interactive
- **Mobile height**: 72px with 56px touch targets
- **Desktop height**: 56px (80px when expanded)
- **Design tokens**: `--sam-color-accent-primary` (#16a34a) for green accent

## Solution

Replace the decorative green accent bar with the interactive progress/seek bar, positioned above the controls. This gives the scrubber the full width of the player on all viewports. Selected Prototype C (native range input on top) after evaluating 4 prototypes.

### Layout — Before:
```
[2px green accent bar]
[SkipBack] [Play] [SkipFwd] [---tiny progress---] [Source] [Close]
```

### Layout — After (Mobile):
```
[========== full-width progress bar ==========]
[SkipBack] [Play] [SkipFwd]   [time] [Source] [Close]
```

### Layout — After (Desktop):
```
[========== full-width progress bar ==========]
[SkipBack] [Play] [SkipFwd]   [time] [Source] [Speed] [Expand] [Close]
```

## Implementation Checklist

- [x] Create Playwright prototype pages with mock HTML to test different layouts
- [x] Screenshot prototypes at mobile (375px) and desktop (1280px) viewports
- [x] Review prototypes critically and select the best design (Prototype C — native range input)
- [x] Implement selected design in `GlobalAudioPlayer.tsx`
- [x] Update the seek bar to be full-width above controls
- [x] Replace the green accent bar with the seek bar (use green track fill)
- [x] Move time display (current / duration) to the controls row
- [x] Ensure loading shimmer state still works
- [x] Update existing unit tests in `GlobalAudioPlayer.test.tsx`
- [x] Run visual audit with Playwright on mobile + desktop
- [x] Verify no horizontal overflow on mobile

## Acceptance Criteria

- [x] Progress bar spans full width of the player at all viewport sizes
- [x] Progress bar is interactive (draggable/tappable) for seeking
- [x] Time indicators are visible and readable on mobile
- [x] All playback controls (skip, play/pause, close) remain accessible with proper touch targets
- [x] Loading shimmer state displays correctly
- [x] No horizontal overflow on 375px viewport
- [x] Existing unit tests pass or are updated (40/40 pass)
- [x] Accessible — proper aria labels, screen reader support maintained
