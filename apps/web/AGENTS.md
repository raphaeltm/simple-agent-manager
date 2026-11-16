# UI Standards

Rules that apply here are listed under "Rules for this directory" at the end of this file.

## Mobile-First Requirements

ALL UI changes MUST be tested for mobile usability before deployment.

1. Ensure login/primary CTAs are prominent with min 56px touch targets
2. Use responsive text sizes (mobile → tablet → desktop)
3. Start with single-column layouts on mobile
4. Test on mobile viewport before deploying
5. Follow `.claude/rules/04-ui-standards.md` and use `$ui-ux-specialist` for UI tasks

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
2. Use the design tokens (CSS custom properties) defined in `packages/ui/src/tokens/theme.css`
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

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

- `.claude/rules/04-ui-standards.md`: UI Standards
- `.claude/rules/15-nav-parity.md`: Desktop–Mobile Navigation Parity
- `.claude/rules/16-no-page-reload-on-mutation.md`: No Page Reload on Mutation
- `.claude/rules/17-ui-visual-testing.md`: Mandatory Playwright Visual Testing for UI Changes
- `.claude/rules/24-no-duplicate-ui-controls.md`: No Duplicate Implementations
- `.claude/rules/26-project-chat-first.md`: Project Chat First
- `.claude/rules/37-prototype-development.md`: Prototype Development
- `.claude/rules/48-stale-while-revalidate-ui.md`: Stale-While-Revalidate UI (No Hiding, No Refetch Loops)
- `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`: Horizontal Overflow Inside `overflow-x-hidden` Is Invisible to Document-Level Checks
- `.claude/rules/60-request-io-and-bundle-budgets.md`: Request I/O and Client Bundle Budgets
- `.claude/rules/64-unstable-prop-identity-remounts-subtrees.md`: An Object Literal in a Render Body Can Remount an Entire Subtree
- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State
- `.claude/rules/79-new-enum-values-audit-every-denylist.md`: A New Value in a Shared Status Enum Must Audit Every Denylist Over That Enum
- `.claude/rules/80-sam-glass.md`: SAM Glass
- `.claude/rules/82-typed-cards-every-harness.md`: A Typed Chat Card Must Render for Every Agent Harness

<!-- END GENERATED RULE INDEX -->
