# Idea timeline: the lifecycle entries that have no clock yet

## Problem

The idea page's Updates timeline shows two kinds of lifecycle entry — "Work started in
\<chat\>" and "Pull request #N merged" — because those are the only two the detail payload can
date from a real clock. Three more belong there and cannot be added honestly today:

| Entry | Why not yet |
| --- | --- |
| "Pull request #N opened" | `PullRequestState` carries `mergedAt` and `updatedAt`, but no opened-at. `updatedAt` is the last change of any kind, so an entry dated from it would move every time the PR is touched. |
| "Marked done" / "Parked" | The only candidate is the idea's `updatedAt`, a last-change clock. Editing the plan after parking would redate the parking. |
| "Reopened" | Same clock, same problem, and a reopen is followed by exactly the edits that would move it. |

## Why this is filed rather than approximated

A timeline is a claim about *when*. An entry dated from a clock that means something else is
worse than a missing entry, because a reader cannot tell it is wrong — this is the proxy-signal
trap in `.claude/rules/74`, and `lastActivityAt` vs `linkedAt` was the same decision made in the
other direction (`linkedAt` existed, so "work started" shipped).

## What it needs

- [ ] Decide where transition times live. Options: GitHub's `created_at` for the PR (one more
      field on `PullRequestState`, populated by T2's refresh); and for the idea transitions
      either a dedicated column written by `setProjectIdeaStatus`, or deriving from whatever
      `activity_events` already retains — check that first, it may be free.
- [ ] Each new entry is derived only from a clock that means the transition, and the comment at
      the derivation says which clock and why.
- [ ] Tests follow `apps/web/tests/unit/pages/idea-page.test.tsx`'s existing pair: one that the
      entry renders in the right order, one control proving a near-miss (an open PR, a chat that
      only read the idea) produces nothing.
- [ ] `apps/web/src/pages/ideas/idea-timeline.ts`'s "deliberately NOT derived" list shrinks by
      exactly what ships.

## Context

Raised by `task-completion-validator` after T8 PR2 (#2439) merged: the checklist ticked
"derived lifecycle entries" and none existed. The follow-up PR shipped the two that could be
dated honestly and struck the rest here, rather than leaving a ticked box with no code.
