# AgentKeyCard accessibility refactor

**Created**: 2026-04-18
**Priority**: HIGH
**Source**: ui-ux-specialist review of PR `sam/project-credential-overrides`

## Problem

`apps/web/src/components/AgentKeyCard.tsx` has three pre-existing accessibility issues flagged HIGH by the ui-ux-specialist during the project-credential-overrides review. These are shared-component issues that affect both user settings (`/settings/agents`) and project settings (`/projects/:id/settings`), so fixing them cross-cuts multiple surfaces and warrants a dedicated PR with focused a11y testing.

The project-credential-overrides PR defers these to this task because:
- Not introduced by that PR (pre-existing in the shared component)
- Fixing requires coordinated a11y test pass across user + project contexts
- A focused PR is cheaper to review than bundling unrelated a11y work

## Findings to Address

### A-1 — Touch targets below 44px (HIGH)

Lines 152 and 156 of `AgentKeyCard.tsx`:

```tsx
<button onClick={() => setShowForm(true)} className="text-xs bg-transparent border-none cursor-pointer py-0.5 px-2 text-accent">
  Update
</button>
<button
  onClick={() => handleDelete(activeCredential.credentialKind)}
  disabled={loading}
  className={`text-xs bg-transparent border-none cursor-pointer py-0.5 px-2 text-danger ...`}
>
  {loading ? 'Removing...' : 'Remove'}
</button>
```

- Effective touch target ~20px tall (`py-0.5` + `text-xs` line height). Below the 44px minimum.
- No `aria-label` — "Remove" without agent name is ambiguous.
- No design-system focus ring (browser default only).

**Acceptance**: Replace with `<Button variant="ghost" size="sm">` (or equivalent) that meets 44px minimum on touch. Add `aria-label={\`Remove ${agent.name} ${typeLabel}\`}`.

### A-2 — `window.confirm()` in delete handler (HIGH)

Line 68 of `AgentKeyCard.tsx`:

```tsx
if (!confirm(`Remove the ${agent.name} ${typeLabel}? ...`)) {
  return;
}
```

`window.confirm()` is inaccessible in many assistive-technology configurations and cannot be styled.

**Acceptance**: Replace with a design-system confirmation modal/dialog component. The dialog must be focus-trapped, dismissible via Escape, and announce properly to screen readers.

### A-3 — Credential type tabs not grouped (HIGH)

Lines 170–195 of `AgentKeyCard.tsx` — `API Key` / `OAuth Token` buttons are rendered as two sibling `<button type="button">` elements with no `role="group"`, `role="tablist"`, or `aria-pressed` state.

**Acceptance**: Wrap in a group with accessible name (e.g., `<div role="group" aria-label="Credential type">`) and add `aria-pressed` so screen readers announce the toggle state. Alternatively use the existing `ButtonGroup` component from `@simple-agent-manager/ui` if it supports two-state toggle semantics.

## Scope

Only `apps/web/src/components/AgentKeyCard.tsx`. Do not change the API, the credential flow, or the surrounding settings pages.

## Acceptance Criteria

- [ ] Touch targets for Update/Remove meet 44×44 min (measured via Playwright `boundingBox`)
- [ ] `aria-label` on Update/Remove buttons includes agent name + credential type
- [ ] Design-system focus ring visible on keyboard focus (Tab navigation)
- [ ] `window.confirm()` replaced with a design-system dialog
- [ ] Credential-type toggle wrapped in `role="group"` with `aria-pressed` on each button
- [ ] Playwright visual audit at 375px and 1280px passes for both user settings and project settings contexts
- [ ] axe-core or similar accessibility scan passes

## References

- Source review: `ui-ux-specialist` on PR `sam/project-credential-overrides`
- Rule 17: `.claude/rules/17-ui-visual-testing.md` (Playwright visual audit)
- Rule 25: `.claude/rules/25-review-merge-gate.md` (explicit deferral of reviewer findings)
