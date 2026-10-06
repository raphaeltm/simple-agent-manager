# Overlay Menu Blur Audit

## Problem

Small contextual overlays in the web app, including kebab menus, popovers, tooltips, and chart overlays, can sit over readable text without enough blur or glass treatment. This breaks the app's glassmorphic style and makes overlays hard to read.

## Research Findings

- The previous portal task covered larger modal/dropdown surfaces, but the nodes page kebab menu still used the shared `DropdownMenu` without robust portal positioning.
- Several overlay-like surfaces needed the same treatment or validation:
  - Shared `DropdownMenu` and `Tooltip` in `packages/ui`
  - `UserMenu`, `SplitButton`, `WorkspaceCreateMenu`
  - `AccountMapCanvas` and `SessionHeader` tooltips
  - Recharts/admin analytics tooltips
  - `CreateDirectoryDialog`
  - `BranchSelector` empty dropdown state
- Screenshot review caught a real regression where the node menu assertions passed while the menu rendered beside the sidebar instead of the node card. Geometry assertions are required in addition to screenshots.
- SAM-dispatched subtasks can review pushed branch state, but cannot see local uncommitted workspace changes. Local agents are required for current-workspace review unless SAM subtasks are explicitly requested.

## Checklist

- [x] Portal and glass-treat shared `DropdownMenu`.
- [x] Add robust shared `DropdownMenu` positioning with viewport clamping.
- [x] Portal and glass-treat shared `Tooltip`.
- [x] Portal and glass-treat `UserMenu`.
- [x] Portal and glass-treat `SplitButton`.
- [x] Portal and glass-treat `WorkspaceCreateMenu`.
- [x] Portal and glass-treat `AccountMapCanvas` tooltip.
- [x] Portal and glass-treat `SessionHeader` recovery tooltip.
- [x] Add blur/glass treatment to admin chart tooltips.
- [x] Fix `CreateDirectoryDialog` backdrop and panel glass treatment.
- [x] Fix `BranchSelector` no-results dropdown glass treatment.
- [x] Add unit coverage for newly fixed branch selector and create-folder dialog states.
- [x] Expand Playwright portal overlay audit for node dropdown, shared tooltip, and account-map tooltip blur/geometry.
- [x] Prevent screenshot artifacts from overwriting across viewport projects.
- [x] Run typecheck, lint, unit tests, builds, and Playwright portal audit.
- [ ] Open PR, wait for CI, perform required staging verification, and merge when green.

## Acceptance Criteria

- Contextual overlays that can appear over text either use a blurred backdrop or have a blurred glass surface.
- Node kebab menu renders near its trigger on mobile and desktop and stays within the viewport.
- Shared tooltips and account-map tooltip render as portaled fixed overlays with blur and no viewport overflow.
- Local validation and CI pass before merge.
- Production deployment is monitored after merge.
