# `SchedulesPanel` polls on a hardcoded 30s literal that its own task file said was a rule violation

## Problem

`apps/web/src/components/project-events/SchedulesPanel.tsx:324-325`:

```tsx
refetchInterval: 30_000,
refetchIntervalInBackground: false,
```

`PROJECT_SCHEDULES_POLL_MS` does not exist in `apps/web/src/lib/poll-intervals.ts`, and no
`VITE_PROJECT_SCHEDULES_POLL_MS` override exists anywhere.

This breaks two things the repo already requires:

- `.claude/rules/60-request-io-and-bundle-budgets.md` — "Polling intervals MUST be env-configurable
  with a `DEFAULT_*` constant."
- Constitution Principle XI (no hardcoded values) — `.claude/rules/03-constitution.md`.

The `refetchIntervalInBackground: false` half is correct: rule 60 also requires polling to stop
when the tab is hidden, and it does.

## How this was found

Discovered 2026-09-23 by the `task-completion-validator` during the weekly queue reconciliation,
while checking whether `2026-09-18-polish-project-events-page-ui.md` was safe to archive.

What makes this worth writing down: **the task file that shipped this code predicted the bug.**
Its own research section, item 7, reads:

> "Polling cadence is env-overridable, per `.claude/rules/60` and constitution Principle XI —
> a bare `refetchInterval: 30_000` literal would violate both."

and its checklist carried:

> `- [ ] Add PROJECT_SCHEDULES_POLL_MS (default 30 s, VITE_PROJECT_SCHEDULES_POLL_MS override) to
apps/web/src/lib/poll-intervals.ts`

PR #2098 shipped the headline work — icons, semantic state colours via `event-state-tone.ts`,
count badges, per-section empty states, auto-refresh — and left exactly the item the author had
flagged as a rule violation. The checklist was never ticked, so nothing caught it. This is the
failure mode `.claude/rules/09` names: a research finding that became a checklist item and then
was not verified against the diff.

The parent task file is archived at
`tasks/archive/2026-09-18-polish-project-events-page-ui.md`; the work it shipped is genuinely live,
so archiving it was right. This one item is the remainder.

## Implementation checklist

- [ ] Add `DEFAULT_PROJECT_SCHEDULES_POLL_MS = 30_000` and an exported `PROJECT_SCHEDULES_POLL_MS`
      to `apps/web/src/lib/poll-intervals.ts`, resolved through the existing `resolveIntervalMs`
      helper against `import.meta.env.VITE_PROJECT_SCHEDULES_POLL_MS` (match the
      `NODE_DETAIL_POLL_MS` shape at `poll-intervals.ts:40-42`).
- [ ] Replace the literal at `SchedulesPanel.tsx:324` with that constant.
- [ ] Keep `refetchIntervalInBackground: false` — it already satisfies rule 60's visibility clause.
- [ ] Sweep `apps/web/src/components/project-events/` for any other bare interval literal.
- [ ] Add a test asserting the override is honoured, so deleting the constant reddens something.

## Acceptance criteria

- [ ] No bare polling-interval literal remains in `apps/web/src/components/project-events/`.
- [ ] Setting `VITE_PROJECT_SCHEDULES_POLL_MS` changes the observed interval; a test proves it.
- [ ] `grep -rn "refetchInterval: [0-9]" apps/web/src/components/project-events/` returns nothing.

## References

- `.claude/rules/60-request-io-and-bundle-budgets.md` — polling hygiene
- `.claude/rules/03-constitution.md` — Principle XI
- `.claude/rules/09-task-tracking.md` — research findings must become verified checklist items
- `apps/web/src/lib/poll-intervals.ts` — the existing pattern to copy
- Parent: `tasks/archive/2026-09-18-polish-project-events-page-ui.md` (PR #2098)

## Resolution (2026-10-20)

Resolved by the Automation page (branch `sam/automation-page`, task
`tasks/archive/2026-10-20-automation-page.md`), which replaced the project Events page:

- `SchedulesPanel.tsx` and the rest of `apps/web/src/components/project-events/` were deleted.
- Schedules and watches now refresh at `AUTOMATION_POLL_MS` in `apps/web/src/lib/poll-intervals.ts`
  (`DEFAULT_AUTOMATION_POLL_MS = 30_000`, `VITE_AUTOMATION_POLL_MS` override, resolved through the
  existing `resolveIntervalMs`), with `refetchIntervalInBackground` left at its `false` default.
- `apps/web/tests/unit/pages/automation-polling.test.tsx` drives the real overview: it proves the
  cadence, that a hidden tab stops polling, and that the env override is honoured. Each assertion
  was confirmed red by removing the interval or forcing background polling.
