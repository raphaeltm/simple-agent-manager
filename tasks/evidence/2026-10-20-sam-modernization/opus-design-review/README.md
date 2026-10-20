# Opus 5.5 design review: SAM assistant (PR #2386)

Dedicated design review of `/sam` and the settings opt-in, 2026-10-20.

- Reviewer: task `01M5D642QGN0QWKX6Z1N9BJ2BV`, runtime model `claude-opus-5-5` (claude-code, effort max), matching profile "Opus 5.5 Chat".
- Reviewed head `2fcf73bab4540a3d2f5a61033a5aab8dfd342ad2`. Code fixes end at `7753a3ee1cc5cfa22e08069f4a13140ae7773e87`.
- Method: local Playwright against the real web app with mocked API responses (`apps/web/tests/playwright/sam-assistant-audit.spec.ts`), at 375×667, 390×844, 768×1024 and 1280×800, with extra 320px cases. I opened and reviewed every screenshot myself.
- These are mock-data UI checks, not live staging evidence. The final live journey stays with the release owner.

## What was wrong at the reviewed head

| # | Finding | Severity |
| --- | --- | --- |
| 1 | The conversation was ordinary page flow. It opened at the oldest loaded turn, and the composer sat below every turn, so long histories pushed it off screen. Errors in the composer could also land below the fold. | Blocking |
| 2 | `bg-surface-secondary` and `bg-surface-primary` are not design tokens. The user bubble, action cards, composer and textarea rendered with no surface, so your messages looked the same as SAM's. | Blocking |
| 3 | Destructive confirmation showed an internal name ("stop task"), raw JSON (in production only IDs) and "Confirm this action". It never said what would happen and offered no way to review the target. The mock used a non-existent operation (`sam_stop_task`). | Blocking |
| 4 | The server strips every read receipt to `{}`, but each still rendered as a full card with an empty details box. A normal answer would carry several of these. Mocks never exercised it. | Blocking |
| 5 | The settings switch was a text button labelled "On"/"Off", which reads as either state or action. The card took about 410px of the first mobile screen above all settings tabs. | Blocking |
| 6 | The SAM and Chats nav items shared the `MessageSquare` icon, so they were indistinguishable in the collapsed sidebar and the mobile drawer. | Blocking |
| 7 | Every turn showed "SAM · completed". The stop hint showed even with nothing running. The empty state carried an implementation disclaimer. | Polish |
| 8 | 56px Voice/Send/Confirm buttons were much heavier than the project chat composer (44px). The 56px mandate was removed from agent guidance in June 2026 (`95c810a49`); the `apps/web/AGENTS.md` line is stale. The Automation page you approved uses ≥44px. | Polish |
| 9 | Raw browser errors ("Failed to fetch"). In the uncertain receipt, the link and the "Check outcome" button touched. "Open source work" wording. Work cards fell back to raw IDs. | Polish |

The independent security review found three more issues, all fixed here:

- **HIGH:** the shared `VoiceButton` could start recording after a late microphone grant with no usable Stop control.
- **Privacy blocker:** recorder start-up failures left the microphone on.
- Non-completed reads showed in the "Checked" summary, and agent-answer approvals hid the proposed answer.

## What changed

| Area | Change |
| --- | --- |
| Layout (`pages/Sam.tsx`, `sam/useStickToBottom.ts`) | Full-height chat like project chat: header, a scroller and a pinned composer. Opens at the newest turn. Follows new content only while you are at the bottom. Keeps your place when older messages load (manual anchoring, identical in Safari). Adds a "Scroll to bottom" button. |
| Turns (`sam/SamTurn.tsx`) | User messages use the project chat `glass-msg-user` bubble. The status label appears only for exceptions: "SAM · working/cancelled/failed/interrupted". |
| Receipts (`sam/ActionCard.tsx`, `sam/sam-receipts.ts`) | Completed reads become one quiet "Checked …" line. Each effect card has a plain title and states its status ("Needs your confirmation", "Done", "Outcome unknown", "Declined"). It names the project using the cached project list, links to the chat/task for review, and says what confirming does. Buttons are action-specific ("Confirm stop"/"Keep running", "Send answer"/"Don’t send"). Agent answers show the proposed answer. "Exact request" is open by default during approval. |
| Composer (`sam/SamComposer.tsx`) | Auto-growing textarea, the shared `VoiceButton`, and 44px Send/Stop/Retry. Ctrl/Cmd+Enter sends, with a desktop hint. Errors show inside the pinned composer in plain words. Recording and transcribing state is shown in text. The stop hint shows only while a turn runs. |
| Empty state | Centred prompt with three starters that fill the composer and never send. |
| Settings (`SamSettingsCard.tsx`) | Compact card with the Notifications-style switch. The accessible name stays "Enable SAM assistant", with a visible On/Off word. |
| Navigation (`NavSidebar.tsx`) | SAM uses the `Bot` icon. |
| Voice (`packages/acp-client/.../VoiceButton.tsx`) | A capture epoch is invalidated on unmount, on disable and on a newer start. Late grants are released without recording. Recorder start-up failures release the stream. StrictMode resets `unmountedRef`. Stop stays usable during a recording. |

No API, schema, Worker, runtime, settings or permission behaviour changed. Default-OFF opt-in, navigation and direct-route gating, and the `/settings` deep link are preserved.

## Variants considered

1. **Kept:** page-flow conversation with the composer at the end. Simplest, but long histories hide both the composer and the newest reply.
2. **Chosen:** full-height chat with a pinned composer and anchored scrolling. It matches project chat and is best on phones.
3. **Rejected:** a two-pane desktop layout with a project-work rail. It reads as a dashboard, contradicts "quiet updates", and adds a mobile-only path.

For settings, the alternative was a dedicated "SAM" settings tab. It would add a route and break the staging `/settings` selector, so I kept a compact card above the tabs. The tabs stay on the first mobile screen, and this is asserted.

## Verification

- `sam-assistant-audit.spec.ts`: 96/96 across four viewports. Tests measure coordinates for the pinned composer, newest turn on load, older-history anchoring, link/action spacing, bubble surface, 44px targets, and overflow (including clipped overflow).
- Discriminating checks: I reverted each fix alone and its test went red. This covers stick-to-bottom, the prepend anchor, the pinned layout, the bubble surface, the nav icon, link/action spacing, completed-only reads, default-open approvals, the inline proposed answer, and each `VoiceButton` safety fix (late grant, disable, StrictMode, Stop usable, start-up failure).
- `apps/web` unit suite: 363 files, 4,315 tests. `acp-client`: 577 tests. Project-chat `VoiceButton` consumers were re-run.
- Staging selectors were updated only for renamed buttons: "Start voice input" and "Confirm stop". `/settings`, the switch name, "Message SAM", "Send" and "SAM · cancelled" are unchanged.

## Rubric (final)

| Category | Score | Notes |
| --- | ---: | --- |
| Visual hierarchy | 5 | Distinct bubbles, quiet receipts, exception-only status, confirmation card stands out. |
| Interaction clarity | 5 | Action-specific buttons, review link before confirming, plain errors, visible recording state. |
| Mobile usability | 5 | Pinned composer, newest turn on load, one-line composer at 320px, no overflow. |
| Accessibility | 4 | Labelled switch, labelled receipt groups, `role=status` for progress and voice, keyboard send. The shared `VoiceButton` still uses light-theme gray hover classes. |
| System consistency | 5 | Reuses the project chat bubble, `VoiceButton`, scroll button, switch pattern and design tokens. |

## Notes for the release owner (outside this design change)

- `apps/web/src/pages/SamPrototype.tsx` is no longer routed. The `sam-prototype/` helpers are still used by `ProjectAgentChat.tsx`.
- Other pages (admin, credentials) also use the undefined `bg-surface-secondary`/`bg-surface-primary` classes.
- `apps/web/AGENTS.md` still states a 56px minimum that agent guidance removed in June 2026.
