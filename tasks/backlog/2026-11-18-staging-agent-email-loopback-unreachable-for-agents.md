# Staging: agents cannot run the inbound agent-email loopback

## Problem

No agent can verify the Cloudflare inbound agent-email path end to end on staging. The admin
loopback (`POST /api/admin/agent-email/loopback`) sends through Email Sending and expects
Email Routing to deliver back to the Worker's `email()` handler. It only proves something
when the recipient is the address of an email trigger. Agents cannot get one:

1. Primary staging (`sammy.party`) has no email trigger.
2. Trigger creation refuses agent sign-in sessions (workload identity) by design.
3. The stored staging smoke token (`SAM_PLAYWRIGHT_PRIMARY_USER`) returns
   `"Invalid token format"` from `/api/auth/token-login`, so an agent cannot act as the
   smoke user instead.

## Context

Found while landing L21 (PR #2887, task
`tasks/archive/2026-11-18-l21-smtp-sign-in-selfhost-inbound-email.md`). The coordinator
(task 01M7JMXS2JRW6QQMB1356ENPM3) accepted the gap for that PR. The Cloudflare `email()`
handler passes Cloudflare's message object, which never has `authenticatedFrom`, so the
L21 sender-binding check does not apply there. The self-host path was proven with real
mail on the test box. Any later change to Email Routing or the inbound handler will hit the
same gap.

## Acceptance Criteria

- [ ] The staging smoke token signs in again (rotate it, or fix the format it is stored in);
      verify a 200 from `https://api.sammy.party/api/auth/token-login`
- [ ] Primary staging has one persistent email trigger owned by the smoke user, and its
      allowed sender covers the loopback sender (`agent+loopback@agents.sammy.party`), created
      by a human, or by the smoke user once its token works
- [ ] The staging-verification reference documents how an agent runs the inbound loopback
      against that trigger, and how to clean up the task it creates
- [ ] One agent run of the loopback on staging shows the inbound message accepted and the
      task created, then cleaned up
