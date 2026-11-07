# Provider-limit waits and owner recovery

## Problem

Known resets must resume automatically. Rejections in one window currently burn the unknown-reset budget; event deliveries bypass the scheduled-action check and can create a feedback loop. Blocked waits have no owner action and disagree with snapshot/chat recovery state.

## Research

- provider-limit-policy.ts increments attempts for every new prompt incident, even identical reset timestamps.
- project-event-schedules-delivery.ts checks scheduled_action only, not subscription deliveries.
- provider-limit-admission.ts stops the runner alarm for blocked waits.
- Production read-only story confirms queued/provider_limit_blocked + waking snapshot + sleeping/wake_failed chat. Do not mutate production task 01M6RQCRCN3F8ERRCREDPVQEKJ.
- Existing provider-limit-lifecycle and provider-limit-admission integration fixtures drive callback, durable alarms, and TaskRunner.

## Checklist / acceptance

- [x] Deduplicate same credential/window waits, preserve known reset retry and unknown reset budget.
- [x] Trace and guard real subscription prompt delivery; defer while waiting, suppress own credential events.
- [x] Owner resume API and dashboard/chat controls wake retained snapshot.
- [x] Coherent blocked task/chat/snapshot state.
- [x] Parent cancellation if small; otherwise update related idea.
- [x] Real entry point regression tests and guard reversion red/green evidence.
- [x] UI mobile/desktop screenshot audit; lint/typecheck/test/build.
- [x] Specialist review and staging verification.
- [ ] PR/CI/CodeRabbit, merge/deploy.
- [ ] Update idea 01M6SKEAYHG5P9T8ES3Z331A37 with PR/outcome.

## References

Ideas 01M6SKEAYHG5P9T8ES3Z331A37, 01M6GW3B0YQJVBE6Q8Q1SCX1W3; rules 35/62; /do.

## Implementation and review evidence

- Same reset (60-second default rounding tolerance, optional deployment override) refreshes one wait and schedule; elapsed unknown retries still consume the budget. Known reset waits do not exhaust that budget.
- Actual subscription path: event admission/matching -> project-events-materialization -> project_event_wake inbox -> prompt-delivery-runner -> provider guard -> VM submit/steer. The old schedules guard only runs for scheduled_action. Both submit-time and before-side-effect checks hold waiting/blocked tasks. Own credential notices become recorded_not_injected; mixed batches retain other events.
- Final callback/admission/policy72/72, owner recovery5/5, event/occupancy Workers15/15, existing runtime-steer4/4 and UI7/7 passed. One-use owner approval, current chat successor ownership, immutable transcript and receipt reconciliation have positive regressions and discriminating guard reversions.
- Removed each policy guard once: known window equivalence, pending unknown equivalence, known reset budget exemption. Each intended real-callback test failed, then source restored.
- Removed delivery hold, own-credential filter, and transport lifetime preservation once. Real alarm tests failed (unexpected prompt, own ID leak, no delivery after release); restored.
- Full-path callback->sleep->resume test caught retained sleeping workspace ID, fixed by snapshot-verified detach. Review caught fresh-dispatch no-snapshot and credential injection pin cases; owner approval now nudges first admission or repins exact selected account before recovery injection. Rejected recovery preserves retry.
- Per-DO concurrency gate reads current provider wait before syncing attention, preventing stale presentation after resume while preserving unrelated human input.
- UI uses opaque wait version so identical-reason reblocks become resumable even when a release happened between polls.
- Mobile/desktop/narrow screenshots both themes reviewed; no overflow or clipping. Parent cancellation deferred with evidence on idea 01M6GW3B0YQJVBE6Q8Q1SCX1W3.

## Post-mortem

What broke: provider resets with known times became permanent blocks after event-driven rejections. Chat, snapshot and task disagreed, with no owner recovery action.
Root cause: per-prompt incident counting spent an unknown-reset budget on one known window; subscription event wakes bypassed a scheduled-action-only guard; no blocked resume operation existed.
Class: uncovered cross-boundary feedback loop and unrecoverable lifecycle state.
Why missed: tests repeated identical callback receipts instead of distinct prompts in one window, and tested schedules rather than subscription delivery.
Process fix: real callback/admission/event-alarm and owner HTTP-to-recovery regressions plus guard-reversion proofs required by rules35/62; no duplicate standing rules added.

- Full repository tests: all non-API packages passed, including web4994. Initial API run15263 passed/3 failed/2 skipped exposed an immutable transcript write, missing recovery-failure anchor and stale read-count assertion; all corrected and focused reruns green. Final full API rerun1055 files/15267 tests passed,1 file/2 tests skipped; final lint/typecheck/build35/35 passed. Staging/release gates remain tracked below and in the PR.

## Staging verification — 2026-11-07

Deployment [42325669128](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42325669128) passed at runtime candidate `0b7b87d23`. No runtime code changed afterward. Live dashboard, projects and settings passed Playwright checks. Actual Worker settings restored both temporary background/idle overrides to absence, with normal code defaults; the preceding staging owner independently verified restoration.

One disposable task `01M6SVSNJJNNTP1E7YVWHQVFFV` in the staging Potato project used one small VM, healthy heartbeat at02:04:11UTC. Normal session sleep saved an available snapshot. The read-only debug token could not seed the blocked fixture, so reviewed temporary manual action [42327947162](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42327947162) used the existing staging deployment credential with exact staging account/database/task/project/session/nonce, available sleeping snapshot and one-row CAS guards. It updated exactly one test wait; deployment/audit jobs were skipped. The workflow was restored byte-for-byte, leaving no workflow diff.

Live desktop/mobile chat showed Needs you and Resume task without mobile overflow. Clicking Resume task returned202 and the same task ran in a new workspace. Read-back confirmed provider wait null, recovery status restored, matching recovery workspace and no recovery error. The initial verifier incorrectly expected admission null; legitimate scheduler placement is placed, so corrected read-only proof accepts placed and verifies the cleared provider block. No second resume was attempted.

Screenshots: desktop library `01M6SWEWXDXA9H6ZSMHYV44JVT`, mobile `01M6SWEZ083K3N8160J151MPKY`; both opened and reviewed. Cleanup cancelled the test task, removed both workspace records and verified the sole test node GET404. One VM ran approximately14 minutes; no production task was modified.

The midnight formatting-baseline expiry was handled by reusing the exact reviewed date-only metadata from PR2559 commit `a7696132e4ce5c99b7fad81f525c35c75e508950`, retaining formatter/base/debt ceiling. Own ratchet passed1991/2225. Remaining release outcome belongs in the PR and idea after CI, CodeRabbit and deployment.

CI deployment validation caught the optional reset-tolerance variable missing from both GitHub workflow config-sync environment maps. Both mappings were added in `.github/workflows/deploy-reusable.yml`; the existing complete-mapping regression went from red to48/48 green. Read-only environment/security review passed: optional non-secret variable, docs/example/runtime/config-sync agree, absent value retains the already-tested60-second default. Runtime code and completed live staging behavior are unchanged.

After PR2559 merged, current main was integrated; the only conflict was environment reference wording, resolved with both the provider tolerance and new real-work clock text. Merged lifecycle/recovery/idle compatibility passed131/131. CI's structural SQL rule rejected a generated placeholder list despite bound values; the event guard now uses two fixed bound slots (current and parked keys), with NULL padding for one key. Security review and real Workers event/occupancy15/15 passed; AST checks report zero errors. A final integrated staging refresh follows; the owner-resume API/UI remain unchanged from the live snapshot proof.
