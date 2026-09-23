# Fix stopping sleep repair starvation

## Problem

Production audit after PR #1981 showed completed-task workspaces still marked `running` with `session_snapshots.sleep_status = 'stopping'`. The normal sleep sweep can reclaim those rows after the shorter claim lease and refresh `sleep_claimed_at`, while stale repair waits for the longer in-flight age using that same moving timestamp. That can starve stale cleanup and keep nodes/workspace usage alive.

## Research findings

- `apps/api/src/services/session-snapshot-sleep-lifecycle.ts`
  - `beginSessionSnapshotStopping()` first moves a snapshot into `stopping`.
  - `claimSessionSnapshotSleep()` reclaims stale `stopping` rows and refreshes `sleep_claimed_at`.
  - `deferSessionSnapshotStopping()` also refreshes `sleep_claimed_at` and `updated_at`.
- `apps/api/src/scheduled/session-sleep-lifecycle-repair.ts`
  - Selects stale post-capture rows using `COALESCE(sleep_claimed_at, updated_at, created_at)`.
- `apps/api/src/services/session-snapshot-sleep-predicate.ts`
  - Shared restorable/in-flight predicate also uses refreshing timestamps, so terminal-node repair can skip rows forever.
- Fable approved the amended plan and rejected `updated_at` as a cutoff because it is also refreshed.

## Implementation checklist

- [x] Add additive D1 migration for stable `session_snapshots.sleep_stopping_since`.
- [x] Add Drizzle schema field.
- [x] Set `sleep_stopping_since` when first entering `stopping`.
- [x] Preserve existing `sleep_stopping_since` on `stopping` reclaim and self-heal null legacy rows.
- [x] Do not refresh `sleep_stopping_since` in defer paths.
- [x] Use `sleep_stopping_since` in stale repair and shared in-flight predicate, with safe fallback for legacy rows.
- [x] Add focused regression tests.
- [x] Clear `sleep_stopping_since` when sleep is cancelled, rescheduled, or recovered awake so future cycles cannot inherit stale state.

## Acceptance criteria

- A post-capture `stopping` snapshot whose `sleep_claimed_at` was recently refreshed is repaired once its original `sleep_stopping_since` exceeds `SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS`.
- A post-capture `stopping` snapshot newer than the in-flight age remains protected.
- Legacy `stopping` rows with null `sleep_stopping_since` are self-healed without resetting an existing value.
- Terminal-node repair no longer treats an old `stopping` row as protected solely because `sleep_claimed_at` was refreshed.
- Focused tests pass.
