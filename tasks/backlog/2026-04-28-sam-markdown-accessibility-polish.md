# SAM Markdown Accessibility & Polish

## Problem

The ui-ux-specialist review of the SAM chat markdown renderer (PR #836) identified 10 improvements for contrast ratios, keyboard accessibility, touch targets, and ARIA labeling. The review completed after the PR was merged, so these fixes need a follow-up.

## Findings (from ui-ux-specialist review)

### Contrast Ratio Fixes (WCAG AA)
- `h4` color: `rgba(255,255,255,0.6)` → `rgba(255,255,255,0.75)` (~3.4:1 → ~4.6:1)
- `h5`/`h6` color: `rgba(255,255,255,0.4)` → `rgba(255,255,255,0.65)` (~2.7:1 → ~4.2:1)
- `del` color: `rgba(255,255,255,0.4)` → `rgba(255,255,255,0.6)` (~3.9:1)
- Copy button text: `rgba(255,255,255,0.4)` → `rgba(255,255,255,0.65)`

### Keyboard Accessibility
- Copy button: add `:focus-visible { outline: 2px solid rgba(60,180,120,0.8); }`
- Links: add `:focus-visible { outline: 2px solid rgba(60,180,120,0.8); outline-offset: 2px; }`

### Touch Targets
- Copy button: `padding: 2px 8px` produces ~22px height; raise to `min-height: 28px; padding: 4px 10px`

### ARIA & Semantics
- Copy button: add `aria-label` that updates on state ("Copy code to clipboard" / "Copied to clipboard")
- Decorative icons (Copy/Check): add `aria-hidden="true"`
- Code block wrapper: add `role="region"` and `aria-label`

### Table Layout
- Remove `table-layout: fixed` from `thead`/`tbody` — causes content clipping on narrow viewports

### Clipboard Fallback
- Add `execCommand('copy')` fallback for non-HTTPS or permission-denied contexts

## Implementation Checklist

- [ ] Fix contrast ratios in `sam-markdown.css` (h4, h5/h6, del, copy button)
- [ ] Add focus-visible outlines for copy button and links in CSS
- [ ] Increase copy button touch target size
- [ ] Add aria-label to CopyButton component (dynamic based on copied state)
- [ ] Add aria-hidden to decorative icons in CopyButton
- [ ] Add role="region" and aria-label to sam-code-block wrapper
- [ ] Remove table-layout: fixed from thead/tbody
- [ ] Add execCommand('copy') fallback in CopyButton
- [ ] Run unit tests and verify all pass
- [ ] Verify on staging

## Acceptance Criteria

- [ ] All text elements meet WCAG AA contrast ratios (4.5:1 for normal text, 3:1 for large/bold)
- [ ] Copy button and links have visible focus indicators on keyboard navigation
- [ ] Copy button has adequate touch target (≥28px height)
- [ ] Screen readers announce copy button state correctly
- [ ] Tables render with natural column widths (no clipping)
- [ ] Copy works in non-HTTPS contexts via fallback

## References

- PR #836: feat: SAM chat markdown renderer
- Files: `apps/web/src/pages/sam-prototype/sam-markdown.tsx`, `sam-markdown.css`
- ui-ux-specialist review output: completed 2026-04-28
