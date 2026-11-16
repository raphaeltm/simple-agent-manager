# D2: Admin settings invalid stored row isolation

## Problem
One override that no longer meets its definition makes GET /api/admin/settings return 503 without a diagnostic. Deploys can narrow bounds and invalidate old rows.

## Research and plan
- `admin-settings-resolution.ts:overrideDetails` throws the general unavailable error; `readAdminSettings` maps the entire registry. Keep storage outages fatal, isolate only known validation failures.
- Runtime fallback includes safety-specific behavior. Preserve it; list metadata must not change runtime behavior.
- `AdminSettings.tsx:SettingCard` gates reset by database source. Enable reset for invalid stored overrides and show a minimal warning with nonsecret stored value.
- SQL route fixture uses `helpers/sqlite-d1.ts` through `createAdminSettingsEnv`.

## Checklist / acceptance
- [x] Isolate invalid rows in list, default in effect, explicit invalid flag and nonsecret stored value, structured key-only warning.
- [x] Valid rows unchanged; runtime safety fallback unchanged; no global fail-closed list.
- [x] SQL good/bad/good, all-invalid, valid control, secret redaction, PATCH null reset regressions.
- [x] Remove guard once; record failing regression, restore and pass.
- [ ] Minimal UI warning/reset and behavioral coverage, Playwright screenshots 375/1280 reviewed.
- [ ] Docs synchronized, quality suite, independent specialist and completion reviews.
- [ ] Check both staging leases, reserve/deploy, CF D1 invalid fixture/browser/reset, release.
- [x] Production D1 read-only invalid count in PR.
- [ ] CI/CodeRabbit gates; merge, production deployment monitored; complete idea 01M7GA366849928YDY33ZW26Y2 with PR/commit and publish completion to feature.selfhost-landing.

## References
Rule 50; incident tasks/archive/2026-07-16-fix-sessions-list-internal-error-large-projects.md. SAM task 01M7JNBJ4BY2SVZDKRQM1H0CSX. Merge authorized by coordinator 01M7JMXS2JRW6QQMB1356ENPM3 after /do gates.


## Evidence and design decisions
- SQL route regression: 21 passed, including all-invalid, valid control, PATCH null, warning once/key-only, safety policies, KV veto, retained brake, and stale secret row redaction.
- Mutation: removing the row-isolation guard yields two 503 failures; valid control stays green (.tmp/d2-mutation-red.log). Restored guard passes.
- Preserve runtime fail-closed policies explicitly in definitions: Connector access/writes false, registration allowlist, redirect hosts empty; inverse SAM operator disabled true. The list reports their actual safe fallback instead of a misleading permissive default. No setting requires the whole list to fail closed.
- Read-only production scan at 2026-11-16T17:28:10.352Z: 0 invalid registered overrides; 3 registered override rows validated among 26 stored platform keys, 23 unrelated/unregistered keys ignored. No writes.
- Direct task-only main push rejected by required-check policy; task record stays on assigned managed feature branch. Existing SAM isolated workspace reused.
- UI options: page banner, per-row badge, inline shared Alert. Inline Alert selected to place invalid stored text and recovery guidance next to existing reset control.
