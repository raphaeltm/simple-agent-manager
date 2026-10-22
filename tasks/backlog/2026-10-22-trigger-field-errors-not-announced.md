# Trigger form errors are not tied to their fields

## Problem

In the automation editor's "When" step, validation errors for GitHub and webhook triggers render as
a separate `<p role="alert">` next to the fields (`apps/web/src/pages/automation/editor/steps-start-when.tsx`).
The inputs in `GitHubTriggerFields` and `WebhookTriggerFields` carry no `aria-invalid` and no
`aria-describedby` pointing at the message. A screen-reader user who moves back to the field does
not hear what is wrong with it; they only hear the alert once, when it first appears.

## Context

Found by the independent UI review of the agent email prototype (branch
`sam/giving-agents-email-addresses-16vzhn`, 2026-10-22). The new email field already does this
properly: `EmailTriggerFields` takes an `error` prop, sets `aria-invalid`, and links the message and
the hint through `aria-describedby` (tested in
`apps/web/tests/unit/components/email-trigger-fields.test.tsx`). The GitHub and webhook fields
predate that change and were left as they were to keep the prototype's diff focused.

## Acceptance criteria

- [ ] `GitHubTriggerFields` and `WebhookTriggerFields` accept the step's error for their fields and
      render it themselves, with `aria-invalid` on the affected input and `aria-describedby`
      linking the message (and any hint text).
- [ ] The separate `<p role="alert">` siblings for those errors in `steps-start-when.tsx` are removed,
      so each message renders once.
- [ ] Component tests assert the accessible description while an error is shown and its absence
      after it is fixed, as the email field test does.
- [ ] Playwright audit of the editor's error states at 375 px and 1280 px still passes.
