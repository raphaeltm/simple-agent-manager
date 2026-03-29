# Replace App Logo with sam-head.png

## Problem

The app's top-left logo currently uses `favicon.png`. The user wants it to use `sam-head.png` instead, which is a more appropriate brand image.

## Research Findings

- Source image: `assets/images/sam-head.png`
- Current logo: `apps/web/public/favicon.png` referenced in `AppShell.tsx`
- Two references in `AppShell.tsx`:
  - Line 117: Mobile header (`h-7 w-7`)
  - Line 170: Desktop sidebar (`h-6 w-6`)
- Previous session (fe10814e) identified the same changes but never committed them

## Implementation Checklist

- [ ] Copy `assets/images/sam-head.png` to `apps/web/public/sam-head.png`
- [ ] Update `AppShell.tsx` line 117 (mobile) to reference `/sam-head.png`
- [ ] Update `AppShell.tsx` line 170 (desktop) to reference `/sam-head.png`
- [ ] Verify the image renders correctly with the existing size classes

## Acceptance Criteria

- [ ] The app shows `sam-head.png` in the top-left corner on both mobile and desktop layouts
- [ ] The image is properly sized (h-7 w-7 mobile, h-6 w-6 desktop)
- [ ] No other references to the old logo are broken
