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

- [x] Retain existing configurable full-snapshot budgets; exhausted fallback releases idle runtime without exact Git recovery.
- [x] Keep transcript, successful backups, honest durable degraded-recovery notice and fresh continuation.
- [x] Converge legacy preservation-blocked states via lifecycle controls.
- [x] Keep action-time idleness, wake/runtime guards, ownership and co-tenant isolation.
- [x] Retry failed stops/deletions and preserve warm-node retention.
- [x] Update absolute-lifetime behavior and stale docs/notices.
- [x] Regression tests cover complete task through failed snapshot/termination/deletion, retries, activity races, co-tenants and full snapshot recovery.
- [ ] Validate lint/typecheck/test/build and local specialist reviews.
- [ ] Coordinate staging, validate real lifecycle and remove paid fixtures.
- [ ] PR, CI, best-effort CodeRabbit, merge, production deploy/minimal smoke and incident status to parent.

## Acceptance

Runtime resources are actually removed after bounded snapshot failure, including no-Git cases. Conversations and existing backups are retained. No exact restore promise without verified recovery. Wakes and active work prevent stale teardown; unrelated tenants and intentional warm nodes survive. Lifecycle retries converge across restarts. Staging evidence and production smoke accompany release.

## References

Task 01M5B6WMMD6RV7Z737XSZCSBN9; parent 01M5B3SYXRWTC4HB7KQDT8DRX9. Rules 14, 25, 32, 53, 58, 61; existing bounded fallback integration fixture.

## Durable progress (2026-10-19 23:29 UTC)

Implementation now releases idle compute without exact Git recovery, retains artifacts, normalizes transcript-only sleep metadata, returns unavailable restore instead of claiming exact restore, and starts Instant continuation fresh with saved contract and scoped MCP. Legacy preservation blocks rearm through normal ownership/idleness/claim gates. External stop failures keep retrying. Runtime-changed intents remain fenced and reconcile notices separately. Absolute-lifetime continues requesting guarded cleanup.

Focused regression: 8 files /247 tests PASS (bounded fallback vertical slice, lifecycle, sleep service, episode, sleep sweep, absolute-lifetime, Instant recovery state machine and SQLite helper). Full repository checks previously interrupted by workspace replacement; rerun bounded/sequentially before release. Local review found Instant point/start-race/expiry guards and old stopping missing metadata; addressed, final review pending. Documentation/configuration review in progress.

No PR or staging deployment yet. Shared-sessions task01M59TN50JX53TPVXV0VTAN5JV reserves staging until~23:50UTC; await release. Production23:16Z motivating node/workspace absent D1 before implementation, agent completed23:02; parent asked for provider removal evidence. Chat4caf0202-5601-4db6-9767-30cfd33864b4; new runtime01M5B7SHQRT9Q03X7PNV70NTM9. No production mutation performed. `.do-state.md` and /tmp logs lost on workspace replacement; this task progress supplements local state.

23:34 additional acceptance evidence: bounded integration now63/63 PASS, including real guarded ProjectData stopped-chat transition (conversation stays stopped while no-Git legacy runtime cleans up) and provider-node cleanup retry composition. Discrimination against main: new no-Git test fails as expected because old implementation produces terminal_failed rather than sleeping. Root lint13/13 and typecheck19/19 PASS; root tests still running. Specialist Cloudflare/security and docs/env/constitution PASS; final test-completion followup pending after stopped-chat test.

23:39 selector refinement: historical blocked snapshots with no matching current workspace are excluded before the bounded page. Two regressions cover removed/replaced runtimes; bounded suite65/65 PASS. Lifecycle specialist re-reviewed this refinement PASS. Test-completion reviewer PASS after stopped-chat regression. Root build9/9 PASS, lint13/13 PASS, typecheck19/19 PASS; full root tests and format debt check ongoing. Candidate batch remains configurable10, wall budget20s; newly admitted legacy blocks add one guarded D1 rearm and use the existing bounded background lifecycle I/O, never a full-node destruction shortcut.

23:41 action-boundary regression PASS: work beginning while the degraded notice is persisted prevents the external stop; the durable stopping claim later converges without another snapshot when work ends. Full bounded file now66 scenarios (65 earlier pass + focused new case pass); final full API run will exercise together. No source change for this test. All specialist reviews complete PASS; release gates still pending.

### Final ownership review refinement

- Legacy failed/no-deadline rows and rearmable historical preservation blocks remain owned by the guarded sleep path, rather than being released to older orphan/failed-task cleanup first. Existing finite in-flight age bound remains.
- Shared SQL/JS classification validates fallback metadata consistently; rearm retains recorded failure counts.
- Regression validation: predicate and bounded-fallback integration suites 144/144 passed. API typecheck passed; independent lifecycle/security reviewer PASS after malformed-record parity fixes.
