# Connection banner announces "Connecting..." as an alert

## Problem

`ConnectionBanner` (`apps/web/src/components/project-message-view/MessageBanners.tsx`) always renders
its `StatusCapsule` with `role="alert"`. The routine `Connecting...` and `Reconnecting...` states, with
info and warning tone, are therefore announced assertively by screen readers. Any check that counts
`role="alert"` as an error also reports them as one.

## Context

Found 2026-11-14 during the PR #2717 staging proof. A check counting `role="alert"` elements in a fresh
Instant chat 3 seconds after start found one: the info `Connecting...` capsule. The chat was healthy and
the agent replied normally. Unrelated to PR #2717.

## Acceptance Criteria

- [ ] `Connecting...` and `Reconnecting...` use a polite live region (`role="status"`)
- [ ] `Disconnected` (the recoverable state, with Retry) keeps `role="alert"`
- [ ] A rendered test asserts the role for each of the three states
