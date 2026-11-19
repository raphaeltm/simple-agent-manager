# Limit the chat list's Needs attention section to the last 24 hours

## Problem

After #2560 shipped, Raphaël's production list showed a "Needs input" from 2026-09-13 and a
two-day-old wake failure under **Needs attention**. Old, unanswered requests are not a to-do
list; they crowd out what actually needs a person now. He asked to limit the section to the last
24 hours.

## Implementation checklist

- [x] `ATTENTION_WINDOW_MS` (default 24h, `VITE_ATTENTION_WINDOW_MS` override) in
      `apps/web/src/lib/chat-session-utils.ts`
- [x] `getSessionSection` places a needs_input / wake_failed chat in attention only when its
      marker `createdAt` is within the window (so a busy chat cannot keep an old request on top);
      otherwise it falls back to Awake or Sleeping, keeping its row label
- [x] A malformed `VITE_ATTENTION_WINDOW_MS` falls back to the default (review finding), tested
      with `vi.stubEnv` for not-a-number, empty, 0 and -5
- [x] The mobile attention count follows (it counts the attention section)
- [x] Tests: window placement, badge count (both proven discriminating); rendered page fixture uses
      a recent wake failure; Playwright audit includes a 55-day-old request that lands in Awake
- [x] Docs: chat-features, session-troubleshooting

## Acceptance criteria

- [x] A request older than 24h is not under Needs attention and not in the badge count
- [x] A recent wake failure on an old chat is still under Needs attention

## Review and verification

- ui-ux-specialist: no blocking findings; NaN override guard and marker-time window fixed in
  c913e623f.
- Staging run 42369191416: two wake failures 42h/50h old left Needs attention for Sleeping
  (8 → 10); no badge; no errors at 375 and 1280.
- task-completion-validator: PASS; its one MEDIUM gap (no test for the override fallback) fixed
  with `ATTENTION_WINDOW_MS` tests in `chat-session-utils.test.ts`.
