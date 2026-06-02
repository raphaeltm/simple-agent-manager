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

- [x] Add a typed source context object for selected fork/retry sessions.
- [x] Pass source context from the project chat page into `ProjectMessageView` and `SessionHeader`.
- [x] Render source parent title, task ID, and session ID in the expanded header panel near action controls.
- [x] Keep the closed header compact, with only the existing lineage subtitle.
- [x] Add/update unit tests for source context rendering and absent-state behavior.
- [x] Run local typecheck/lint/test validation for touched web files.
- [x] Run Playwright visual audit on mobile and desktop.

## Acceptance Criteria

- [x] Forked/retried selected sessions show a Source area in the expanded session header.
- [x] The Source area shows a human-readable parent title when available.
- [x] The Source area exposes copyable parent task and parent session IDs.
- [x] Non-fork/non-retry sessions do not show the Source area.
- [x] The collapsed header remains compact and does not add verbose parent metadata.
- [x] The layout works without horizontal overflow on mobile and desktop.
- [x] Existing retry/fork/new chat flows keep working.

## Validation

- Focused unit tests passed: `pnpm --filter @simple-agent-manager/web test -- session-header.test.tsx sessionTree.test.ts`
- Focused web checks passed: `pnpm --filter @simple-agent-manager/web typecheck`; `pnpm --filter @simple-agent-manager/web lint`
- Playwright visual audit passed on mobile and desktop: `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/session-header-agent-info-audit.spec.ts --project="iPhone SE (375x667)" --project="Desktop (1280x800)"`
- Full pre-PR checks passed: `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm build`
- Task-completion-validator local review: PASS. Research findings, checklist items, and acceptance criteria are covered by the production diff and tests; no UI input-to-backend propagation path was introduced.
- SAM task-completion-validator subtask dispatched for independent review: `01KT3XZ1FJFRM1KGDKC5AJCVJ6`.
