# Fix Project Chat Tool-Call Lazy Loading

## Goal

Make every project-chat tool-call card expandable and have expansion fetch content from the server instead of rendering live inline tool output.

## Evidence

- Staging session `bb34957f-fdd5-4108-8d31-452886a7a357` showed live WebSocket rows with inline `toolMetadata.content`.
- Persisted REST history returned compact rows with `contentSize` and no `content`.
- After reload, tool-call cards had no expandable affordance, while direct `/tool-content` requests returned stored output.

## Implementation Checklist

- [x] Record SAM idea with root cause and plan.
- [x] Normalize project-chat tool messages to lazy-load content.
- [x] Preserve lazy-load pointers when merged tool updates arrive.
- [x] Make empty stored tool output load cleanly.
- [x] Run focused regression tests.
- [x] Run a browser-level validation.

## Local Validation

- `pnpm lint` passed.
- `pnpm typecheck` passed.
- `pnpm test` passed.
- `pnpm build` passed.
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/project-chat-tool-call-audit.spec.ts --project='Desktop (1280x800)'` passed.

## Staging Validation

- GitHub Actions staging deploy `26743663288` passed, including deploy health check and smoke tests.
- Cloudflare D1 staging sanity check passed before deploy; latest applied migration was `0057_github_trigger_configs.sql`, and this fix required no new migration.
- Targeted Playwright/Chrome validation against staging session `bb34957f-fdd5-4108-8d31-452886a7a357` passed.
- The staging API returned 53 session messages, including 33 persisted tool rows and 15 unique tool calls.
- The persisted data included 16 compact tool rows with `contentSize` and without inline `toolMetadata.content`.
- Direct staging `/tool-content` requests returned server-side content for the sampled tool messages, including one existing empty-output tool message returning an empty content array.
- In the deployed staging UI, 10 visible tool-call cards exposed an expand affordance. Clicking 8 sampled tool-call expanders produced 8 successful `200` `/tool-content` responses and rendered loaded content.

## Review Notes

- Task completion: implementation matches the checklist; staging validation remains the final proof.
- UI/UX: every tool call now keeps an expandable affordance via `messageId` plus `contentLoaded: false`; empty output renders as `No output.` after the server fetch.
- Cloudflare: no D1 migration or binding change is required. The ProjectData DO RPC now returns an empty content array for existing tool messages without stored content, while missing or non-tool messages still return `null`.
