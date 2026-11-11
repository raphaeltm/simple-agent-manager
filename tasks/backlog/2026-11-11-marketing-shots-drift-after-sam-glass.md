# Marketing screenshot specs drifted after the SAM Glass restyle

## Problem

The marketing capture specs (`apps/web/tests/playwright/marketing-shots-*.spec.ts`) are not run in CI,
and 9 of 37 now fail against the current app, so the website's product images can no longer be
regenerated as-is. The live homepage hero (`apps/www/public/images/hero/`, last updated 2026-10-15) and
feature scenes (`apps/www/public/images/scenes/`, 2026-10-20) predate the SAM Glass restyle
(2026-11-03 to 11-05) and show the old UI.

Failures observed 2026-11-11 (Desktop 1280x800):

- `C. all sessions`: session text not found in `navigation "Chat sessions"`
- `nodes page shows hardware…`: Nodes page crashes (`workspaces is not iterable`); mocks predate `/api/nodes/resource-usage`
- `sam-chat-tool-stream`, `sam-hero-live-session`, `sam-session-sleeping`, `sam-session-waking`: tool calls now collapse into a group, so the per-call text assertions fail
- `sam-triggers-sources`: Automation overview crashes on the mock (`Cannot read properties of undefined (reading 'some')`)
- `sam-agents-orchestration`: `.glass-panel-container` no longer exists inside the hierarchy dialog
- `sam-project-settings`: heading "Project Settings" not found

## Context

Found while building the OS homepage prototypes (branch `sam/pls-put-together-couple-y4b3b8`). Workaround
used there: gitignored `*.local.spec.ts` copies with soft assertions, and the Nodes fixtures from
`nodes-usage-fixtures.ts`.

## Acceptance Criteria

- [ ] All `marketing-shots-*.spec.ts` pass against the current app
- [ ] Mocks for the Nodes page and Automation overview match the current API shapes
- [ ] Homepage hero layers and feature scenes regenerated from fresh captures (`build:hero-layers`, `build:feature-scenes`), with crop boxes rechecked
- [ ] Consider running the marketing specs in CI (or a scheduled job) so drift is caught
