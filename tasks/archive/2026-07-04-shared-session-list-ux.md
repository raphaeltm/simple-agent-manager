# Shared session list UX and creator-only chat writes

## Problem

Shared project authorization now allows active project members to read project-scoped resources, but the project chat UI and session APIs still behave like a single-user surface. Members need to see all project sessions, distinguish who created each one, filter between their own sessions and all sessions, and avoid accidentally writing into another member's running agent session.

## Research Findings

- `apps/api/src/routes/chat.ts` now uses `requireProjectAccess` for list/read and `requireProjectCapability` for write routes. That grants active members access but does not yet enforce session creator ownership for prompt/cancel/idle reset.
- `apps/api/src/durable-objects/project-data/sessions.ts` stores chat sessions in ProjectData SQLite, but `chat_sessions` does not currently include a creator/owner column in the row schema or list/detail responses.
- `apps/api/src/services/project-data.ts` and all session creation callers currently call `createSession(workspaceId, topic, taskId)` without `userId`, so the DO cannot preserve creator attribution unless the contract is extended.
- Existing session creation paths include project chat submission, task submit/run, MCP dispatch/retry/orchestration, trigger submission, trial runner, workspace CRUD, and SAM session tools. These paths already know the actor `userId` and should pass it through instead of treating project owner as the session owner.
- `apps/web/src/lib/api/sessions.ts` defines the session response contract used by the project chat UI. It lacks owner/creator metadata and list filtering params.
- `apps/web/src/pages/project-chat/useProjectChatState.ts` owns the project chat state, fetches sessions with `listChatSessions`, and locally filters by search/stale buckets. This is the right place to add `my/all` filter state and selected-session creator checks.
- `apps/web/src/pages/project-chat/SessionItem.tsx`, `SessionList.tsx`, and `SessionTreeItem.tsx` render the dense sidebar list; ownership indicators should be restrained and fit this compact surface.
- `apps/web/src/pages/project-chat/ChatInput.tsx` and `ProjectChatComposer` render the composer. Another member's selected session needs a read-only state with an affordance to start a related/new session rather than a dead input.
- Relevant retained lessons: `.claude/rules/06-technical-patterns.md` warns against session identity inference and React handler/effect collisions; `.claude/rules/17-ui-visual-testing.md` requires Playwright screenshots for UI changes; `.claude/rules/35-vertical-slice-testing.md` requires realistic boundary tests for UI/API/DO behavior; `.claude/rules/26-project-chat-first.md` makes project chat the primary surface.

## Implementation Checklist

- [x] Add durable ProjectData creator attribution for chat sessions (`created_by_user_id` or equivalent), including migration, row schema, list/detail mapping, and session-created broadcast payload.
- [x] Extend `projectDataService.createSession` and all session creation callers to pass the actor `userId` while preserving existing optional task/workspace/topic behavior.
- [x] Add API support for session list filtering by creator (`scope=my|all` or equivalent) and return safe creator metadata for list and detail responses.
- [x] Enforce creator-only writes in API routes that submit, cancel, or reset follow-up activity for an existing session. Active non-creator project members must be able to list/view but not write.
- [x] Update web API types and request helpers for owner metadata and my/all filtering.
- [x] Implement the My sessions / All sessions filter near the existing project-chat search input using the production chat page/components.
- [x] Add compact ownership indicators in the sidebar session list and selected session view. Labels should distinguish the current user from other creators without exposing private data beyond safe display metadata.
- [x] Replace the composer for non-creator selected sessions with a clear read-only state and an action to start a new/related session.
- [x] Add focused API/DO tests for member list/view access, my/all filtering, creator-only prompt submission, and creator submission success.
- [x] Add focused web tests for filter behavior, ownership labels, read-only non-creator composer, and mobile usability.
- [x] Run local Playwright visual audit for project chat on desktop and mobile with normal, long, empty, many-session, error, and special-character mock data.
- [x] Run required quality gates, specialist validation, and staging verification per `/do`.

## Acceptance Criteria

- Active project members can list and view sessions created by other active project members.
- The project chat session list has a clear `My sessions` / `All sessions` control near search and switches using real data.
- Session ownership is obvious in the list and selected session view, with a clear "you" state for the current user's sessions.
- Non-creators cannot submit prompts, cancel, or reset/write into another member's session via API.
- Non-creators see a read-only composer state with a useful start-new/related-session affordance.
- Creator attribution remains based on the session creator/actor `userId`, not the project owner.
- API and web tests cover the new shared-session behavior.
- Playwright screenshots demonstrate the real production project chat UI remains usable on mobile and desktop.

## Validation Evidence

- Local gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm quality:do-migration-safety`, and `pnpm quality:migration-safety` passed.
- Focused API tests: `apps/api/tests/unit/routes/chat-prompt-cancel.test.ts` covers shared list scope, creator metadata, and creator-only prompt/cancel behavior.
- Focused UI audit: `apps/web/tests/playwright/shared-session-ux-audit.spec.ts` passed for desktop and iPhone SE viewports.
- Staging deploy: GitHub Actions run `28713609487` passed deploy, migration data-integrity, health-check, and smoke-test jobs.
- Staging API verification: `scope=my` returned the smoke-test user's created session, `scope=all` returned that session plus legacy project sessions, and creator metadata/isMine fields were present.
- Staging UI verification: deployed project chat rendered the My sessions / All sessions control, owned-session indicator, and no mobile horizontal overflow. Non-creator read-only composer behavior is covered by local Playwright because staging did not have a live active session owned by another member.

## References

- `apps/api/src/durable-objects/project-data/sessions.ts`
- `apps/api/src/durable-objects/migrations.ts`
- `apps/api/src/services/project-data.ts`
- `apps/api/src/routes/chat.ts`
- `apps/web/src/lib/api/sessions.ts`
- `apps/web/src/pages/project-chat/useProjectChatState.ts`
- `apps/web/src/pages/project-chat/SessionItem.tsx`
- `apps/web/src/pages/project-chat/ChatInput.tsx`
- `.claude/rules/06-technical-patterns.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/26-project-chat-first.md`
