# Fix settled permission alerts pinned to the conversation tail

## Problem
Production screenshot shows an old delivered permission alert after newer agent activity. User requests audit, fix, production deployment, explicitly skipping staging.

## Research
`useAcpPermissionPlacement.tsx` maps known tool IDs to display rows, but puts all unmatched requests in the footer regardless of state or age. Tool IDs may be absent or outside the paginated transcript. `SessionMessageView.tsx` renders that footer after all conversation rows.

## Plan and acceptance
- [x] Reproduce settled unmatched alert moving with the tail.
- [x] Preserve exact tool anchors and pending unanchored visibility.
- [x] Anchor settled unmatched interactions by creation time; do not show old unloaded history at tail.
- [x] Test missing IDs, unknown IDs, history prepend, appended activity, and empty transcript.
- [x] Local mobile/desktop browser audit and screenshots.
- [ ] Specialist reviews, relevant lint/typecheck/test/build, PR CI and CodeRabbit request/wait.
- [ ] Merge and confirm production deployment and public health. Staging explicitly waived.

## UX decision
Considered hiding all settled requests, a dismiss button, and chronological placement. Choose chronological placement: preserves outcome history without adding controls or suppressing useful receipts.

## Validation and review evidence
- Original code: five of six initial placement tests failed; final implementation: seven of seven pass, including updated-plan timestamps out of display order.
- Local independent reviewer found the timestamp assumption, verified the linear scan correction, and returned PASS on task-completion, pending visibility, anchors, pagination/append/empty, tests and constitution checks.
- Existing permission browser audit: 26 pass, two project-specific skips. New mobile/desktop regression passes after fixing fixture creation time to derive from the mocked conversation rather than elapsed suite time. Tests measure receipt bottom <= newer tool row top.
- Screenshots: `tasks/evidence/2026-10-15-permission-history/{mobile,desktop}.png`. Parent visually reviewed both Playwright screenshots: permission receipt before newer tool activity, no overflow, clipping, overlap or unreadable card text. Long text, 30 messages, special characters and existing failure/retry/noncreator scenarios covered.
- UI rubric: hierarchy 4/5; interaction clarity 4/5; mobile usability 4/5; accessibility 4/5; system consistency 5/5. Uses existing cards and semantics; no new controls/effects.
- Documentation sync: no API/schema/configuration/public contract changes; existing guide remains accurate.

## Post-mortem
What broke: old delivered requests stayed below newer activity. Root cause: original placement from PR #2202 treated all missing anchors as live-footer content. Why missed: fixtures anchored every settled interaction and only tested pending unanchored cards. Prevention: settled unanchored browser scenario, measured ordering, append/history/empty and non-monotonic timestamp tests. No additional standing steering text needed.
- Production reproduction: ran the regression against `https://app.simple-agent-manager.org` served JS with all conversation API data mocked. It failed exactly because the settled receipt had zero conversation-row ancestors (footer). No live session was created/answered. API health healthy; initial app entry `/assets/index-D7oxvRcd.js`.
- Final complete web suite: 339 files / 4,057 tests passed. Full web lint: zero errors (three existing warnings); final typecheck passed. Production Vite build passed through Playwright webServer. Quality preflight and specialist review evidence checkers passed locally.

## Release tracking
Implementation acceptance is complete. This file is archived per /do Phase 4; the two unchecked release items above are intentionally post-implementation gates, tracked in the PR and local .do-state.md until CI/CodeRabbit/merge/deployment and production browser verification finish. They are not claimed complete here.
