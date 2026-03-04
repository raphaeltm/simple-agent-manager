# UI Standards

Full rules: `.claude/rules/04-ui-standards.md`

## Mobile-First Requirements

ALL UI changes MUST be tested for mobile usability before deployment.

1. Ensure login/primary CTAs are prominent with min 56px touch targets
2. Use responsive text sizes (mobile → tablet → desktop)
3. Start with single-column layouts on mobile
4. Test on mobile viewport before deploying
5. Follow `docs/guides/mobile-ux-guidelines.md`

### Visual Verification with Playwright

ALL UI changes MUST be visually verified on a mobile viewport **before committing**.

1. Start a local Vite dev server (`pnpm --filter @simple-agent-manager/web dev`)
2. Use Playwright to set a mobile viewport (375x667 minimum) and navigate to the page
3. Take a screenshot and inspect for: overflow, clipping, touch target size, readability
4. Save screenshots to `.codex/tmp/playwright-screenshots/` (gitignored)

### Quick Mobile Check

Before deploying any UI changes:
- [ ] Login button visible and large (min 56px height)
- [ ] Text readable without zooming (responsive sizing)
- [ ] Grid layouts collapse to single column on mobile
- [ ] Visually verified on mobile viewport via Playwright
- [ ] Dialogs/popovers/panels stay within viewport bounds on 320px-wide screens

## UI Agent Rules

1. Prefer shared components from `@simple-agent-manager/ui` when available
2. Use semantic tokens from `packages/ui/src/tokens/semantic-tokens.ts` and CSS vars from `packages/ui/src/tokens/theme.css`
3. Mobile-first: single-column baseline, 56px minimum touch targets, no horizontal scrolling at 320px
4. Accessibility: keyboard-accessible, visible focus states, non-color-only status
5. Invoke `$ui-ux-specialist` for every UI task
6. Create 2-3 layout/interaction variants and select with explicit tradeoff rationale
7. Visual verification with Playwright on both mobile (≥375x667) and desktop
8. Rubric scores (1-5) for visual hierarchy, interaction clarity, mobile usability, accessibility, system consistency; each ≥4

## React Interaction-Effect Analysis

When adding or modifying a click handler in a component with `useEffect` hooks:

1. Identify all effects that depend on state changed by your handler
2. Trace the state transition: what will each effect do when it sees the new state?
3. Check for conflicts: will any effect undo or race with the handler?
4. Add disambiguation if the same state value can mean different things
5. Write a behavioral test: render, simulate, assert the effect doesn't interfere
