# Browser-Side Conversation Caching for Project Chat

## Problem

Switching between project chat sessions cold-loads conversations because the project message view remounts on every session change and message loading uses local `useState`/`useEffect` rather than the app's TanStack Query persistence path.

## Research Findings

- `apps/web/src/pages/project-chat/index.tsx` mounted `ProjectMessageView` with `key={state.sessionId}`, destroying the subtree on every session switch.
- `apps/web/src/components/project-message-view/useSessionLifecycle.ts` owned session/message loading locally and did not reuse persisted query data.
- `apps/web/src/lib/query-persist-config.ts` persisted only `projects/list`; chat persistence is now explicitly approved for session messages only.
- `apps/api/src/routes/chat.ts` and `apps/api/src/durable-objects/project-data/messages.ts` supported backward pagination via `before` but no forward cursor for cached delta refresh.

## Checklist

- [x] Add `after` cursor to chat session detail and messages endpoints.
- [x] Add ProjectData DO `created_at > ?` filtering.
- [x] Add configurable default for forward-cursor delta fetches.
- [x] Update web API client to pass `after`.
- [x] Add project chat session message query key/options.
- [x] Migrate initial session/message loading in `useSessionLifecycle` to TanStack Query.
- [x] Delta-fetch newer messages when cached data exists and merge cached + new rows.
- [x] Persist approved `sessions/messages` query data only.
- [x] Add cache eviction/encryption TODOs required by task brief.
- [x] Remove project chat remount key.
- [x] Add focused tests for cursor, persistence allowlist, cache clearing boundary, and delta-fetch merge.

## Acceptance Criteria

- [x] Cached project chat session messages render immediately when revisiting a session while TanStack Query revalidates in the background.
- [x] Revalidation can request only messages newer than the cached newest message.
- [x] Local persistence remains identity-scoped and allowlisted to approved operations.
- [x] Logout/account-switch cache clearing behavior remains covered by existing persistence/AuthProvider tests.
- [x] No staging deployment is performed for this task.

## Verification

- `pnpm --filter @simple-agent-manager/shared build`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/web typecheck`
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/project-data-messages.test.ts`
- `pnpm --filter @simple-agent-manager/web test -- tests/unit/lib/query-persistence-allowlist.test.ts tests/unit/lib/query-persistence.test.ts tests/unit/components/useSessionLifecycle.test.ts`
- `pnpm --filter @simple-agent-manager/api lint`
- `pnpm --filter @simple-agent-manager/web lint` (passes with existing unrelated warnings)
- `pnpm --filter @simple-agent-manager/shared lint`
- `pnpm build`
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/mcp.test.ts tests/unit/services/project-data-retry.test.ts tests/unit/services/task-final-assistant-message.test.ts`
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/stuck-tasks.test.ts tests/unit/routes/mcp-error-handling.test.ts tests/unit/routes/mcp-streamable-http.test.ts`
- `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/project-message-view.test.tsx tests/unit/components/chat/project-message-view-resume.test.tsx`
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/project-chat-streaming-poll-audit.spec.ts --config=playwright.config.ts --project='iPhone SE (375x667)' --project='Desktop (1280x800)'`
- `pnpm test` (full monorepo rerun reached 570/573 API files passing; three failures were one stale expectation since fixed and two MCP hook timeouts that passed in focused rerun)
