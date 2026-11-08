# Show usage left on profiles in the new-chat picker

## Problem

When starting a chat, Raphaël can't see how much usage is left on the account each profile
runs on, so he picks a profile and only finds out it is exhausted when the agent stops.
He reviewed three prototypes (branch `sam/see-how-much-usage-fw9ybt`, `/prototype/profile-usage`)
and approved "A's wording inside C's layout" on 2026-11-08, with staging explicitly waived
("Implement it and ship it. Skip staging deployment.").

## Research findings

- Usage already exists per account: D1 `credential_limit_windows` → `GET /api/credentials/limits`,
  surfaced via `useAccountsData` (`apps/web/src/hooks/useAccounts.ts`).
- `useProfileBudgets` (`components/agent-profiles/useProfileBudgets.ts`) already resolves each
  profile to its account (profile pin → project → my default → platform) via
  `explainProfileAccount`, and `profileHeadroom` (`ProfileUsageStrip.tsx`) computes "left on the
  window that stops it first". The Profiles page uses both. Reuse; no new resolver (rule 24/59).
- Picker surfaces: `NewChatProfileCards.tsx`, `ProfilePickerSheet.tsx` + `ProfilePickerRows.tsx`,
  `ProfileToControl.tsx`, all rendered from `pages/project-chat/index.tsx` and `ChatInput.tsx`.
  `StartWorkSheet.tsx` (ideas) also renders `ProfilePickerSheet`; new props are optional so it is
  unchanged.
- `useAccountsData` issues ~7 user-scoped TanStack queries (limits polls). The project chat page
  must not pay that in active-session view: add an `enabled` option and only enable it while the
  new-chat view is showing (rule 60).
- Account resolution keys on the profile's agent type. A skill or Chat option can switch the agent,
  in which case the profile's account usage no longer applies; the composer must not claim it
  (rule 74: don't key on a correlated proxy).
- Levels (`warning`/`critical`/`rejected`) come from the server; no new thresholds.
- Docs: `apps/www/src/content/docs/docs/guides/agents.md` (Usage Limits; Choosing a profile).

## Design (approved)

- Fuel ring around the profile avatar on cards, sheet rows and the To chip; the filled arc is
  what is left. No ring when usage is unknown, platform, paused or no account.
- Numbers only when it matters, in plain words: `6% left · resets 52m`, `Out · back in 2h 10m`.
  Cards also say `No account connected` / `<account> paused`.
- Exhausted profiles fold into an **Out for now** section in the sheet (expanded while editing or
  searching).
- When the selected profile is low or out, a one-line nudge above the composer names the account
  and reset, and offers a same-agent, same-model profile on another account with room.
- Usage text is part of each control's accessible name.

## Checklist

- [x] `useAccountsData` / `useProfileBudgets` accept `enabled`
- [x] Usage model `profile-picker/usage.ts` (state, left, reset, words, alternative)
- [x] `ProfileUsageAvatar` ring component
- [x] Cards: ring, low/out/paused/none line, a11y label (no dimming: see notes)
- [x] Sheet rows: ring, trailing low/out/paused/none text, a11y label
- [x] Sheet: "Out for now" folded section (`pickerSections` out ids)
- [x] To chip: ring + a11y label
- [x] Composer nudge with switch suggestion; hidden when the effective agent differs
- [x] Wire budgets from the project chat page (enabled only in new-chat view)
- [x] Unit tests: usage model, sections, cards/sheet/nudge rendering
- [x] Playwright audit through the real page with mocked accounts + limits (mobile + desktop)
- [x] Docs: agents.md
- [x] Remove the prototype route and files

## Acceptance criteria

- Cards, sheet rows and To chip show a ring reflecting what's left for the profile's account.
- Low profiles read `N% left · resets X`; exhausted ones `Out · back in X` and sit under
  **Out for now** in the sheet.
- Selecting a low/out profile shows the nudge; tapping the suggestion selects that profile.
- No ring, no nudge, no extra requests in active-session view.
- No horizontal overflow at 375px and 1280px.

## Implementation notes

- Usage map is computed once on the project chat page (`useProfileUsages`) and passed to the cards,
  the composer (To chip, nudge) and the sheet; `StartWorkSheet` passes nothing and is unchanged.
- No dimming of exhausted cards: the red words carry it without lowering text contrast.
- Countdown refreshes when a limits poll lands (60s); TanStack keeps the same data object when a
  poll returns identical rows, so a countdown can lag by up to a minute between changes. Accepted.
- Gate discrimination: forcing `useProfileUsages(..., true)` fails
  `makes no account requests while a conversation is open` (verified, then restored).
- Staging waived by Raphaël for this task (2026-11-08).
