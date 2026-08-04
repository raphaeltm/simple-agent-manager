# Instant chat start renders as "Provisioning VM (1/4)"

## Problem

`POST /api/projects/:projectId/sessions/start` writes `executionStep: 'instant_persistence'`
(`apps/api/src/routes/chat-start.ts:185`), introduced when Instant starts became
accept-then-continue in PR #1722.

That value is not in `TASK_EXECUTION_STEPS` or `EXECUTION_STEP_LABELS`
(`packages/shared/src/types/task.ts`). Consequences in the web UI:

- `ProvisioningIndicator.getStageIndex()` does `Math.max(findIndex(...), 0)`, so an
  unknown step clamps to index `0` and the user sees **"Provisioning VM (1/4)"** —
  for a session that provisions no VM at all.
- `SessionHeaderFormatters.formatExecutionStep()` would render the raw
  `"instant persistence"`.
- `ActiveTaskCard.getStepLabel()` returns `undefined`.

An Instant session is the default experience for any user without a cloud
credential, so this is the first thing many users see.

## Context

Found on 2026-08-04 during a docs-coverage audit for the past week's changes. Not
user-reported. `guides/instant-sessions.md` documents the durable-start behavior
but deliberately says nothing about the indicator, because what it currently shows
is wrong.

`INSTANT_START_STALE_TIMEOUT_MS` already documents the step name for operators
(`reference/configuration.md`), so the identifier is public but mis-rendered.

## Acceptance Criteria

- [ ] `instant_persistence` has an entry in `EXECUTION_STEP_LABELS` with accurate
      user-facing wording (it is persistence + container launch, not VM provisioning)
- [ ] `ProvisioningIndicator` shows an Instant-appropriate stage list, or suppresses
      the VM stage count for `cf-container` runtime — an unknown step must not
      silently clamp to stage 1
- [ ] Audit `getStageIndex`'s `Math.max(..., 0)` fallback: an unrecognized step
      should be visibly unknown, not confidently wrong
- [ ] Behavioral test asserting an `instant_persistence` task does not render
      "Provisioning VM" (must fail on current code)
- [ ] Playwright visual check of an Instant session mid-launch at mobile + desktop
- [ ] Once fixed, `guides/instant-sessions.md` "Starting a chat is durable" can say
      what the indicator shows
