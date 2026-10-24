# Idea timeline: the lifecycle entries that have no clock yet

## Problem

The idea page's Updates timeline shows two kinds of lifecycle entry — "Work started in
\<chat\>" and "Pull request #N merged" — because those are the only two the detail payload can
date from a real clock. Three more belong there and cannot be added honestly today:

| Entry | Why not yet |
| --- | --- |
| "Pull request #N opened" | `PullRequestState` carries `mergedAt` and `updatedAt`, but no opened-at. `updatedAt` is the last change of any kind, so an entry dated from it would move every time the PR is touched. GitHub's `created_at` is the clock; it needs storing on `pull_requests` by T2's refresh. |
| "Parked" | Unlike completion, parking leaves no column behind — `completed_at` is specific to being done. |
| "Reopened" | Same: nothing records when the reopen happened. |

**"Marked done" is NOT on this list any more.** It has a real clock, `tasks.completed_at`,
written by `applyIdeaStatusTransition` at the moment of the transition and cleared again on
reopen. The follow-up PR ships it. I had struck it on the belief that only `updatedAt` was
available; the coordinator pointed at the column.

## Why this is filed rather than approximated

A timeline is a claim about *when*. An entry dated from a clock that means something else is
worse than a missing entry, because a reader cannot tell it is wrong — this is the proxy-signal
trap in `.claude/rules/74`, and `lastActivityAt` vs `linkedAt` was the same decision made in the
other direction (`linkedAt` existed, so "work started" shipped).

## What it needs

- [ ] **Read `task_status_events` — the transitions are already recorded.**
      `applyIdeaStatusTransition` writes a row per transition
      (`id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at`) in the
      same batch as the status update, for EVERY transition including parked and reopened. So
      parked and reopened do not need new writes or a migration: they need a bounded read of
      that table for the idea and a field on the detail payload. Check this before adding
      columns — the data is there, nothing reads it for ideas today.
- [ ] For "pull request opened", store GitHub's `created_at` as `openedAt` on `pull_requests`
      via T2's refresh, and carry it on `PullRequestState`.
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
