# Deterministic automation flow and SamSession tests

Coordinator-authorized follow-up to PR2728 after its production release (7bd2, deploy43628133084, 2026-11-14 19:05 UTC). Incidents: 01M7CG27J9K3A9D4EJ8368F54Q and 01M5VSYXMPGMGKFWDVJ8FC90Y5.

## Scope and gates

Test-only: diagnose automation GitHub-create 5s timeout and subsequent Continue-button cascade; control SamSession fixed-minute window in real workerd and isolate model mocks. Preserve real UI actions, DO requests, model completion, and lifecycle assertions. No timeout-only fix. Staging explicitly skipped by coordinator for this test-only scope; there is no changed UI surface. Leave direct-provisioning incident01M7DM4NRFE0NB737GVW8PEG7X untouched.

Open separate DRAFT PR with needs-human-review. After CI, local reviews and trusted CodeRabbit request/wait, send coordinator01M6SHDRB60F28XPA14C7J9XKZ URL+fullSHA+gates and STOP. Merge only after exactSHAapproval using --match-head-commit; then monitor mainCI and whole production deploy.

## Research

- automation-flows uses real routes, user-event typing/clicks, fresh QueryClients and shared API mocks. GitHub case does not await resulting navigation, unlike adjacent successful create flows. Determine slow path with measurement before editing.
- SamSession test uses a native Miniflare runtime shared by the file. Node Date fake timers do not control workerd. Rate limiter correctly uses fixed minute windows; original case can submit its two requests on opposite sides. A wrongly accepted second turn can outlive the failing case and hit the next HTTP mock.
- PR2726 demonstrates Date-only control and boundary offsets; keep real timers and real model lifecycle.

## Checklist / acceptance

- [x] Measure and diagnose both causes; deterministic final fixes, production behavior unchanged. GitHub user-event waits60→27 (real paste); native Date.now boundary control, bounded drain and poisoned-runtime isolation.
- [x] At least30 normal +30 CPU-loaded fresh full-file runs EACH:120 processes,3840 passing assertions, zero failures/skips; identical final source hashes.
- [x] Restore meaningful guard-removal RED proofs and final GREEN checks: GitHub label omission1 RED/38 PASS; rate guard removal4 RED/21 PASS; never-settling drain watchdog/poison proof.
- [x] Relevant lint/typecheck/build and local test/Cloudflare/completion reviews: all pass; initial Cloudflare unbounded-drain finding addressed, final re-review passed. Completion reviewer independently verified all120 runs/hashes/counts.
- [x] Draft PR, CI, trusted CodeRabbit request + wait; exactSHA coordinator hold.
- [x] Approved matched merge; mainCI + deployment + basic health receipts.

Archive PR2724 production watch remains separately active through2026-11-15 11:59:39.619UTC. PR2728 formal main Test samples:1/3=22:54(run43625240684); two subsequent actual main runs pending.

Local review tracker: test-engineer PASS; cloudflare-specialist ADDRESSED; task-completion-validator PASS (implementation/local validation only). Task stays active for PR, CI, trusted CodeRabbit request/wait, exact-SHA coordinator approval and release receipts; original watch and main timing samples remain open.


## Release completion — 2026-11-15

PR [2739](https://github.com/raphaeltm/simple-agent-manager/pull/2739) completed CI, specialist reviews and the trusted CodeRabbit request/wait. CodeRabbit approved exact head `6ec28fb472de0ce04b2fe5d961cf11916461fcdf`; coordinator approved that same SHA before matched squash merge `7649cbfbe88af94af2c91e7aaa0490aaf5924ada` at21:13:49UTC November14. Main CI43641698266 and whole Deploy Production43643978384 succeeded. Actual production version610d37ae-e44f-4a52-93f6-ac26c3e62e40 served100% that merge; health passed. Receipts reconciled again at closeout. Test-only staging skip remained explicitly authorized.

PR2728 timing follow-through is complete: actual-main Test samples22:54 (43625240684/job132541785579),25:25 (43641698266/job132590526644),22:44 (43644317818 attempt1/job132598650719), median22:54, accepted by coordinator. No synthetic runs or unauthorized reruns were used. The original PR2724 watch also completed its original November15 11:59:39.619UTC deadline; its accepted hour19 gap and final narrow observation scope are documented separately.

Final completion validation A/B/C/F PASS; D/E N/A. Earlier local review and120-run evidence remain valid; no implementation changed during release/watch. All release and follow-through items are complete.
