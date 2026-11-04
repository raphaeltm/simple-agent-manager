# A session title collapses to zero width beside a long connector chip

## Problem

In the project chat list, a session row whose task came from a connector with a very long client
name shows the connector chip at full width and the title (`span.min-w-0.truncate` in
`apps/web/src/pages/project-chat/SessionItem.tsx`) at 0px. The user sees a chip and no title.

## Context

Found by the ui-ux-specialist review of PR #2522 (2026-11-04).
`apps/web/tests/playwright/nested-session-sidebar-audit.spec.ts`, "Connector provenance in session
sidebar remains user-initiated", builds a connector name of `'Claude Research 🧪 & planning '`
repeated nine times and asserts the title "Implement authentication" is wider than 50px; it fails
deterministically with width 0 on both the PR branch and `main` at 3aa1885ec. The spec is on the
visual-audit quarantine list, so CI does not run it.

## Acceptance Criteria

- [ ] The session title keeps a usable minimum width when the connector chip's label is long;
      the chip truncates instead (for example `min-w-0 shrink` with a max width on `ConnectorChip`).
- [ ] The nested-session-sidebar "Connector provenance" case passes at 375 and 1280 widths.
- [ ] Remove `nested-session-sidebar-audit.spec.ts` from the quarantine list if its other cases
      pass, or record which ones still fail and why.
