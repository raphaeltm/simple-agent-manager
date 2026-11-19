# The composer offers "Steer the agent" while a wake is just starting

## Problem

When a sleeping chat is woken, the composer briefly reads "Steer the agent..." and shows a
stop button, although no agent is running yet. `SessionFooter.tsx` defines
`agentWorking = !lc.isWaking && (activity === 'prompting' || activity === 'responding')`.
Sending sets an optimistic `prompting` activity at once, but `isWaking` only becomes true
once the server snapshot or the socket reports `recoveryStatus: 'waking'`. In between, the
footer treats the wake as a running turn. The wake banner (`SessionStatusBanners.tsx`,
`showWake`) shows during the same window, so the screen says "waking" and "steer" at once.

The comment beside the placeholder already says a wake in flight must not be presented as
something else. A steer sent in this window has no running turn to join.

It is also visible before the wake has been claimed. "Waiting for the previous workspace to
finish shutting down..." comes from the pre-claim wait reason while `recoveryStatus` is
still null, so `isWaking` stays false.

## Context

Found during staging verification of PR #2627 (state-machine D8), 2026-11-11. It happened on
both wakes, including wake #1 in a freshly loaded tab, so it predates that PR. Screenshots:
`.tmp/staging/shots/d8-wake1-banner.png`, `d8-wake2-banner.png` (local, captured as soon as
the banner first appeared). It has not been verified whether it lasts past the first few
seconds of the wake.

## Acceptance Criteria

- [ ] From the Send click on a sleeping chat until the wake settles, the composer never shows
      the steer/queue placeholder or the stop button
- [ ] The pre-claim wait (`previous_workspace_cleanup`) counts as a wake for the composer
- [ ] A rendered test sends on a sleeping chat and asserts the composer before and after the
      first wake snapshot arrives
