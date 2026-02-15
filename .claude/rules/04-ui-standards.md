# UI Standards

## Mobile-First Requirements

ALL UI changes MUST be tested for mobile usability before deployment.

1. Ensure login/primary CTAs are prominent with min 56px touch targets
2. Use responsive text sizes (mobile -> tablet -> desktop)
3. Start with single-column layouts on mobile
4. Test on mobile viewport before deploying
5. Follow `docs/guides/mobile-ux-guidelines.md`

### Visual Verification with Playwright (Required During Development)

ALL UI changes MUST be visually verified on a mobile viewport **before committing**, not just after deployment. This catches overflow, clipping, and layout issues early.

1. Start a local Vite dev server (`pnpm --filter @simple-agent-manager/web dev` or `npx vite`)
2. Use Playwright to set a mobile viewport (375x667 minimum) and navigate to the page
3. Take a screenshot and inspect for: overflow, clipping, touch target size, readability
4. If the component requires authentication to reach, inject a mock HTML harness via `browser_evaluate` that renders the component's markup with the project's CSS variables
5. Fix any issues before committing — do NOT defer to post-deployment testing
6. Save screenshots to `.codex/tmp/playwright-screenshots/` (gitignored)

This workflow avoids deploy-fix-deploy cycles and catches mobile layout bugs that unit tests cannot detect.

### Quick Mobile Check

Before deploying any UI changes:
- [ ] Login button visible and large (min 56px height)
- [ ] Text readable without zooming (responsive sizing)
- [ ] Grid layouts collapse to single column on mobile
- [ ] Visually verified on mobile viewport via Playwright during development
- [ ] Dialogs/popovers/panels stay within viewport bounds on 320px-wide screens

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
