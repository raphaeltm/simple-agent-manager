# Session Header Details Surface

## Problem

The project chat session header crams the session title, lineage, workspace profile, port chips, retry/fork controls, status, loading indicator, and details toggle into a single row. On mobile and dense desktop states this hides the title and makes it hard to inspect the conversation title or the initial prompt that started the session.

The prototype in PR #1440 explored three layouts. Raphaël confirmed variation B: a title-led two-line collapsed header with the expanded details panel as the canonical surface for the full title, initial prompt, metadata, infrastructure, and all exposed ports.

## Research Findings

- Prior session: `8822c0e3-f3e8-4915-8363-eb715bab13ce`.
- Prototype PR: #1440, branch `prototype/title-led-session-header`, commit `91bf927aa`.
- Real header: `apps/web/src/components/project-message-view/SessionHeader.tsx`.
- Real parent data owner: `apps/web/src/components/project-message-view/index.tsx`, which has `lc.messages`.
- Session detail API returns a newest-first page from ProjectData, then reverses that page to chronological order. For long sessions, `lc.messages[0]` is not guaranteed to be the initial prompt.
- Existing message list endpoint supports roles, before, limit, and compact. It needs either ascending order support or a first-message helper for reliable initial prompt fetch.
- User explicitly requested no staging deployment or staging verification for this `/do` run.

## Checklist

- [x] Extend persisted message retrieval to support oldest-first user-message fetch without changing default newest-page behavior.
- [x] Update API route/query parsing and frontend API client types.
- [x] Fetch the initial user prompt on first details expansion or use a reliable preloaded fallback.
- [x] Implement variation B in the real `SessionHeader`: two-line clamped title row plus compact metadata row.
- [x] Make expanded details show the full title and initial prompt before existing references/metadata/actions/infra.
- [x] Preserve existing controls: retry/fork, public ports toggle, workspace/file/git/timeline/complete actions, source context, all port links.
- [x] Add unit tests for initial prompt rendering, fetch behavior, `+N more`, title fallback, and expanded details.
- [x] Add or extend Playwright audit coverage for long title, long prompt, many ports, special characters, mobile and desktop overflow.
- [x] Run local validation. Do not deploy to staging.

## Acceptance Criteria

- Collapsed session header remains usable at mobile width with long titles and many ports.
- Full title and initial prompt are discoverable from the expanded details surface.
- Long sessions still show the true first user prompt, not merely the first message in the loaded viewport page.
- No prototype route or mock page is shipped.
- Unit and visual tests cover the new behavior.
- Staging deployment and staging verification are skipped by explicit user instruction.

## Validation

- `pnpm --filter @simple-agent-manager/shared build`
- `pnpm --filter @simple-agent-manager/ui build`
- `pnpm --filter @simple-agent-manager/providers build`
- `pnpm --filter @simple-agent-manager/cloud-init build`
- `pnpm --filter @simple-agent-manager/acp-client build`
- `pnpm --filter @simple-agent-manager/terminal build`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/web typecheck`
- `pnpm --filter @simple-agent-manager/api lint` (passes with existing warnings)
- `pnpm --filter @simple-agent-manager/web lint` (passes with existing warnings)
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/project-data-messages.test.ts tests/unit/routes/chat-session-agent-routing.test.ts tests/unit/services/project-data-retry.test.ts`
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/chat-session-agent-routing.test.ts tests/unit/services/project-data-retry.test.ts tests/unit/routes/mcp.test.ts`
- `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/session-header.test.tsx`
- `pnpm --filter @simple-agent-manager/web exec eslint tests/playwright/session-header-agent-info-audit.spec.ts`
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/session-header-agent-info-audit.spec.ts --project='iPhone SE (375x667)' --project='Desktop (1280x800)'`
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/session-header-agent-info-audit.spec.ts --project='iPhone SE (375x667)' --grep='title-led header handles long title'`

Worker test note:

- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/project-data-do.test.ts` could not execute because `workerd` exits with signal 11 before tests run. The message-order behavior is covered by focused ProjectData unit tests and API route tests.

## Completion Audit

`$task-completion-validator` verdict: WARN.

- PASS: research findings, checklist items, UI-to-API propagation, and acceptance criteria are covered by the implementation.
- WARN: the worker-level Durable Object test is present but cannot execute locally because `workerd` exits with signal 11 before running tests.
