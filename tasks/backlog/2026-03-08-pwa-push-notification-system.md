# PWA Push Notification System

**Created**: 2026-03-08
**Status**: Backlog

## Problem

SAM is a PWA with service worker support and standalone mode detection, but has zero push notification capability. Users have no way to receive alerts when they're not actively looking at the app — task completions, agent errors, chat messages, and workspace state changes all go unnoticed unless the browser tab is in focus. For a platform managing autonomous AI agents that run for minutes to hours, background notifications are essential.

## Current State (Research Findings)

### What exists

- **Service worker** (`apps/web/public/sw.js`): Network-first navigation, app shell caching, stale-while-revalidate for static assets. No `push` or `notificationclick` event listeners.
- **PWA manifest** (`apps/web/public/manifest.webmanifest`): Standalone display mode, icons, theme colors. No notification-related config needed here (manifest doesn't control push).
- **SW registration** (`apps/web/src/lib/pwa.ts`): `registerAppServiceWorker()` — simple registration, prod-only. No subscription management.
- **Standalone detection** (`apps/web/src/hooks/useIsStandalone.ts`): Detects `display-mode: standalone`.
- **In-app toast system** (`packages/ui/src/components/Toast.tsx`): Success/error/warning/info toasts, auto-dismiss, top-right fixed position. Client-side only.
- **Real-time WebSocket infrastructure**: ProjectData DO broadcasts `message.new`, `session.stopped`, `session.agent_completed`, `messages.batch`, etc. to connected clients.
- **Admin log streaming**: AdminLogs DO + Tail Worker for real-time log delivery via WebSocket.

### What's missing (gaps)

1. **No Web Push protocol implementation** — no VAPID keys, no RFC 8030 message encryption, no push endpoint calling
2. **No subscription management** — no D1 table, no API routes, no frontend UI for permission/subscription lifecycle
3. **No service worker push handlers** — no `push` event listener, no `notificationclick` routing
4. **No notification preference system** — no per-user, per-event-type toggle settings
5. **No online/offline deduplication** — no logic to suppress push when user has active WebSocket connection
6. **No notification delivery from DOs** — existing broadcast only reaches connected WebSocket clients

### Key architectural advantages

- D1 available for subscription storage
- KV available for ephemeral notification state (e.g., dedup windows)
- Durable Objects already broadcast events that should trigger notifications
- Cloudflare Workers have native `fetch()` and `crypto.subtle` — can implement Web Push protocol without external dependencies
- Service worker already registered and functional
- No new third-party services required (FCM/APNs endpoints are called directly via Web Push protocol)

## Implementation Plan

### Phase 1: VAPID Keys & Subscription Management

- [ ] Generate VAPID key pair (ECDSA P-256) and add as Worker secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`)
- [ ] Add D1 migration: `notification_subscriptions` table
  ```sql
  CREATE TABLE notification_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_success_at INTEGER,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, endpoint)
  );
  ```
- [ ] Add API routes:
  - `POST /api/notifications/subscribe` — store push subscription
  - `DELETE /api/notifications/subscribe` — remove subscription
  - `GET /api/notifications/status` — check if current user has active subscription(s)
- [ ] Add `Env` interface entries for VAPID secrets
- [ ] Add env vars to `.env.example`, deployment scripts, and `configure-secrets.sh`

### Phase 2: Web Push Protocol Implementation

- [ ] Implement Web Push message encryption in Workers (RFC 8030 + RFC 8291):
  - ECDH key agreement (P-256) using `crypto.subtle`
  - HKDF key derivation
  - AES-128-GCM content encryption
  - VAPID JWT signing for authorization header
- [ ] Create `services/push-notification.ts`:
  - `sendPushNotification(subscription, payload)` — encrypt + deliver
  - `sendToUser(userId, notification)` — fan out to all user subscriptions
  - Handle 410 Gone responses (expired subscriptions — auto-delete)
  - Handle 429 rate limiting (respect Retry-After)
  - Track delivery failures, increment `failure_count`, disable after threshold
- [ ] Add notification payload type:
  ```typescript
  interface PushPayload {
    title: string;
    body: string;
    icon?: string;
    badge?: string;
    tag?: string; // collapse key for grouping
    data?: {
      url: string; // deep link on click
      type: string; // event type for filtering
      projectId?: string;
      sessionId?: string;
    };
  }
  ```

### Phase 3: Service Worker Push Handlers

- [ ] Add `push` event listener to `sw.js`:
  - Parse notification payload
  - Call `self.registration.showNotification()` with title, body, icon, badge, tag
  - Use `tag` for notification collapsing (e.g., multiple messages from same session)
- [ ] Add `notificationclick` event handler:
  - Extract `data.url` from notification
  - Focus existing client window if open, or `clients.openWindow(url)` for deep link
  - Close the notification
- [ ] Add `notificationclose` event handler (optional — for analytics)
- [ ] Add `pushsubscriptionchange` event handler:
  - Re-subscribe and POST new subscription to API (handles browser subscription rotation)

### Phase 4: Frontend Permission & Subscription Flow

- [ ] Create `useNotifications()` hook:
  - Check `Notification.permission` state (default/granted/denied)
  - Request permission via `Notification.requestPermission()`
  - Subscribe via `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })`
  - POST subscription to API
  - Unsubscribe flow
  - Expose state: `{ permission, isSubscribed, subscribe, unsubscribe, isLoading }`
- [ ] Add notification settings UI in Settings page:
  - Enable/disable push notifications toggle
  - Permission state indicator (granted/denied/default)
  - Browser-denied help text ("Open browser settings to re-enable")
  - Per-event-type toggles (Phase 5)
- [ ] Add first-time notification prompt (non-modal, dismissable banner):
  - Show after first successful task completion or workspace creation
  - "Enable notifications to know when tasks complete" with Enable/Dismiss
  - Remember dismissal in localStorage, don't re-prompt
- [ ] Pass VAPID public key to frontend via `/api/notifications/vapid-public-key` endpoint or embed in HTML

### Phase 5: Notification Triggers & Preferences

- [ ] Add D1 migration: `notification_preferences` table
  ```sql
  CREATE TABLE notification_preferences (
    user_id TEXT NOT NULL REFERENCES users(id),
    event_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, event_type)
  );
  ```
- [ ] Define notification event types:
  - `task.completed` — task finished successfully
  - `task.failed` — task failed or errored
  - `agent.completed` — agent session completed
  - `agent.error` — agent session errored
  - `workspace.ready` — workspace provisioned and ready
  - `workspace.error` — workspace provisioning failed
- [ ] Add notification trigger hooks in existing code paths:
  - `ProjectData DO`: on `session.agent_completed` → trigger `agent.completed`
  - `TaskRunner DO`: on task state → completed/failed → trigger `task.completed`/`task.failed`
  - Workspace provisioning: on ready/error → trigger `workspace.ready`/`workspace.error`
- [ ] Implement online/offline deduplication:
  - If user has active WebSocket connection in ProjectData DO, suppress push for that project's events
  - Only send push when user has no connected clients (or all clients are for different projects)
  - Use `ctx.getWebSockets()` in DO to check active connections by user
- [ ] Add preference-checking middleware: before sending push, check `notification_preferences` table
- [ ] Add notification preferences UI: per-event-type toggles in Settings

### Phase 6: Testing & Polish

- [ ] Unit tests for Web Push encryption (verify against known test vectors from RFC)
- [ ] Unit tests for subscription CRUD API routes
- [ ] Integration test for notification trigger → push delivery flow (mock push endpoint)
- [ ] Test subscription cleanup on 410 Gone response
- [ ] Test notification click deep-linking in service worker
- [ ] Test permission denied state UI
- [ ] Test online/offline deduplication logic
- [ ] Manual staging test: subscribe → trigger event → receive notification → click → deep link

## Open Questions

1. **Rate limiting**: Should we limit notification frequency per user? (e.g., max 1 per event type per 5 minutes to prevent spam during rapid task execution)
2. **Notification history**: Should we store sent notifications in D1 for a "notification center" UI? Or is fire-and-forget sufficient for v1?
3. **Multi-device**: Users may have subscriptions from multiple devices. Fan-out to all, or only most recent? (Recommendation: fan-out to all active subscriptions)
4. **iOS PWA limitations**: iOS Safari supports Web Push as of iOS 16.4, but only for installed PWAs in standalone mode. Should we gate the notification prompt behind `useIsStandalone()`?
5. **Batching**: For rapid-fire events (e.g., 10 tasks completing in quick succession), should we batch into a single "5 tasks completed" notification?

## Acceptance Criteria

- [ ] Users can enable push notifications from Settings
- [ ] Users receive a browser notification when a task completes (app not in focus)
- [ ] Clicking a notification deep-links to the relevant project/session
- [ ] Notifications are suppressed when user has the relevant project open in an active tab
- [ ] Expired subscriptions are auto-cleaned on 410 response
- [ ] No notifications sent for event types the user has disabled
- [ ] Works in Chrome, Firefox, Edge, and Safari 16.4+ (PWA mode)
- [ ] VAPID keys managed as Worker secrets (not hardcoded)
- [ ] All timeouts, thresholds, and limits are configurable via env vars

## Key Files

| File | Role |
|------|------|
| `apps/web/public/sw.js` | Service worker — add push/notificationclick handlers |
| `apps/web/src/lib/pwa.ts` | SW registration — add subscription management |
| `apps/web/src/hooks/useIsStandalone.ts` | Standalone detection — gate iOS notification prompt |
| `apps/api/src/db/schema.ts` | D1 schema — add subscription + preference tables |
| `apps/api/src/routes/` | API routes — add notification endpoints |
| `apps/api/src/services/` | Services — add push-notification.ts |
| `apps/api/src/durable-objects/project-data.ts` | DO — add notification triggers to broadcasts |
| `apps/api/src/durable-objects/task-runner.ts` | DO — add notification triggers for task lifecycle |
| `packages/ui/src/components/Toast.tsx` | Existing toast — reference for in-app notification pattern |
| `packages/shared/src/types/` | Shared types — add notification types |

## References

- [Web Push Protocol (RFC 8030)](https://datatracker.ietf.org/doc/html/rfc8030)
- [Message Encryption for Web Push (RFC 8291)](https://datatracker.ietf.org/doc/html/rfc8291)
- [VAPID (RFC 8292)](https://datatracker.ietf.org/doc/html/rfc8292)
- [Push API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Notification API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)
- [Service Worker Push Event - MDN](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/push_event)
