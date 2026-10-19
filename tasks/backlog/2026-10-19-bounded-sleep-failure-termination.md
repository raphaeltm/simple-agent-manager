# Bounded sleep-failure runtime termination

## Problem
Failed final snapshots currently leave idle workspaces billed indefinitely when exact Git recovery cannot be verified. Raphaël explicitly superseded preservation-blocked behavior: after bounded retries terminate runtime, retain chat and backups, disclose possible loss, and continue fresh from transcript.

## Research
- `session-sleep-episode.ts`: three failures or 15 minutes before fallback; absolute ceiling nine.
- `session-sleep-fallback.ts`: existing idleness, claim, runtime identity and ProjectData guards; currently blocks missing Git objects.
- `session-sleep-teardown.ts`: shared idempotent stop, workspace deletion and warm-node handoff.
- `session-sleep-candidates.ts`: old terminal_failed rows are excluded except stop reconciliation.
- `absolute-lifetime-preservation.ts`: separately stops requesting sleep after preservation hold, leaving compute live.
- Restore/finalization gates assume complete or degraded snapshots. Transcript-only fallback must remain wakeable without claiming exact restore.
- Fresh production read 23:16Z: motivating workspace/node already absent from D1; agent completed 23:02Z. Partial snapshot remains. Parent asked for preceding cleanup evidence; no incident mutation performed here.

## Implementation checklist
- [ ] Retain existing configurable full-snapshot budgets; exhausted fallback releases idle runtime without exact Git recovery.
- [ ] Keep transcript, successful backups, honest durable degraded-recovery notice and fresh continuation.
- [ ] Converge legacy preservation-blocked states via lifecycle controls.
- [ ] Keep action-time idleness, wake/runtime guards, ownership and co-tenant isolation.
- [ ] Retry failed stops/deletions and preserve warm-node retention.
- [ ] Update absolute-lifetime behavior and stale docs/notices.
- [ ] Regression tests cover complete task through failed snapshot/termination/deletion, retries, activity races, co-tenants and full snapshot recovery.
- [ ] Validate lint/typecheck/test/build and local specialist reviews.
- [ ] Coordinate staging, validate real lifecycle and remove paid fixtures.
- [ ] PR, CI, best-effort CodeRabbit, merge, production deploy/minimal smoke and incident status to parent.

## Acceptance
Runtime resources are actually removed after bounded snapshot failure, including no-Git cases. Conversations and existing backups are retained. No exact restore promise without verified recovery. Wakes and active work prevent stale teardown; unrelated tenants and intentional warm nodes survive. Lifecycle retries converge across restarts. Staging evidence and production smoke accompany release.

## References
Task 01M5B6WMMD6RV7Z737XSZCSBN9; parent 01M5B3SYXRWTC4HB7KQDT8DRX9. Rules 14, 25, 32, 53, 58, 61; existing bounded fallback integration fixture.
