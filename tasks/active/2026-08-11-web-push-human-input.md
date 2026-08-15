# Web Push for Human-Input Requests and Delivery-Aware Expiry

**Date:** 2026-08-11  
**SAM task:** `01KZQY9A5YHMF01M7M04J2R15R`  
**Source idea/spec:** `01KZQ24K3MQM3SV63BWTSV3DDH`  
**Branch:** `sam/build-out-band-web-j2r15r`

## Problem

When an agent calls `request_human_input`, SAM currently writes an in-app notification
and broadcasts it only to open WebSockets. If no tab is connected, the user receives
nothing out of band. Two hours later, ProjectData treats the unanswered human-input
attention marker as expired, fails the task, and stops the workspace—even though SAM
never established that any channel delivered the request.

The same attention expiry function also processes `reconciliation_checkin`. That branch
is an intentional agent-liveness correctness boundary and must retain its current
immediate failure/cleanup behavior exactly.

## Verified Root Cause

- `NotificationService.createNotification()` persists and broadcasts through
  `ctx.getWebSockets()` only. There is no Web Push delivery path.
- `processExpiredAttentionMarkers()` routes both `needs_input` and
  `reconciliation_checkin` to `failTaskAndWorkspace()` without discriminating their
  different safety contracts.
- `request_human_input` skips the durable attention marker when it cannot resolve a chat
  session, swallows both notification and marker failures, and still returns success.
- Any user-role message implicitly resolves every active marker, so the selected answer
  is neither correlated nor recorded.
- Agent- and user-facing documentation makes two false promises: out-of-band push already
  exists, and the MCP tool blocks until answered.

## Non-Negotiable Product Decisions

- Use one Declarative Web Push payload (`web_push: 8030`) with an absolute
  `https://app.${BASE_DOMAIN}/...` `navigate` URL. Safari can display it declaratively;
  Chrome and Firefox use the same bytes in the service-worker handler.
- Push subscriptions belong to the per-user Notification Durable Object, keyed by
  `endpoint`, with `user_agent` retained for future device management.
- Push fires only on the normal notification insert path. Progress batching,
  `needs_input` dedup updates, and `task_complete` dedup stubs do not push.
- Push is eligible for medium/high urgency when the `web_push` preference is enabled.
- A live WebSocket never suppresses push. The push path must not call
  `ctx.getWebSockets()` and must not add focus/visibility heuristics or a suppression
  configuration switch.
- No per-device preference, switch, management API, or UI is in scope.
- Push network delivery must run under `ctx.waitUntil()` and never extend the synchronous
  Notification DO mutation path.
- Reconciliation expiry is unchanged. Delivery-aware escalation/grace applies only to
  `needs_input`.
- Staging deployment and verification are explicitly forbidden for this task. Local,
  CI, worker-pool, protocol-vector, built-preview, and screenshot evidence replace it.
- Once the PR is green, merge to `main`, then monitor Deploy Production by merge head SHA
  until the run with `conclusion == success` completes; skipped sibling runs are expected.

## Implementation Checklist

### Phase 0 — Truth and in-app latency

- [x] Remove the false push promise from MCP onboarding instructions.
- [x] Correct the notification guide: `request_human_input` is non-blocking.
- [x] Forward `attention.created` and `attention.resolved` through
      `SESSION_DELTA_EVENTS` and update the session reducer immediately.
- [x] Correct stale settings-notification switch-count assertions.

### Phase 1 — Delivery-aware human-input lifecycle

- [x] Add configurable escalation fractions, undelivered grace, and hard maximum age,
      with `DEFAULT_*` constants and documented env overrides.
- [x] Persist the lifecycle fields required for escalation, delivery confirmation,
      bounded extension, and a correlated recorded answer in an append-only ProjectData
      migration.
- [x] Re-notify `needs_input` at configured fractions without blocking the alarm's
      critical path on external network I/O.
- [x] At the original deadline, fail/stop only if at least one delivery was confirmed;
      otherwise extend the request within the configured hard maximum.
- [x] At the hard maximum, terminalize the wait so no alarm state can live forever.
- [x] Close the missing-chat-session silent-success gap in `request_human_input`.
- [x] Preserve `reconciliation_checkin` failure, workspace stop, session cleanup, and
      task-run cleanup byte-for-byte in behavior.
- [x] Add discriminating tests for escalation, unconfirmed grace, confirmed expiry,
      hard-max termination, two alarm ticks, and unchanged reconciliation behavior.
- [x] Document alarm load: one bounded SQLite page per tick, local DO RPC for receipt
      lookup/resend scheduling, and no awaited push endpoint fetch in ProjectData.

### Phase 2 — Pure Web Push protocol

- [x] Add `apps/api/src/lib/web-push.ts` with native WebCrypto ECDH P-256, HKDF,
      AES-128-GCM `aes128gcm` content encoding, and ES256 VAPID JWT generation.
- [x] Validate subscription keys, endpoints, payload sizes, VAPID material, TTLs, and
      retry-related configuration at their boundaries.
- [x] Prove encryption with the published RFC 8291 known-answer vector.
- [x] Unit-test VAPID audience, expiry, subject, and Authorization header behavior.

### Phase 3 — Subscription storage, delivery, routes, and secrets

- [x] Append Notification DO migration `004-push-subscriptions`, keyed by endpoint with
      a user index, `user_agent`, failure/disable state, and delivery receipt state.
- [x] Add valibot row parsers with snake-to-camel/epoch conversion and good/bad/good
      list-row isolation coverage.
- [x] Add authenticated/approved add, remove, and list subscription RPC/routes; declare
      `/push/*` routes above dynamic `/:id/*` routes.
- [x] Widen notification channels to `web_push` and parameterize
      `isNotificationEnabled()` while preserving existing in-app defaults.
- [x] Add asynchronous push fan-out for the normal insert path only; pin all three
      early-return suppression decisions independently.
- [x] Always push when enabled regardless of WebSocket state.
- [x] On success, record confirmed delivery; on 404/410, delete the endpoint; on 429,
      honor bounded `Retry-After`; otherwise increment failures and disable at the
      configured threshold.
- [x] Build absolute action URLs through a shared `getAppOrigin(env)` helper.
- [x] Add public runtime `GET /api/config/vapid-public-key`; do not use `VITE_*`.
- [x] Add protected Pulumi P-256 VAPID key generation and secret outputs.
- [x] Add importable/unit-tested PEM-to-base64url VAPID derivation with explicit
      GitHub override → Pulumi → fail-closed secret resolution.
- [x] Configure `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, and `VAPID_SUBJECT` as Worker
      secrets; keep Wrangler inventory and deploy-quality tests synchronized.
- [x] Add local key generation parity and environment/configuration documentation.
- [x] Add worker-pool coverage proving migration 004, real row parsers, persistence, and
      endpoint dedup execute under workerd/SQLite.
- [x] Add a vertical-slice test from `request_human_input` through notification creation,
      RFC encryption, and a mocked endpoint receiving ciphertext plus VAPID headers.

### Phase 4 — Service worker, subscription hook, settings, and install UX

- [x] Bump service-worker shell/runtime cache names to `-v3`.
- [x] Add import-free `push`, `notificationclick`, and `pushsubscriptionchange`
      handlers compatible with the esbuild-transform-only and second-typecheck pipeline.
- [x] Parse the Declarative Web Push payload, show notifications on legacy engines, and
      focus a matching client before opening an absolute deep link.
- [x] Add dependency-injectable push subscription helpers/hook; permission is requested
      only from an explicit user gesture, never on app-shell/page load.
- [x] Add API client methods for runtime VAPID config and subscription lifecycle.
- [x] Migrate `SettingsNotifications.tsx` to TanStack Query/Mutation without unmounting
      cached content during background refetch.
- [x] Add a sibling Web Push settings card with binary on/off behavior and an accessible
      denied-permission alert; no per-device controls.
- [x] Add contextual, dismissible, per-user permission guidance using the shared Alert.
- [x] Add an independent PWA install prompt gated by `!useIsStandalone()`.
- [x] Add behavioral unit tests for every new interaction and state transition.
- [x] Audit at iPhone SE 375x667 and desktop 1280x800 with screenshots, focus/keyboard
      checks, and the mandatory overflow assertion.
- [x] Build and serve the production web bundle on localhost:4173 to exercise the real
      service-worker registration/subscription/click path as far as the local browser
      environment permits.

### Phase 5 — Structured answers

- [x] Include marker identity and options in the attention summary contract.
- [x] Render answer buttons in chat/attention UI with mobile-safe layout.
- [x] Add a project/session/marker-scoped resolve endpoint that validates and records the
      chosen option or free-form answer.
- [x] Add parallel structured `needs_input` resolution while preserving the existing
      blanket resolution path for ordinary user messages and reconciliation semantics.
- [x] Add Declarative Web Push notification actions only as progressive enhancement;
      the in-app answer surface remains authoritative because iOS ignores custom actions.
- [x] Add authorization, invalid-option, wrong-session/project/marker, replay/idempotency,
      free-form, and persistence tests across the real route/DO boundary.

### Documentation, process, and delivery

- [x] Delete the superseded 2026-03 Web Push backlog task.
- [x] Update notification, agent, self-hosting, API, architecture, runtime configuration,
      env-reference, and generated-secret documentation to match the shipped behavior.
- [x] Add a durable process rule: a destructive timeout predicated on human response
      requires confirmed delivery or bounded grace, while machine-liveness watchdogs
      remain separately classified and explicitly tested.
- [x] Complete the post-mortem below and mirror it in the PR description.
- [x] Run focused tests, affected-package gates, repository-wide lint/typecheck/test/build,
      migration/runtime/DO-wall-time/Wrangler quality gates, and specialist review.
- [x] State in the PR that staging was intentionally skipped by explicit instruction and
      that first production execution of the Pulumi/derivation path is the residual risk.
- [ ] Open PR, monitor CI, fix all failures, merge only when green, monitor the successful
      production deploy run by merge head SHA, and update source idea with PR/merge/deploy
      evidence.

## Acceptance Criteria

- A user with Web Push enabled receives `needs_input` pushes on every registered device,
  even while any SAM WebSocket is connected.
- Push off means no push. There is no device-specific preference surface.
- Chrome/Firefox service-worker handling and Safari Declarative Web Push consume one
  payload whose required click target is absolute.
- All three notification early-return branches are proven not to push.
- Human-input waits escalate, are not destructively expired at T without confirmed
  delivery, and still terminate at a bounded hard maximum.
- `reconciliation_checkin` expiration remains behaviorally identical to `main`.
- A missing chat session can no longer silently produce a successful, unprotected
  human-input request.
- Structured answers are correlated to one marker, validated, and durably recorded.
- Migration 004 and real row parsing execute in worker-pool tests; RFC 8291 matches the
  published vector; 410 and 429 paths are covered.
- The settings surface remains mounted during refetch and passes mobile/desktop visual,
  keyboard, and overflow checks.
- No staging resource, deployment, workflow dispatch, node, or workspace is created.
- Green CI is merged and the successful production deploy for the merge SHA completes.

## Post-Mortem

### What broke

SAM told agents that a human would receive a push when `request_human_input` was called,
but only an in-app row/WebSocket broadcast existed. A user away from every open tab was
not notified. After two hours the control plane failed the task and stopped its workspace
because the unanswered marker expired.

### Root cause

Commit `add627296` (merged within PR #1008 as `1704a4b2e`) introduced the destructive
human-input deadline without a delivery contract. Notification persistence and WebSocket
broadcast were treated as equivalent to human delivery, even though an empty WebSocket
set is a normal condition. The same merge later added `reconciliation_checkin` to the
shared expiry handler, collapsing two different marker classes—human response and machine
liveness—into one terminal path. The original `request_human_input` integration also
swallowed missing-session/marker failures, allowing success without the safety artifact.

### Timeline

- 2026-03-08: a Web Push backlog proposed an architecture that later became stale.
- 2026-05-14: PR #1008 (`1704a4b2e`, including feature commit `add627296`) shipped
  durable human-input expiry and reconciliation attention markers; the former gained a
  two-hour destructive deadline without out-of-band delivery.
- 2026-08-10/11: user feedback exposed the missing notification; read-only investigation
  traced the complete delivery and expiry paths and produced idea
  `01KZQ24K3MQM3SV63BWTSV3DDH`.
- 2026-08-11: this implementation began from the research-backed plan.

### Why it was not caught

Existing tests covered notification persistence/broadcast and expiry mutation separately.
They did not cross the `request_human_input` → Notification DO → external delivery →
ProjectData expiry boundary, did not discriminate human waits from reconciliation
watchdogs, and encoded the original destructive behavior as expected output. Agent-facing
documentation was not verified against an actual delivery capability.

### Class of bug

A cross-control-plane lifecycle-authority bug: a destructive human-response timeout used
the existence of an internal artifact as a proxy for confirmed external delivery. A
second class is aspirational documentation presented as an implemented guarantee.

### Process fix

Extend the control-loop review contract so human-response deadlines cannot trigger
destructive action without confirmed delivery or a bounded escalation/grace policy, and
require a discriminating control test whenever one expiry loop handles both human and
machine-liveness marker classes.

## Verification Evidence

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1807
- RFC 8291 published known-answer vector passes in unit and workerd environments.
- Focused API, web, deploy-script, infrastructure, and worker-pool suites pass, including
  the real `request_human_input` → Notification DO → encrypted endpoint vertical slice,
  two-device fan-out, push-off control, endpoint refresh/dedup, and the authenticated
  structured-answer HTTP route through the real ProjectData DO.
- Production web build and service-worker second typecheck pass.
- Playwright built-preview audit passes at iPhone SE 375x667 and desktop 1280x800 with
  keyboard, 44x44 touch-target, and horizontal-overflow assertions (24 tests).
- A headed Chromium run against the production preview granted notification permission,
  loaded the built `/sw.js`, delivered a browser-level push through the DevTools push
  transport, observed the real notification via `registration.getNotifications()`, and
  exercised `notificationclick` through to `/try?from=web-push` (1 test). A direct
  `PushManager.subscribe()` attempt was also made, but the test Chromium binary's push
  service rejected registration with `AbortError: Registration failed - permission denied`;
  no external push endpoint was available in this environment.
- UI/UX, security, and Cloudflare/environment/constitution/documentation specialist
  reviews all pass after their requested hardening changes; the focused review suites
  cover 76, 60, and 36 tests respectively.
- Mandatory task-completion validation passes after exercising endpoint conflict refresh,
  multi-device fan-out, global push-off, the authenticated structured-answer route through
  real Durable Objects/SQLite, and the built service-worker push/click runtime.
- Local migration, Wrangler, file-size, runtime-boundary, secret-scan, and quality suites
  pass. The DO wall-time command requires CI-only `DO_*`, Cloudflare account, and token
  inputs, so its GitHub check is the authoritative execution for this branch.
- Staging was not deployed, dispatched, or otherwise mutated, by explicit user instruction.
