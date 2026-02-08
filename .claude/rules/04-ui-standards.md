# UI Standards

## Mobile-First Requirements

ALL UI changes MUST be tested for mobile usability before deployment.

1. Ensure login/primary CTAs are prominent with min 56px touch targets
2. Use responsive text sizes (mobile -> tablet -> desktop)
3. Start with single-column layouts on mobile
4. Test on mobile viewport before deploying
5. Follow `docs/guides/mobile-ux-guidelines.md`

### Quick Mobile Check

Before deploying any UI changes:
- [ ] Login button visible and large (min 56px height)
- [ ] Text readable without zooming (responsive sizing)
- [ ] Grid layouts collapse to single column on mobile
- [ ] Tested in Chrome DevTools mobile view

## UI Agent Rules

For UI changes in `apps/web`, `packages/vm-agent/ui`, or `packages/ui`:

1. Prefer shared components from `@simple-agent-manager/ui` when available.
2. Use semantic tokens from `packages/ui/src/tokens/semantic-tokens.ts` and CSS vars from `packages/ui/src/tokens/theme.css`.
3. Maintain mobile-first behavior:
   - single-column baseline at small widths
   - primary action target minimum 56px on mobile
   - no required horizontal scrolling at 320px for core flows
4. Preserve accessibility:
   - keyboard-accessible interactions
   - visible focus states
   - clear non-color-only status communication
5. If a shared component is missing, either:
   - add/extend it in `packages/ui`, or
   - document a temporary exception with rationale and expiration.
