# Remediate CTO spot-check findings — notification preferences slice

**Date:** 2026-06-15
**Branch:** sam/remediate-notification-prefs-cto

## Problem

A CTO spot-check of the notification-preferences slice found a **leaky cross-boundary
sentinel**: the NotificationService Durable Object stores "global / no project"
preferences as `project_id = ''` (SQLite UNIQUE does not treat NULL as equal), but the
API types and UI use `projectId: null`. The conversion between the two was implicit and
duplicated (`projectId || ''` in the DO, `!projectId` truthiness in the UI), so it was
possible for the API surface to leak the empty-string sentinel and for the UI to mishandle
a null projectId.

Adjacent findings:
- Route validation for `GET /api/notifications` accepted malformed `cursor` values and
  passed them to the DO instead of rejecting with 400.
- The valibot schemas in `apps/api/src/schemas/notifications.ts` duplicated the
  notification-type/channel literals instead of deriving them from shared constants.
- `SettingsNotifications.tsx` used optimistic state that "lied" after a save failure and
  did not surface load/save failures accessibly.

## Acceptance Criteria

- [x] No API response exposes `projectId: ''`; global prefs are explicitly `projectId: null`
      after round trips.
- [x] Storage sentinel conversion is centralized in the DO row/schema layer and tested;
      no `projectId || ''` or UI `!projectId` remains in the preference path.
- [x] Invalid `cursor` values return 400 before the request reaches the DO.
- [x] Settings Notifications surfaces load/save failures accessibly and keeps the switch
      state consistent (no optimistic lie after a rejected save).
- [x] Focused tests pass plus `/do` workflow requirements followed.

## Implementation Checklist

- [x] **Item 1** — Explicit sentinel helpers in `notification-row-schemas.ts`
      (`toStoredPreferenceProjectId`, `fromStoredPreferenceProjectId`,
      `STORED_PREFERENCE_GLOBAL_SENTINEL`); `project_id` schema is `v.string()`.
- [x] **Item 2** — Use helpers in `updatePreference()`, `isNotificationEnabled()`, and
      `parseNotificationPreferenceRow()`; remove generic truthiness for project scope.
- [x] **Item 3** — Route validation: invalid `cursor` (non-integer / non-positive) →
      400 before DO; keep positive-integer `limit` + max clamp behavior.
- [x] **Item 4** — Derive `apps/api/src/schemas/notifications.ts` schemas from
      `NOTIFICATION_TYPES` / `NOTIFICATION_CHANNELS` shared constants.
- [x] **Item 5** — `SettingsNotifications.tsx`: accessible load/save error/status, commit
      local state only after server confirms, accessible switch. No marketing copy.
- [x] **Item 6** — Tests:
  - [x] DO round-trip (`''` → `null`), suppression (global type / wildcard / project
        override) — `apps/api/tests/unit/durable-objects/notification-preferences.test.ts` (13)
  - [x] Route 400s for invalid cursor/type/filter/limit —
        `apps/api/tests/unit/routes/notifications-validation.test.ts` (11)
  - [x] Web unit: loading/toggling/error/null handling —
        `apps/web/tests/unit/components/settings-notifications.test.tsx` (7)
  - [x] Playwright visual audit (mobile + desktop) —
        `apps/web/tests/playwright/settings-notifications-audit.spec.ts` (9)
- [x] **Item 7** — Focused checks + `/do` quality gates + specialist reviews
      (cloudflare-specialist, ui-ux-specialist, test-engineer, constitution-validator,
      task-completion-validator) before PR. All gates green; 5 reviews returned with no
      CRITICAL/HIGH. MEDIUM/LOW findings deferred as out-of-scope/non-blocking (see
      `.do-state.md` Phase 5 Decision Note).

## Notes

- DO storage uses `project_id = ''` sentinel for global; API/UI use `null`.
- Resolution order for `isNotificationEnabled`: project-specific > type-global >
  wildcard-global > default-enabled.
- Test coverage total for item 6: 40 tests (13 DO + 11 route + 7 web unit + 9 Playwright).
