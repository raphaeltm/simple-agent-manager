# Final SAM primary-control sizing audit

Local mocked browser validation, 2026-10-20. This is not final-deployment staging evidence.

Changed only SAM primary-control sizing: shared `Button size="lg"` for Voice input, Stop SAM turn, Send, settings enable switch, and Confirm this action. Open Settings and Open SAM retain semantic links with token-based 56px minimum targets; no nested interactive elements. Considered ad-hoc minimum-height overrides, but shared large size keeps button typography/spacing consistent. Handler/effect behavior is unchanged.

Final local audit: **28/28 passed** on desktop 1280×800 and mobile 375×667, with explicit 320×667 cases. Browser bounding-box assertions require width and height of at least 56 CSS pixels for every changed primary control, including active Stop, confirmation, switch, and links. Overflow/clipping checks, request-key retries, cancellations, history, disabled access and update behavior also pass.

Command (from apps/web):

```sh
pnpm exec playwright test tests/playwright/sam-assistant-audit.spec.ts --config=playwright.audit.config.ts --project='iPhone SE (375x667)' --project='Desktop (1280x800)' --output=/tmp/sam-ui-final-audit
```

Each PNG here was visually inspected. Desktop and mobile captures cover settings, off-route entry, confirmation and active composer. Additional 320px captures cover the same surfaces. No horizontal overflow, overlapping controls or clipped changed content found. At 320px Voice/Stop stack and Confirm/Decline wrap into separate rows; at 375px they fit side-by-side. Existing settings tabs use their normal horizontal scroll and are outside this change.

Rubric: visual hierarchy 4/5; interaction clarity 4/5; mobile usability 4/5; accessibility 4/5; system consistency 5/5. Compromise: 56px controls consume more vertical room on narrow screens, with wrapping preserving usability.

Scoped ESLint passed. Web typecheck passed after rebuilding stale `@simple-agent-manager/acp-client` declarations (the initial unrelated `UserMessageAttribution.scheduled` error required no source change). Standalone strict checking of the audit file also reaches an existing unused `@ts-expect-error` in `audit-helpers.ts:412`; the app typecheck and executed browser audit pass. The staging operator diagnostic spec passes its own strict TypeScript check and test discovery; it was not run live during this audit.

Final deployed-candidate mobile/desktop verification remains required. This audit does not establish live voice transcription, live dispatch, or a complete staging journey.
