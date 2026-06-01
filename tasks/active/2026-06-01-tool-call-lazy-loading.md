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

## Review Notes

- Task completion: implementation matches the checklist; staging validation remains the final proof.
- UI/UX: every tool call now keeps an expandable affordance via `messageId` plus `contentLoaded: false`; empty output renders as `No output.` after the server fetch.
- Cloudflare: no D1 migration or binding change is required. The ProjectData DO RPC now returns an empty content array for existing tool messages without stored content, while missing or non-tool messages still return `null`.
