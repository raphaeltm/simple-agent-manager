# Instant chat follow-up fails: "sleeping container runtime is gone and cannot wake in place"

## Problem

A follow-up message to an idle Instant (cf-container) chat failed to wake it. The chat showed
the system message "Wake failed: The sleeping container runtime is gone and cannot wake in place."
The user's message was not delivered and the chat stayed asleep.

## Context

- Found on staging 2026-11-05 at 19:32:47Z while verifying event-delivery steering
  (branch `sam/event-delivery-steers-by-default`, deploy run 42083339183, which is `main` plus
  API-only changes that do not touch Instant sleep/wake).
- Project `01KTKXZ4ZZAT6MJFXRW1ZTQ7RB` (hono), profile "Claude Code Chat" (cf-container).
  Session `bbbfa80d-198f-43af-8e7b-7f17e19334a4`, task `01M6PJ0YG0YYF4Q3YGBVCK6GNT`,
  workspace `01M6PJ0Z6NRW1FHRB1SS0WTTPP`.
- The chat finished its turn at 19:13Z, went to sleep after about 20 minutes idle, and the
  follow-up was sent from the composer at 19:32:46Z.

## Acceptance Criteria

- [ ] Find why the runtime was gone (container evicted, lease lost, or state mismatch) from the
      session's wake records and logs.
- [ ] A follow-up to an idle Instant chat whose container is gone starts a fresh runtime instead of
      failing, or tells the user what to do next.
- [ ] Regression test through the real wake entry point.

> **Resolved by** `tasks/archive/2026-11-08-instant-sleeping-workspace-deletion-and-wake.md` (branch `sam/stability-fix-instant-cf-ztxbsx`).
