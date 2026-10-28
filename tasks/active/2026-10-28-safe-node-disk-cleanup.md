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
- [ ] Bounded coordinated staging lifecycle sweep with dirty/untracked data, failure injection/restart and repeated no-leak cycles; real VM heartbeat/access; promptly clean own staging resources.
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

## Current staging gate

Candidate7b6eddf1cc57d0066771dcd931f8b94396d5a026 run40659782129 passed all compilation stages but attempt1 failed API upload with Cloudflare10021 startup CPU exceeded. API source and lockfile are identical to the first successful upload (626ms startup, same bundle sizes); no CPU profile artifact was retained and independent review found no specific new initializer target. After checking Cloudflare active state and concurrent runs, one bounded failed-job retry is in progress. No further retry loop or release waiver is authorized. Direct Cloudflare still showed the previous API/required-agent version before retry.

Refreshed independent task-completion review at7b6eddf1c passes all source/checklist mappings and reports no source blocker. Actual privileged staging fixtures, real lifecycle preservation/no-leak cycles, PR/CI/CodeRabbit and release/basic production smoke remain pending. Prepared helper scripts are not validation evidence.

## Second real VM findings (09:29–09:48 UTC)

Run40659782129 attempt2 deployed candidate7b6eddf1c and smoke passed. Cloudflare confirmed100% version649d39b0-5cb4-4a80-ad00-5d2482c2a14a, requiredagent7b6; APIstartup471ms. Own cx23node01M60XGGZCB1R230FB1HBQH2YH authenticatedsysteminfo exactagent, Docker27.5.1, heartbeat/normalplacement accepted. Canary01M60XNK9Q068G7Z67KWWSXFHQ andprimary01M60XV0ZHVDBAKEJB417FV8EA provisionedrunning, provingfreshbasefix. Privilegedfixture binariespassedactualbindmount/noSKIP, scratchdryrun/apply/activelease/crash, separateprocessSQLiteexit/reopen anddeletionfences. Thisdoesnotrestartdeployedhostdaemon.

ActualDELETEprimaryreturned202pending, preservingallartifacts: integrationbugfound APIJWTownerinvalidatedsub butGo handlerreademptyuserIdclaim. GoSubjectfix+actualwireJWTregression inprogress; APItypedstatusdiagnosticfixadjacent. Canarydirty/untracked/cache/nestedDockeruser-volume/exactrollbackimageIDverifiedunchangedAFTERFAILEDATTEMPTonly; notsuccessfuldeletion/no-leakproofyet.

ManualworkspacecodexsessionstartedthroughnormalACPselect_agent, durablepromptassistantOK/nodecompletedend_turn; activitycallbacks404leavestale prompting, sleepsafety409. Noidlenessbypass. Separatebacklogidea01M60YGDJJD8Z78DTBM7XC508A; nextfullsleep smokeusesnormalpinned-node tasksubmissioninstead. NormalownnodeDELETE200+GET404confirmedVMremoved09:48; onlyemptyownprojectretained. NoPR/productionmutation.

Owner-token integration correction: use validated management JWT subject, matching the actual API signer; never grant authority from the optional userId payload. Body/config owner and exact workspace/node/incarnation fences remain. Actual-wire regression covers valid subject without userId plus foreign/missing subjects borrowing userId, with no unauthorized intent or artifact mutation. Focused Go race15.590s/vet and independent Go/security review passed. Typed HTTP status diagnostics preserve409 without persisting raw response bodies; 9 API suites/127 tests and scoped lint passed. New complete staging lifecycle evidence remains pending.
