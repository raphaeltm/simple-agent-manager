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

Replace the decorative green accent bar with the interactive progress/seek bar, positioned above the controls. This gives the scrubber the full width of the player on all viewports.

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

- [ ] Create Playwright prototype pages with mock HTML to test different layouts
- [ ] Screenshot prototypes at mobile (375px) and desktop (1280px) viewports
- [ ] Review prototypes critically and select the best design
- [ ] Implement selected design in `GlobalAudioPlayer.tsx`
- [ ] Update the seek bar to be full-width above controls
- [ ] Replace the green accent bar with the seek bar (use green track fill)
- [ ] Move time display (current / duration) to the controls row
- [ ] Ensure loading shimmer state still works
- [ ] Update existing unit tests in `GlobalAudioPlayer.test.tsx`
- [ ] Run visual audit with Playwright on mobile + desktop
- [ ] Verify no horizontal overflow on mobile

## Acceptance Criteria

- [ ] Progress bar spans full width of the player at all viewport sizes
- [ ] Progress bar is interactive (draggable/tappable) for seeking
- [ ] Time indicators are visible and readable on mobile
- [ ] All playback controls (skip, play/pause, close) remain accessible with proper touch targets
- [ ] Loading shimmer state displays correctly
- [ ] No horizontal overflow on 375px viewport
- [ ] Existing unit tests pass or are updated
- [ ] Accessible — proper aria labels, screen reader support maintained
