# Decide what a failed chat whose agent finished should offer

## Problem

`deriveSessionState` (`apps/web/src/components/project-message-view/types.ts`) maps a chat
session with status `failed` and `agentCompletedAt` set to `idle`. That makes the composer
offer resume-and-send, and `wakeSession` in the ProjectData DO revives `failed` to `active`.

A failed chat whose agent never finished derives as `terminated` instead. Which of the two a
failed chat gets depends on when it failed, not on what the user should be able to do.

## Context

- Found by the 2026-11-10 state-machine audit (`03-sessions.md`, `06-web-client.md`).
- Deliberately not changed in `sam/state-machine-defect-fixes`, because changing it would remove
  a path users may rely on.
- This is a product decision for Raphaël.

## Acceptance criteria

- [ ] Raphaël decides whether a failed chat can be continued in place, forked, or only read.
- [ ] `deriveSessionState` and `wakeSession` agree with that decision for both shapes of failed chat (with and without `agentCompletedAt`).
- [ ] Behavioural tests cover both shapes through `useSessionLifecycle`.
