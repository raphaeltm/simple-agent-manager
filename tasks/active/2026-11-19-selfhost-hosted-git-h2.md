# H2: SAM-hosted git on self-host only

## Problem

A box built from main needs a repository source before it can create a project and run an agent. Owner D7 narrowed: HostedGitRepo is celld-only, never a Cloudflare export, binding, import or migration. Main v23 is unrelated and untouched.

## Research and preflight

Classes: cross-component, business logic, security sensitive, infra, docs sync. Main 08abf1393 already has L16's backend fallback selection and L22b's single self-host entry. L22c #2906 remains open, held on #2905 and security review; coordinator confirmed import/trim can proceed while celld wiring and BOX wait for L22c main. Integration has hosted-git runtime and conformance fixtures, but shared routes import local implementation (M4 HIGH-4).

Trace: project-create -> resolved Artifacts backend -> seed/import via backend remoteFetch -> authenticated self-host git HTTP -> HostedGitRepo SQLite. Runtime callback -> active workspace/current generation -> backend createToken with workspace identity -> git HTTP rechecks membership/lifecycle/generation -> push commits ref. Cloudflare keeps binding or null and global fetch, with no registered fallback.

Use existing L16 selection, extend its optional token context and fetch/import contract. Move implementation under selfhost; preserve Cloudflare semantics. Import with git checkout paths, no cherry-pick. Tests must exercise real git over smart HTTP and prove import-graph detection by introducing a forbidden import. Relevant lessons: callback routing/auth rule 34; DO interleaving rule 45; cross-boundary/vertical tests rules 23/35; no secret readback rule 83. Docs: operator README only (experimental self-host slice).

## Checklist

- [x] Fresh branch from main; import selected integration paths and trim
- [x] Move DO and hosted-git services under selfhost; dgit/pako excluded from Worker graph
- [x] Extend generic fallback seam: workspace-bound token context, remoteFetch and optional import capability (unregistered per coordinator empty-repo decision); remove shared local-backend branches
- [x] Wire celld-only binding/export/tag via L22 single entry stacked on stable L22c08e2f605a per coordinator
- [x] Add conformance/auth/lifecycle/token tests and import-graph violation proof
- [x] Document self-host repository support and limits
- [x] Local lint/typecheck/tests/build; security, Cloudflare, architecture and completion reviews
- [x] Draft PR then ready; CodeRabbit requested and explicit skip recorded; CI tracked below
- [x] Primary staging lease/deploy: Artifacts and GitHub project creation unchanged, local seam off
- [x] BOX existing bucket-mode deploy adds selfhost-hosted-git-v1; create project; OpenCode free reply; agent push verified; cleanup and BOX FREE
- [ ] Merge main; all gates current head; announce merging/merged SHA; production success; idea SHIPPED

## Acceptance

No HostedGitRepo/dgit/pako reachable from Cloudflare index; wrangler unchanged; no CF migration. Shared seam inert on Cloudflare. BOX upgrade succeeds with new celld tag, project creation and actual short free-model agent reply/push work. Every resource created by this task cleaned up. All required gates pass on merge head.

## Implementation evidence

Stacked L22c08e2f605a per coordinator to break circular BOX gate; #2906 merges before H2. Hosted suite22/22 (real git21 + celld dry-run1); selfhost unit113/113; config/project29/29; native runtime-token32/32. Worker graph negative probe importing pako through workspace package failed as intended. GC admission negative probe failed exactly the race test. Security followup inflation/GC6/6.

BOX proof: existing795bf674f upgraded bucket-mode to a7cad then f6c65e71a healthy, celld tag confirmed. Hosted project01M7SX75X1YVADRG9Z4AB4AMV0; OpenCode big-pickle task01M7SXCMYYTAB9DNCFFAZMM0G1 replied pong; cookie-free clone verified agent commitad485ee136d4c8469b1e05e2983e086dd9e9393b and h2-proof.txt=pong. Stop/node/project delete200; nodes empty/project404/GCP no matching VM. Test credential/key/firewall/scratch removed. BOX FREE channel sequence403.


Review follow-up at 0f504c8dc: security PASS (independent 19 tests), Cloudflare PASS (54 tests), architecture PASS. Ref-only pushes now have an administrator-lowerable 10,000-ref cap and storage reservation; deletions do not earn admission capacity before old-OID validation (delete then add as separate pushes at the cap). Real HTTP mixed stale-delete/new-ref test fails when that protection is removed. DELETE queues behind accepted pushes, cancels clone streams, persists a tombstone and transactionally wipes/reinitializes; cleanup failures can retry while writes stay fenced. Mutex-negative probe fails the overlapping push/delete test. Ingested packs schedule GC even if every ref is rejected; oversized ls-refs returns a readable 413. Personal token endpoint is documented in API contract.

Primary staging f6 deployment44527475370 passed deploy/smokes. Live Artifacts creation exposed a native RPC regression: optional extension property reads synthesize RPC methods. Fixed by selecting empty extensions when the native binding exists; only the registered fallback supplies import/fetch. Native browser transport similarly avoids extension probing. Proxy-shaped route and browser tests cover this; removing the guard makes the route test fail. Replacement deploy44532452799 at0f504c8dc pending. No staging project or VM persisted from failed seed (route cleans the orphan). CF settings independently confirm native ARTIFACTS present, hosted binding/DO absent. Browser project list loaded with zero page errors. Artifacts/GitHub creation gates remain pending the replacement deployment.


## Final candidate proof (2026-11-19)

Candidate e7ac643b18f4ca864e403d33f7fbcf7a1a5e8fe8 has identical runtime to reviewed0f504c8dc; later changes document vendoring and add real-SQLite rejected-pack GC/tombstoned-deletion coverage. Hosted22/22, full API lint/typecheck passed. Security/Cloudflare/architecture PASS; completion validator independently A-F PASS, release completion pending CI/merge/production. Five Codex threads resolved. CodeRabbit requested at readiness12:33, trusted workflow44525031212; explicit skip12:34:24 (136files>100), ending wait per policy.

Replacement staging44532452799 succeeded. Authenticated Playwright created Artifacts01M7T0EY1H2F03C1KK3W60DMQ9 and GitHub01M7T0F97C4V2BNV2M645TFF9M:201, branches200, selfhost token/git routes404. Both projects deleted200 and verified404. Dashboard/projects/settings and project overview navigation: zero page/console errors. No staging VM created. Runtime equivalence0f→e7 avoids another deploy for docs/tests only.

Final BOX: existing f6→e7 ordinary bucket upgrade exit0/healthy; hosted project01M7T0482A939BRG0JFFK9VG62 created201, owner token200/unauth401. Normal fresh-node task01M7T0VJHK2381FBXA2VG6PM8Q / sessionbc1634b8-0065-43d9-835f-1d75197ec00b used OpenCode big-pickle free and replied pong. Independent cookie-free clone of sam/ping-run-one-shell-g6pm8q verified pushed commit164c22e3dc1c52de674718cc3996a31f75833c29 with h2-proof.txt=pong. Stop/node/project DELETE200, project404/nodesempty, GCP inventory no matching VM for either attempt. Test agent credential removed200, own SSHkeyabsent/firewall404, remote/local access/scratch removed; checkout clean at e7 and four original containers healthy. BOX FREE feature.selfhost-landing sequence405.

First final BOX attempt01M7T05XSYH7ZPX5Y24DC4S4CH failed Ubuntu GCE mirror503 installing Docker before ready callback. Node01M7T062B9J4M1ZMBWT0Z2BXFP deleted through SAM; coordinator approved one normal fresh retry, which passed above. Sanitized evidence library01M7T0VM6MXVT21PMF5AJ4QMB7 and backlog01M7T0W1QW6WGMZGK1RYAXEEB1 track bounded retries/fallback mirror and failure callback. Raw debug copy deleted after analysis per policy.

Current CI at e7:30success/8skip, only Playwright Visual Tests pending (44533748428/job135593986625). Final release checklist remains unchecked until prerequisite/main merge, current-head CI and production finish.


## Late review corrections (2026-11-19 18:21 UTC)

PR Shepherd found two newer 13:32 Codex threads omitted from the earlier five-thread resolution report. Both applied: failed ingest persisted incomplete pack rows until another admitted ingest, which quota could block; failed GC cleared pending before sweeping and never retried. Runtime delta touches PackStore.cleanupOrphans/ingest (extract existing sweep), HostedGitRepo.processReceive error branch, alarm/runAlarm/gc retry bookkeeping, and repositories.maxGcAttempts metadata. Auth, deletion and happy-path git protocol are unchanged.

Incomplete rows now clear immediately after failed ingest before alarm scheduling; GC also sweeps them independently. Successful GC clears pending/attempts under its writer slot. Failure persists retry intent and attempts under that same slot, re-arms five minutes later up to administrator-lowerable maxGcAttempts=3, then preserves a failed marker without automatic rearming. Success resets the consecutive-failure budget. Errors are carried out after blockConcurrencyWhile completes to avoid DO reset discarding retry handling.

Full real-git/SQLite suite24/24 passed; GC/deletion units8/8 passed, including transient recovery, four success/failure cycles, attempt exhaustion, and alarm-scheduling failure ordering. Negative controls independently failed: disabling immediate cleanup left2199552bytes==cap; disabling retry handling leftpending0 instead of1. Restored tests pass. Security delta review PASS, including serialized failure metadata. No implementation omission remains; fresh CI and zero unresolved threads must still be confirmed.

Coordinator decision720e4e43-2b39-4979-a6e1-3024553dd7c8 explicitly waives repeating BOX if delta stays confined to these failure paths, full real-git+new SQLite tests/negative controls pass, security delta passes, and fresh CI is green with zero open threads. Existing BOX proof/cleanup remains valid under those conditions. Staging native seam is unchanged.


## Ref-name review and complete rule audit (18:30 UTC)

New current-head Codex r4633207972 found intermediate .lock components accepted by validatePush. Added the component suffix guard. Auditing every rule from https://git-scm.com/docs/git-check-ref-format also found missing whole-ref trailing-dot refusal; added that guard in the same fix. All other ten rules were already enforced in the refs/ namespace; conservative HTML/whitespace/255-character restrictions remain unchanged.

Real raw smart-HTTP test refuses foo.lock/bar, foo.lock and ends-dot., and accepts normal, feature/x and foo.lockish/bar through the same validatePush/write path. Real validatePush rule matrix66/66 compares Git CLI outcomes (NUL checked directly since OS argv cannot carry it); full conformance25/25. Independent negative controls: remove component guard -> raw HTTP accepts the invalid ref; remove trailing-dot guard -> exactly1matrixfailure/65pass. Restored suite rerun. Security independently audited all ten rules and passed this delta.

Coordinator decision5e57db22-5e40-46af-8aec-f1894395779f extends NOBOXREPEAT to this invalid-name admission tightening if ordinary+nested positive controls, negative control, full real-git, security delta, fresh CI and zero threads all pass. It rejects names the ordinary BOX branch never used; auth, happy-path valid names and deletion remain unchanged. Fresh CI remains required.
