# Chat Timeline Progress Notifications

## Problem

The project chat timeline was originally discussed as a way to show human messages plus agent notifications/status updates in a session. The production timeline drawer shipped, and later gained server-backed user-message loading, but agent progress updates from `update_task_status` still do not appear in the timeline.

Status updates already appear correctly in project notifications. The fix should pull the existing notification-backed progress rows into the timeline instead of changing how status updates are recorded unless that is necessary for wiring.

## Constraints

- Execute as `/do`.
- Do not deploy to staging or mutate staging. The user explicitly requested skipping the staging deploy part.
- Use local tests, local visual audit, specialist review, CI, and PR evidence instead of staging verification.

## Research Findings

- Original discussion: session `dbef6ab0-5975-4588-8457-7542fdc9fc94`, task `01KTVQA6265W1Y5SHWG75WDM6N`, created 2026-06-11. V1 was human messages plus session-scoped agent notifications. Final-agent snippets were considered V2 because live sessions only have token streams until materialization.
- PR #1304 merged 2026-06-12: `feat: production chat timeline drawer with session-scoped activity events`. It merged chat messages with ProjectData `activity_events`, not Notification DO rows.
- PR #1349 merged 2026-06-17: fixed long-session timeline user turns by loading persisted ProjectData messages from the server, but did not add progress notifications.
- Follow-up diagnosis: session `fb5da572-5826-48a2-bb74-682362847e1f`, task `01KW74AG4FBJC8J89XQZC6WTJ4`, created 2026-06-28. It identified that status updates are present in notifications and should be read into the timeline.
- `apps/web/src/components/project-message-view/useSessionTimeline.ts` currently fetches user messages and `listActivityEvents(projectId, { sessionId })`.
- `apps/web/src/components/project-message-view/buildSessionTimeline.ts` only renders activity events behind the Context toggle.
- `apps/web/src/lib/api/notifications.ts` can list notifications by `type` and `projectId`, but not by `sessionId`.
- `apps/api/src/durable-objects/notification.ts` stores `session_id` on notifications and `apps/api/src/services/notification.ts:notifyProgress()` passes `sessionId` through when available.
- `apps/api/src/routes/mcp/task-tools.ts` also tries to write a `task.progress` activity event, but the current timeline product source of truth should be the Notification DO because that is what users already see in notifications and because progress notifications are intentionally batched.

## Relevant Lessons

- Timeline/long-session features must query persisted server-side data, not the loaded UI cache.
- Cross-boundary features need vertical-slice tests with realistic state across API/client/DO boundaries.
- UI changes require local Playwright visual audit on mobile and desktop.

## Implementation Checklist

- [x] Add `sessionId` as a validated filter on `GET /api/notifications`.
- [x] Add `sessionId` support to `Notification.listNotifications()` and web `listNotifications()`.
- [x] Add an efficient Notification Durable Object index for session-scoped notification queries.
- [x] Extend timeline types and builder to support progress notification entries.
- [x] Update `useSessionTimeline()` to fetch current-session `progress` notifications and merge them into timeline entries.
- [x] Render progress/status entries visibly by default in the timeline drawer, using `metadata.fullMessage` when available and falling back to `body`.
- [x] Add or update API/DO tests proving `sessionId + type=progress + projectId` filtering works.
- [x] Add or update web tests proving timeline progress notifications are fetched, merged, sorted, and rendered.
- [x] Run local visual audit for the timeline drawer at mobile and desktop sizes.
- [x] Run local lint, typecheck, tests, and build.
- [x] Run required specialist reviews and address findings.
- [ ] Create PR with explicit note that staging was skipped by user instruction.

## Review Results

- `$task-completion-validator` — PASS. Research findings map to checklist items and the diff; acceptance criteria are covered by API/DO tests, timeline builder/hook/drawer tests, full suite validation, and local Playwright evidence. No new UI input propagation or multi-resource selection gaps.
- `$ui-ux-specialist` — PASS. Progress rows are visible by default in chronological order, with muted blue timeline dots and compact labels that do not compete with user turns. Screenshots were inspected at `apps/web/.codex/tmp/playwright-screenshots/timeline-drawer-desktop-1280x800.png` and `apps/web/.codex/tmp/playwright-screenshots/timeline-drawer-mobile-messages-375x667.png`; no overlap, clipping, or horizontal overflow observed.
- `$test-engineer` — PASS. Coverage includes route validation, Durable Object filtering with realistic notification state, client API wiring, hook pagination, timeline builder merge/sort behavior, drawer rendering, and Playwright audit coverage.
- `$cloudflare-specialist` — PASS. Notification DO migration is append-only, the new composite index matches the session/project/type query shape, and no D1/staging mutation was performed.
- `$constitution-validator` — PASS. The implementation avoids a new hardcoded client-side notification limit by following notification pagination. The session ID regex is a bounded input-validation guard, not a deployment/config constant.
- `$doc-sync-validator` — PASS. Internal API reference coverage was updated for the `GET /api/notifications` `sessionId` filter. No public docs, environment variables, or self-hosting docs required changes.

## Validation Evidence

- `git diff --check` passed.
- `pnpm typecheck` passed.
- `pnpm lint` passed with existing warnings only.
- `pnpm test` passed across the repo, including API 356 files / 5,568 tests and web 199 files / 2,494 tests.
- `pnpm build` passed.
- Focused API notification tests passed: `notifications-validation`, `notification-migrations`, `notification-suppression`.
- Focused web timeline tests passed: `buildSessionTimeline`, `useSessionTimeline`, `ChatTimelineDrawer`.
- Local Playwright audit passed: `apps/web/tests/playwright/chat-timeline-drawer-audit.spec.ts` across iPhone SE and Desktop projects, 8/8.
- Staging deployment and staging mutation were intentionally skipped by explicit user instruction.

## Acceptance Criteria

- Opening the project chat timeline can show progress/status updates for the current session using existing notification data.
- Progress entries are scoped to the current project and session, and do not include progress notifications from other sessions.
- Progress entries show useful user-visible text from `metadata.fullMessage`, `body`, or title in that priority order.
- Progress notification batching behavior is preserved.
- Existing user-message and context-event timeline behavior continues to work.
- Local tests cover the API/backend filter path and the UI timeline merge/render path.
- No staging deployment is performed for this task.

## References

- SAM idea `01KWC118XAAE2G5FK3FKV0DM8X`
- PR #1304: `feat: production chat timeline drawer with session-scoped activity events`
- PR #1349: `Fix timeline to load server messages`
- `apps/api/src/durable-objects/notification.ts`
- `apps/api/src/routes/notifications.ts`
- `apps/web/src/lib/api/notifications.ts`
- `apps/web/src/components/project-message-view/useSessionTimeline.ts`
- `apps/web/src/components/project-message-view/buildSessionTimeline.ts`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/35-vertical-slice-testing.md`
