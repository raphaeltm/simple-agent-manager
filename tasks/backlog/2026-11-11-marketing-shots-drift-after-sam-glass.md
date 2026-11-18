# Marketing screenshot specs drifted after the SAM Glass restyle

## Problem

The marketing capture specs (`apps/web/tests/playwright/marketing-shots-*.spec.ts`) are not run in CI,
and 9 of 37 now fail against the current app, so the website's product images can no longer be
regenerated as-is. (The homepage no longer uses them: the software-factory homepage, shipped
2026-11-11, has its own fresh captures in `apps/www/public/images/factory/`. The feature pages and
docs still use these specs' images.)

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
- [ ] Consider running the marketing specs in CI (or a scheduled job) so drift is caught
