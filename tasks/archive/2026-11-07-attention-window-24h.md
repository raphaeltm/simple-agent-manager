# Limit the chat list's Needs attention section to the last 24 hours

## Problem

After #2560 shipped, Raphaël's production list showed a "Needs input" from 2026-09-13 and a
two-day-old wake failure under **Needs attention**. Old, unanswered requests are not a to-do
list; they crowd out what actually needs a person now. He asked to limit the section to the last
24 hours.

## Implementation checklist

- [x] `ATTENTION_WINDOW_MS` (default 24h, `VITE_ATTENTION_WINDOW_MS` override) in
      `apps/web/src/lib/chat-session-utils.ts`
- [x] `getSessionSection` places a needs_input / wake_failed chat in attention only when the later
      of its marker `createdAt` and last activity is within the window; otherwise it falls back to
      Awake or Sleeping, keeping its row label
- [x] The mobile attention count follows (it counts the attention section)
- [x] Tests: window placement, badge count (both proven discriminating); rendered page fixture uses
      a recent wake failure; Playwright audit includes a 55-day-old request that lands in Awake
- [x] Docs: chat-features, session-troubleshooting

## Acceptance criteria

- [x] A request older than 24h is not under Needs attention and not in the badge count
- [x] A recent wake failure on an old chat is still under Needs attention
