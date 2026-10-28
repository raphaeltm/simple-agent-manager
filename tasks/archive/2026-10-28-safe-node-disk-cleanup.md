# Safe node disk cleanup

Rebuild of interrupted task01M5YF5N469Z2SSS6FTDQ9C9YJ; current owner01M5ZB6QDY4Q5Q08M1G4PE70EW. Human authorized rebuilding prior lost code from transcript Oct28. Research idea01M5Y9YDCHT02HYPRGXKV2Y2DP; original chatf997ca0f-66b2-4472-b46f-35cc54d813a7/research2dae5dce-f09a-4a9c-a155-ba1561113b3c.

## Problem and research

Node workspace deletion drops runtime metadata despite swallowed container/volume errors and leaves host clones. Existing control-plane deletion claims/proof/retries must remain authoritative. Failed provisioning, failed sleep/wake and evicted source data can be the only recovery copy. Node status/age/pressure alone cannot authorize destructive cleanup. Existing lifecycle lock serializes runtime transitions; extend exact identity through it. Deployment imageGC already protects rollback images and is excluded.

## Implementation and acceptance

- [x] Durable local deletion intent records exact owned artifacts before removal; propagate partial failures; retain identity/state until absence verified; delete validated owned host clones.
- [x] Same operation on bounded periodic/restart reconciliation; unknown/legacy artifacts report-only; configurable budgets/backoff and fail closed.
- [x] Control plane transmits node incarnation/workspace generation/owner fences; central preservation authority for automatic lifecycle cleanup; explicit deletion remains distinct.
- [x] Preserve failed snapshot and unpreserved provisioning/wake/eviction sources; retire only after verified preservation/handoff.
- [x] Narrow owned image-transfer scratch cleanup with active protection and dry-run default, configurable limits; exclude user/nested Docker volumes/caches and deployment/rollback images.
- [x] Meaningful tests: partial deletion/retry/restart/duplicates; wake/rebuild/snapshot races; stale identities; preservation failures and eviction handoff; standalone; symlink/mount escapes; nested/user volumes and rollback preservation.
- [x] Docs/env references match code; no new admin routes unless matching phone UI supplied.
- [x] Local suite and independent Go/Cloudflare/security/constitution source reviews pass; completion source mapping passes with staging/release evidence pending.
- [x] Bounded coordinated staging lifecycle sweep with dirty/untracked data, failure injection/restart and repeated no-leak cycles; real VM heartbeat/access; promptly clean own staging resources.
- [ ] DraftPR, greenCI, best-effort CodeRabbit request+wait; normal authorized release/basic production smoke.

No cutoff changes (#2450 shipped). No manual production deletion, blanket prune, forced retirement, automatic platform Git publication, or age/status/pressure-only workspace deletion.

## Validation evidence (Oct 28, before staging)

No previous agent implementation recovered; rebuilt from original transcript per human direction. Original branch checkpoints through 4aa91533b pushed. Physical deletion capability route intentionally differs from old DELETE so old agents fail closed.

- Go server/persistence/config/bootstrap suites passed (1,600 cases including subtests); focused deletion race suites passed; `go vet ./...` passed. Transfer scratch/deploy/publish race suites passed, including actual subprocess termination/retry. Actual bind-mount test skipped locally because mount denied (EPERM); privileged staging proof remains required.
- Root build passed 9 tasks, lint passed 13 tasks (three existing web warnings), typecheck passed 19 tasks (Astro baseline diagnostic accepted by existing validator). Migration ordering, runtime tunable ratchet, file size checks and agent context measurement passed.
- Worker lifecycle suite passed 76/76, including same-operation transient CF retirement retry and successor incarnation protection. Final full API rerun: 978 files (977 passed, one skipped), 14,055 tests passed, two skipped. Archive/retirement fixtures now require physical proof and preserve unconfirmed data. Prior root full suite aborted on web comment-reader timing failure; isolated rerun passed 16/16.
- Independent Go/security review passed after fixes; Cloudflare/security review found caller ownership and successor snapshot races, fixed and reverified with 71 tests passed. Scratch review passed; constitution/env review passed. Completion review remains open until remaining validation and release gates.
- Initial staging candidate a893cd2e7e1cf0e52b722ee7b66ca1b5a090f621 was deployed in run40653426846; no PR/CI/CodeRabbit or production release yet. Staging preflight authenticated successfully; no active staging deployment observed. No production resources mutated.

Final independent review: API/Cloudflare/security PASS after source/capture/handoff snapshot CAS, caller fences, strict Stop behavior and same-operation CF retirement retry. Scratch/Go/process-test reviews PASS; whole VM Agent `go test ./...` PASS. Completion release evidence remains pending.

## First staging pass and correction

Deployment40653426846 and smoke tests passed for a893cd2e7. Direct Cloudflare metadata confirmed candidate100% and D1 migration0210 applied. Own cx23 VM01M60SPNFG0AAD0DJ4W0SDEGFW reported the exact required agent6b5ffd23a through authenticated system-info and subsequently heartbeats. First workspace provisioning exposed an absent `/workspace` base on a fresh node. Deletion returned202 pending honestly. No user data had been written; normal own-node deletion returned200 and subsequent GET404.

Fix90c83db1f initializes missing trusted base components through pinned dirFDs, refuses symlinks, exclusively creates the workspace leaf, and records exact inode/device provenance. Fresh-base/ancestor tests and corrected standalone coverage passed with race detection; whole VM Agent suite and vet passed; independent Go/security review passed. Second staging deployment40657993076 failed its Darwin build because syscall.Openat/Mkdirat are Linux-only. Fix7b6eddf1c uses the existing pinned x/sys/unix dependency; all four Linux/Darwin amd64/arm64 builds and focused race/vet checks pass. No concurrent test VM and no production mutation. Own empty project01M60SP3Z08FY0B8TJEZP3BQ4B retained for bounded rerun.

## Historical staging upload gate (resolved)

Candidate7b6eddf1cc57d0066771dcd931f8b94396d5a026 run40659782129 passed all compilation stages but attempt1 failed API upload with Cloudflare10021 startup CPU exceeded. API source and lockfile are identical to the first successful upload (626ms startup, same bundle sizes); no CPU profile artifact was retained and independent review found no specific new initializer target. After checking Cloudflare active state and concurrent runs, one bounded failed-job retry is in progress. No further retry loop or release waiver is authorized. Direct Cloudflare still showed the previous API/required-agent version before retry.

Refreshed independent task-completion review at7b6eddf1c passes all source/checklist mappings and reports no source blocker. Actual privileged staging fixtures, real lifecycle preservation/no-leak cycles, PR/CI/CodeRabbit and release/basic production smoke remain pending. Prepared helper scripts are not validation evidence.

## Second real VM findings (09:29–09:48 UTC)

Run40659782129 attempt2 deployed candidate7b6eddf1c and smoke passed. Cloudflare confirmed100% version649d39b0-5cb4-4a80-ad00-5d2482c2a14a, requiredagent7b6; APIstartup471ms. Own cx23node01M60XGGZCB1R230FB1HBQH2YH authenticatedsysteminfo exactagent, Docker27.5.1, heartbeat/normalplacement accepted. Canary01M60XNK9Q068G7Z67KWWSXFHQ andprimary01M60XV0ZHVDBAKEJB417FV8EA provisionedrunning, provingfreshbasefix. Privilegedfixture binariespassedactualbindmount/noSKIP, scratchdryrun/apply/activelease/crash, separateprocessSQLiteexit/reopen anddeletionfences. Thisdoesnotrestartdeployedhostdaemon.

ActualDELETEprimaryreturned202pending, preservingallartifacts: integrationbugfound APIJWTownerinvalidatedsub butGo handlerreademptyuserIdclaim. GoSubjectfix+actualwireJWTregression inprogress; APItypedstatusdiagnosticfixadjacent. Canarydirty/untracked/cache/nestedDockeruser-volume/exactrollbackimageIDverifiedunchangedAFTERFAILEDATTEMPTonly; notsuccessfuldeletion/no-leakproofyet.

ManualworkspacecodexsessionstartedthroughnormalACPselect_agent, durablepromptassistantOK/nodecompletedend_turn; activitycallbacks404leavestale prompting, sleepsafety409. Noidlenessbypass. Separatebacklogidea01M60YGDJJD8Z78DTBM7XC508A; nextfullsleep smokeusesnormalpinned-node tasksubmissioninstead. NormalownnodeDELETE200+GET404confirmedVMremoved09:48; onlyemptyownprojectretained. NoPR/productionmutation.

Owner-token integration correction: use validated management JWT subject, matching the actual API signer; never grant authority from the optional userId payload. Body/config owner and exact workspace/node/incarnation fences remain. Actual-wire regression covers valid subject without userId plus foreign/missing subjects borrowing userId, with no unauthorized intent or artifact mutation. Focused Go race15.590s/vet and independent Go/security review passed. Typed HTTP status diagnostics preserve409 without persisting raw response bodies; 9 API suites/127 tests and scoped lint passed. New complete staging lifecycle evidence remains pending.

## Full sleep and wake integration findings

Candidate1e76bed02 deployment40667730834 and smoke passed (API668ms; required Go417d25f72). Actual explicit workspace deletion returned200/confirmed thenGET404. Normal task provisioning created one cx23(2CPU/4GB) and a task-backed Codex conversation; full sleep returned200 with snapshot available, no degradation/fallback, HOME+WIP artifact/hash presence and preserved exact cleanup identity. The queued automatic operation physically deleted that sleeping source; its active sibling's dirty/untracked bytes, user cache, nested Docker volume and exact rollback image ID remained unchanged. Privileged mount/no-skip, owner-token and real process/crash fixtures passed on this candidate.

Wake found two integration gaps. Verified sleep scheduled the ordinary stopped-workspace TTL, while replacement correctly waited for deletion proof;78a3a81e4 queues that SAME verified operation immediately, with 81 Worker and204 unit/integration tests, typecheck/lint and independent review passed. Managed restore held the lifecycle lock then recursively called the newly locking provisioning wrapper. A lock-owned internal provisioning path fixes that recursion while retaining the outer lock throughout restore; actual managed-handler and deletion-barrier regression passed, with independent source review. Final managed restore race30.778s, server67.557s, vet and entire VM Agent suite passed; final independent review passed with original system-wait/error telemetry preserved. Corrected end-to-end wake remains pending.

The partial pass does NOT establish restored dirty bytes: terminal attachment was blocked behind the deadlock. Disposable task01M610RE3ZGY87QCVZX8N73T68 was cancelled and its VM01M610RSPHBD50YKGSEG2XSND9 deleted normally(200 thenGET404). Two earlier unresolved direct-allocation nodes were fenced by normal DELETE409 and reconciled through exact provider inventory on retry(200 then404), before any successor allocation. No force flags, runtime idleness bypass, timeout override, PR or production mutation.

Cleanup audit found the older queued follow-up reactivating the cancelled disposable task and allocating another small VM. Normal conversation archive returned409/preserved data; its canonical stopped state rejected replacement linkage. Normal own-node deletion200/GET404 then archive retry200/workspaceDeletedtrue completed cleanup. This separate cancellation issue is recorded as backlog01M612HPQJQ78A4K7J240XYH3Z; no implementation expansion. The older delivery allocated again despite stopped state; normal deletion of the disposable project finally removed its allocation authority. Final fixture delivery completed normally before cleanup. No production mutation.

## Final implementation and staging acceptance — PASS

Final runtime candidate `252ba3dea59f92ae39d115df2ccdea90922481fd` deployed in [run40676464355](https://github.com/raphaeltm/simple-agent-manager/actions/runs/40676464355); deployment and smoke passed. Cloudflare confirmed100% version `d9c18f78-e239-4fb8-b5b1-6b15b0b73bfe`, required agent252ba3. Fresh normal TaskRunner cx23 VMs reported exact agent version, heartbeat and accessible workspace terminals; authenticated Playwright showed the resumed assistant OK and idle composer.

Actual full sleep200 produced snapshot01M614BXBZBWNYQC88DDH39ZDR available/degradationnone, HOME/WIP artifact+hash presence, exact preserved identity and no fallback. Source01M6149HXDSWHH03P7CYV6X608 physically disappeared(GET404). Normal follow-up woke target01M614VE2QKSKJTYECAWD5WKAR on a second small node; exact nonce252ba3dea-1668e03bc3 tracked modification and untracked bytes/classification survived. The resumed agent repliedOK and reached awaiting_followup. Normal archive200/workspaceDeletedtrue thenGET404 removed its exact container2598fbf6b6ce, retaining the model-runner; measured disk9161572352→7792173056 bytes.

Two bounded empty create/delete cycles returned200/confirmed then404. Exact containerscd03d65217ae and6ef3da5a1e1a disappeared; active canary8eab27135a7a and model-runnerd0c1a656a8eb remained. Disk before/after:8127500288→8126877696 and8127655936→8127041536 bytes. These are bounded observations, not a global-zero/leak-proof claim. Active sibling dirty/untracked bytes, user cache, isolated nested Docker volume and exact rollback-imageID passed after source cleanup, both cycles and immediately before fixture disposal.

Final privileged test binaries passed all28 selected top-level tests with no skips and real bind mounts, including scratch dry-run/apply/active/crash, exact deletion fences, fresh-root initialization, actual-wire owner and managed restore/deletion barrier. Process restart proof uses separate real processes and durable SQLite/filesystem with fake Docker; no deployed host-daemon restart is claimed. Latest full Go ./..., vet, server67.557s and focused race30.778s passed; latest API81Worker/204unit+integration/typecheck/lint passed in addition to the full baseline above.

Normal fixture archive succeeded. Both own nodes01M6141Q32878AJ3VRCH25BQKR and01M614N4J505F5SJVQKFWXZ0SK DELETE200 thenGET404; own project01M6140Q7VQ3TSZP5XJ02DQRWD DELETE200 thenGET404. Final inventory contains zero creating/running/destroying VMs and preserves the unrelated deployment-error and two sleeping Cloudflare nodes. Peak was two2CPU/4GB nodes briefly for cross-node restore, conservative incremental cost under$1; no test VMs left at rest. Independent completion review verified actual logs/screenshot and cleanup receipts.

Implementation/staging accepted and archived for PR. DraftPR, current-headCI, CodeRabbit request/wait, authorized release and basic production smoke remain outstanding and tracked in the PR and local workflow state. No production resource cleanup performed.

## CI security prerequisite

Initial PR2463 head5cf5ba221 CI found missing direct dependency evidence for existing pinned x/sys v0.48.0 (indirect→direct); official registry/home/necessity evidence added without changing its version. The vulnerability gate found12 reachable Go1.26.6 standard-library advisories; official GO-2026-6809 requires1.26.10. CI/deploy/e2e, module toolchains, devcontainer and current docs/floor pins now consistently use1.26.10. Failure diagnostics expose captured scanner output while retaining failure. No cleanup behavior, dependency version or gate exception changed.

Official go.dev archive SHA256ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5 independently verified. Go1.26.10 full node suite(server75.710s), CLI, vet, four-platform build, focused cleanup/restore race12.033s, direct scanner and actual vulnerability policy gate passed with no vulnerabilities. All three modules tidy -diff unchanged; floor/policy/context checks passed and independent security review confirmed pins/gate behavior. Twenty combined evidence/floor/policy regression tests passed. Fresh patched-binary staging revalidation remains required before readiness/release; prior lifecycle evidence above applies to the prior Go1.26.6 candidate.

## Complete CI fixture alignment

Go1.26.10 CI passed the full root Test job, code quality, vulnerability gate, lint/types/build and VM integration/E2E/volume suites. Remaining Worker fixtures used legacy204/no incarnation or expected status-only teardown. Updated only tests to supply strict identity-echoed receipts and actual preservation authority for positive cases, and to retain failed/unpreserved sources in negative cases. Provider/eviction22 tests, shared-helper5 tests and guard4files61 tests passed, with API typecheck/lint and independent cross-review. Completed-operation proof is verified without duplicate deletion.

The ACP callback fixture now namespaces each recorder URL so late retries cannot contaminate a new fixture on a recycled port. A deterministic foreign-namespace rejection/current-namespace acceptance test covers this; the original CI flake was not reproduced locally. A separately reproduced fixture publication ordering bug was fixed by incrementing its counter before sending the event. Original runtime/identity/reason assertions remain unchanged. Focused race100, broader20 and full ACP race32.676s passed with independent review. No production behavior changed afterb3b55c6f7.

Patched staging40683447442 deployed exactb3b55c6f7 at100% Cloudflare version1f97e373-7e96-4f0b-a7dc-ff8d259ebd51 with matching required agent. Smoke attempt1 passed11/12; settings login navigation timed out waiting for networkidle, before tab assertions. No trace artifact retained. Live authenticated dashboard/projects/settings and a separate DOM/request probe passed with no page errors/pending requests. One bounded failed-smoke-only retry requested; no blind redeployment. Fresh Go1.26.10 lifecycle validation remains pending before release.


### Supplemental scratch ancestor safety review (2026-10-28)

Final Sonar reconciliation found two Docker PATH reports; two independent reviewers confirmed literal executable/separate argv and trusted root systemd environment, with no request-controlled PATH/cwd. Both reports were resolved through supported Sonar issue transitions with issue-specific trust evidence. No scanner exclusion or source suppression was added.

Scratch default private root beneath sticky `/tmp` resisted the independent review, but custom roots beneath a non-sticky writable ancestor could be redirected after operation creation because archive writers use the operation pathname. The focused correction validates every ancestor through pinned directory handles before traversing/creating descendants, requires root/service-user ownership and non-writable or trusted sticky permissions, rejects symlinks, and checks opened inode identity. The final leaf remains private and owned by the service user.

Regressions cover missing and existing private roots below unsafe writable ancestors, unchanged user cache during apply sweep, trusted sticky success, foreign-owned sticky refusal, and symlink refusal. Scratch full race passed1.156s; deploy/publish package tests passed2.070s/0.037s; vet/diff passed. Actual root-run foreign-UID fixture passed without skip. Public configuration and environment reference updated; independent docs/env/constitution review passed. Independent security re-verification and fresh CI/staging for this runtime delta remain pending. Prior b3b55 staging evidence remains valid for that prior build and is not represented as verification of this new fix. Production remains unchanged.

Independent defensive review also identified raw-vs-cleaned root inconsistency; `New` now normalizes the configured root once before validation, creation and archive-path exposure. Its regression confirms only the validated destination is used. Final scratch race passed1.138s and deploy/publish tests2.042s/0.043s; independent uncached scratch0.069s and final security/docs/env/constitution review passed. Fresh CI and exact-build staging remain pending.

### Post-merge deterministic alarm test follow-up

PR2463 merged as0c9fe1aae46f9578240649a857bea3ff5cb1eaed after all PR gates passed. Main CI40698456243 then exposed one test observation race: an immediate real platform alarm ran before the test inspected its initial queue entry, so correct first-attempt retry backoff violated the test's initial timestamp assertion. Actual scheduling logged delay 0; no runtime defect or deployment failure was demonstrated. Production remained on its prior release behind the CI gate.

The follow-up changes only the test, using existing `pauseNodeAlarms` before enqueue, restoring spies after tests, and asserting no network call before the explicit alarm step. Real DO/D1 transactions and deletion/wake logic remain intact. Existing immediate enqueue timestamp/attempt0, legacy receipt rejection, wake block and strict physical-proof release assertions are unchanged. Full NodeLifecycle Workers81/81 passed75.18s; API typecheck and scoped lint passed. Independent source/evidence review passed. Runtime/build inputs remain identical to the fully staged original PR; no new runtime deployment or VM fixtures are required for this test-only delta.

Completion checks: research-to-diff PASS, checklist-to-diff PASS, criteria-to-test PASS, UI propagation N/A, resource selection N/A, vertical slice PASS (real DO/D1 with controlled timer delivery). Follow-up PR must start draft, pass fresh CI, request/wait CodeRabbit, then merge under existing release authority. Normal main CI and production deployment/basic smoke remain pending; no gate bypass or additional production cleanup is authorized.
