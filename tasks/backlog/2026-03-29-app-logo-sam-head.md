# Replace App Logo with sam-head.png

## Problem

The app's top-left logo currently uses `favicon.png`. The user wants it replaced with `sam-head.png` (the SAM mascot head image from `assets/images/sam-head.png`).

A previous session identified the changes needed but ended before committing.

## Research Findings

- Source image: `assets/images/sam-head.png`
- Target location: `apps/web/public/sam-head.png` (needs to be copied)
- References to update in `apps/web/src/components/AppShell.tsx`:
  - Line 117: mobile header logo (`/favicon.png` → `/sam-head.png`)
  - Line 170: desktop sidebar logo (`/favicon.png` → `/sam-head.png`)
- `apps/web/public/sw.js` line 10 references `/favicon.png` in cache list — may need updating
- `apps/web/index.html` line 5 uses `favicon.png` as the browser tab icon — this should stay as-is (different purpose)

## Implementation Checklist

- [ ] Copy `assets/images/sam-head.png` to `apps/web/public/sam-head.png`
- [ ] Update `AppShell.tsx` line 117 (mobile) to reference `/sam-head.png`
- [ ] Update `AppShell.tsx` line 170 (desktop) to reference `/sam-head.png`
- [ ] Update service worker cache list in `sw.js` to include `/sam-head.png`

## Acceptance Criteria

- [ ] App shows sam-head.png in the top-left corner on both mobile and desktop
- [ ] The image is properly sized (h-7 w-7 mobile, h-6 w-6 desktop)
- [ ] Browser tab favicon remains unchanged (still favicon.png)
- [ ] Lint and typecheck pass
