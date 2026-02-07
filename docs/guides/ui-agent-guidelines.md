# UI Agent Guidelines

This guide defines non-negotiable UI rules for agent-authored changes.

## Mandatory Rules

1. Use shared components from `@simple-agent-manager/ui` when a matching component exists.
2. Use semantic tokens and shared theme variables; avoid new hardcoded visual values in app screens.
3. Start with mobile layout first, then add desktop enhancements.
4. Keep primary action touch targets at least 56px tall on mobile.
5. Preserve keyboard accessibility and visible focus states.
6. Keep core task flows usable at 320px width with no required horizontal scrolling.

## Do

- Reuse existing patterns from `packages/ui`.
- Add clear loading, error, empty, and disabled states.
- Document any exception with scope, rationale, owner, and expiration.
- Keep UI updates scoped and traceable to user story goals.

## Do Not

- Introduce one-off component variants when shared components can be extended.
- Bypass accessibility checks for speed.
- Change mobile interaction behavior without updating mobile guidelines.
- Add visual complexity that reduces workflow clarity.

## Pull Request Compliance Requirements

For UI changes, PR descriptions must include confirmation that:

- Mobile-first layout verification was performed
- Accessibility checks were completed
- Shared components were used or a documented exception was provided
