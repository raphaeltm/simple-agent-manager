# UI Standards

## Purpose

This document is the canonical design and implementation standard for SAM interfaces.  
All UI work in `apps/web` and `packages/vm-agent/ui` must align with this guide.

## Visual Direction

- Direction: green-forward, software-development-focused, low-noise interface aesthetic.
- Surfaces:
  - Canvas: deep neutral background for focus
  - Surface: slightly elevated panel color for grouping
  - Accent: green as primary action and focus identity
- Contrast and readability take priority over decorative styling.

## Theming and Tokens

- Use semantic tokens from `packages/ui/src/tokens/semantic-tokens.ts`.
- Use CSS variables from `packages/ui/src/tokens/theme.css`.
- Do not introduce one-off hardcoded colors in product screens when equivalent semantic tokens exist.
- Theme-level values are updated in shared tokens, not per-page CSS.

## Typography

- Use responsive sizing:
  - mobile: readable default first
  - tablet: moderate scale-up
  - desktop: denser but still legible hierarchy
- Use shared typography primitives for headings/body/captions where available.
- Avoid decorative type styles that reduce scanability in workflow-heavy views.

## Spacing and Layout

- Mobile-first default is single-column.
- Add columns only at explicit breakpoints with a clear desktop productivity gain.
- Maintain consistent spacing scale via shared tokens.
- Avoid horizontal scrolling at 320px for core task flows.

## Component Standards

Every shared component definition must include:

- Purpose and recommended usage
- Supported variants
- Required states:
  - default
  - focus
  - active (if interactive)
  - disabled
  - loading (if async)
  - error and empty states where applicable
- Accessibility notes
- Mobile behavior guidance
- Desktop behavior guidance

## Accessibility Requirements

- Keyboard operability is required for interactive controls.
- Focus indicators must be visible and not removed.
- Primary action targets must meet minimum 56px touch height on mobile.
- Text and state indicators must be understandable without color-only cues.
- Reflow expectations:
  - primary flows remain usable at 320px width
  - no mandatory horizontal scrolling for standard interaction paths

## Responsive Acceptance Criteria

A screen is acceptance-ready only if:

1. Mobile:
   - primary action is discoverable without scroll ambiguity
   - interaction targets remain comfortable and distinct
2. Desktop:
   - layout gains efficiency without hiding or fragmenting key actions
   - navigation/state context stays clear in denser layouts

## Governance and Exceptions

- Default rule: use shared components and shared tokens.
- Exceptions require documented rationale, scope, owner, and expiration.
- UI changes (human or agent authored) must pass the same checklist before approval.

## Ownership

- Standards owner: product/design engineering lead.
- Shared component maintainers: frontend maintainers for `packages/ui`.
- Review responsibility: PR reviewers enforce checklist compliance and exception policy.
