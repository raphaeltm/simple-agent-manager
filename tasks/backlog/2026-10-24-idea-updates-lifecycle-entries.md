# Idea Updates: show lifecycle changes in the timeline

## Problem

The idea page's Updates timeline shows authored notes only. Nothing records that an idea was
marked done, parked, reopened or kept open, so a reader sees the plan and the discussion but not
the decisions — and a state change that someone made deliberately leaves no trace in the one
place the idea's history is told.

## Context

T8 PR2 (#2439, `d41ff95d6`) shipped the idea page. Its checklist item read "Updates (T3 notes +
composer + quote + **derived lifecycle entries**)" and was checked off, but lifecycle entries
were never built. `task-completion-validator` found the gap after the merge: `IdeaUpdateNote`
(`packages/shared/src/types/idea-updates.ts`) has `authorKind: 'user' | 'agent'` with no system
kind, `apps/web/src/pages/ideas/idea-activity.tsx` synthesises no entries, and neither
`setProjectIdeaStatus` nor `keepProjectIdeaOpen` posts one.

It was not in the numbered acceptance criteria, which is why it is a backlog item rather than a
hotfix — but it was in the stated scope and was dropped silently, which is the thing rule 09
exists to prevent.

## Design question to settle first

Two options, and they are not equivalent:

1. **Derive at read time** from the status transitions the server already records, so no new
   writes and no backfill, but the timeline can only show what the transition log retains.
2. **Persist a note** on each transition (`authorKind: 'system'` or a new `kind`), which gives
   an exact record and survives any change to the transition log, but widens a shared type and
   needs a migration plus a decision about existing ideas.

Check what `activity_events` / the task status history already holds before choosing — option 1
may be free.

## Acceptance criteria

- [ ] The decision between deriving and persisting is recorded, with the evidence that settled it
- [ ] Marking done, parking, reopening and keeping open each appear in Updates
- [ ] An idea with no transitions still renders its authored notes unchanged (the control)
- [ ] Entries are visually distinguishable from authored notes, at 375x667 and 1280x800
- [ ] If a shared type widens, `.claude/rules/79` is applied: every denylist over `authorKind`
      is audited for the new value
