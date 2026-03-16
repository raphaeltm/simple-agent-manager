# Notification System Phase 1 — Deferred Review Findings

**Created**: 2026-03-16
**Source**: Review agents from PR #417 (Phase 1 notification system implementation)
**Priority**: Low-Medium — none of these are functional blockers

## Context

During Phase 1 implementation of the cross-project notification system (PR #417), four review agents identified findings. All CRITICAL and functional HIGH findings were fixed in-PR. The items below were deferred as non-blocking improvements that either match existing app patterns or are polish items.

## Deferred Items

### Security (from security-auditor)

- [ ] **Rate limiting on notification routes** — No per-route rate limiting on notification API endpoints. Matches existing app pattern (no other routes have per-route rate limiting either). Should be addressed app-wide.
- [ ] **Input size validation on notification fields** — `title`, `body`, and `metadata` fields have no max-length enforcement at the API layer. Add reasonable limits (e.g., title: 200 chars, body: 2000 chars, metadata: 10KB).
- [ ] **WebSocket identity tagging** — The WebSocket connection in the Notification DO doesn't tag connections with userId, relying on DO-per-user isolation. Consider adding explicit tagging for defense-in-depth.

### Testing (from task-completion-validator & cloudflare-specialist)

- [ ] **Miniflare worker integration test for Notification DO** — Current tests are unit-level with MockSqlStorage. Add a Miniflare-based test that exercises the DO through HTTP/WebSocket (would have caught the COALESCE bug pre-staging).
- [ ] **UI behavioral tests for NotificationCenter** — Add render + interaction tests for the bell icon, panel open/close, mark-read, dismiss, and keyboard navigation.
- [ ] **WebSocket reconnection test** — Verify the `useNotifications` hook reconnects after connection drop.

### UI/UX (from ui-ux-specialist)

- [ ] **Focus trap in notification panel** — When the panel opens, focus should be trapped within it for keyboard users. Currently focus can escape to background elements.
- [ ] **`aria-live` region for unread count** — Screen readers should announce unread count changes. Add an `aria-live="polite"` region.
- [ ] **"By Type" filter tab** — The panel has All/Unread tabs. A "By Type" grouping or filter would help users with many notifications.
- [ ] **Shared hooks migration** — `useNotifications` hook could move to a shared hooks package if other apps need notification access.

### Backend (from cloudflare-specialist)

- [ ] **Notification TTL / auto-cleanup** — Old notifications accumulate indefinitely in the DO SQLite. Add a configurable TTL (e.g., 90 days) with periodic cleanup via DO alarm.
- [ ] **Batch dismiss endpoint** — Currently only single-notification dismiss is supported. Add a batch dismiss for clearing multiple notifications at once.

## Acceptance Criteria

- [ ] Each item above is either implemented or explicitly re-deferred with justification
- [ ] Any security items are prioritized before UI polish items
