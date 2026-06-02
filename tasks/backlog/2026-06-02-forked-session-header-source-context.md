# Forked Session Header Source Context

## Problem

The previous session prototyped a cleaner way to show where a forked or retried session came from, but the work remained prototype-only and did not ship to the real project chat UI. Today the production header only shows a compact lineage string such as `⑂ from ...` or `↩ attempt ...`. Users cannot expand the selected session header and see the parent session title, parent task ID, or parent session ID in one place near the task actions.

## Research Findings

- Previous session transcript indicated a prototype under `apps/web/src/pages/forked-session-header-prototype/` with three variants. The preferred shape kept the closed header compact and moved detailed parent/source metadata into the expanded header panel near the Complete/Workspace actions.
- `apps/web/src/pages/project-chat/lineageUtils.ts` already computes whether a task is a retry/fork from `TaskInfo.parentTaskId`, `triggeredBy`, and `dispatchDepth`.
- `apps/web/src/pages/project-chat/index.tsx` already computes `selectedLineageText` and passes it to `ProjectMessageView`.
- `apps/web/src/components/project-message-view/index.tsx` passes `lineageText` to `SessionHeader`.
- `apps/web/src/components/project-message-view/SessionHeader.tsx` already renders an expanded References section plus action controls and infrastructure context.
- `apps/web/tests/unit/components/session-header.test.tsx` covers expanded header metadata and is the right place for focused unit coverage.
- UI rules require mobile-first Playwright visual verification for changes in `apps/web`.

## Implementation Checklist

- [ ] Add a typed source context object for selected fork/retry sessions.
- [ ] Pass source context from the project chat page into `ProjectMessageView` and `SessionHeader`.
- [ ] Render source parent title, task ID, and session ID in the expanded header panel near action controls.
- [ ] Keep the closed header compact, with only the existing lineage subtitle.
- [ ] Add/update unit tests for source context rendering and absent-state behavior.
- [ ] Run local typecheck/lint/test validation for touched web files.
- [ ] Run Playwright visual audit on mobile and desktop.

## Acceptance Criteria

- [ ] Forked/retried selected sessions show a Source area in the expanded session header.
- [ ] The Source area shows a human-readable parent title when available.
- [ ] The Source area exposes copyable parent task and parent session IDs.
- [ ] Non-fork/non-retry sessions do not show the Source area.
- [ ] The collapsed header remains compact and does not add verbose parent metadata.
- [ ] The layout works without horizontal overflow on mobile and desktop.
- [ ] Existing retry/fork/new chat flows keep working.
