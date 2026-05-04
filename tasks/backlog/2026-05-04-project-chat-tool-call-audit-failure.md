# Project chat tool call Playwright audit fails to find persisted tool title

## Problem

The existing mocked Playwright audit `apps/web/tests/playwright/project-chat-tool-call-audit.spec.ts` fails because the expected persisted tool title is not visible:

`Bash: pnpm --filter @simple-agent-manager/web test -- chatMessagesToConversationItems.test.ts`

## Context

Discovered while verifying the project chat message reconciliation fix on May 4, 2026.

Commands run:

- `pnpm --filter @simple-agent-manager/web exec playwright install chromium`
- `pnpm --filter @simple-agent-manager/web exec playwright install-deps chromium`
- `pnpm --filter @simple-agent-manager/web exec vite preview --port 4173 --host 127.0.0.1`
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/project-chat-tool-call-audit.spec.ts --project='iPhone SE (375x667)' --project='Desktop (1280x800)'`

After installing the missing browser and OS dependencies, the audit reached browser assertions but failed in all selected projects waiting for `TOOL_TITLE`.

Error context files were written under:

`.codex/tmp/playwright-screenshots/project-chat-tool-call-aud-*/error-context.md`

## Acceptance Criteria

- [ ] Determine whether the mocked route shape in `project-chat-tool-call-audit.spec.ts` is stale or the persisted tool rendering regressed.
- [ ] Update the test mock or fix the rendering path so the rich persisted tool title appears.
- [ ] Re-run the project chat Playwright audit on mobile and desktop.
