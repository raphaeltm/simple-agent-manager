# L24 self-host operations

## Problem

Land backup, restore, upgrade checks and teardown from `sam/selfhost-pass-2` onto fresh main without importing unrelated self-host features. Fix F22/F23/F24 and include #2703 teardown error handling.

## Research and preflight

- Classes: security-sensitive, infrastructure, cross-component, business logic, documentation.
- Main base `917077fef` includes L22 deploy/upgrade harness; operations are otherwise only on integration. Paths imported with `git checkout origin/sam/selfhost-pass-2 -- <paths>`, never cherry-picked.
- Backup directory contains Worker secrets in bucket manifests, platform keys, environment and state. Encrypt complete backup tree with separate operator key, reject CI use, sanitize failures. Policy 795e72a6 applies.
- Historical backup live-copy races and gcloud tracker failures are hypotheses until reproduced on BOX (#2675/#2677).
- celld native manifests flatten DO migrations; compare deployed classes and canonical generated migration history before deployment. Include H2 `selfhost-hosted-git-v1`.
- Shared unowned firewalls cannot be deleted safely; new self-host creation receipts must prove immutable resource identity and installation/environment scope before delete. No name adoption.
- `--keep-data` must retain WIF identities, data and key access. Compose identity must be unique per install.
- s3 operator signing region is already validated by main box-settings.ts; retain regression coverage/docs.

## Implementation checklist

- [x] Port and trim operations paths only; keep all self-host code under deploy/selfhost or scripts/selfhost.
- [x] Encrypt all persisted backup payloads; external key, authentication, failure cleanup and secret-free diagnostics.
- [ ] Restore only into empty target, validate all encrypted payloads before mutation; verify actual data round trip.
- [ ] Reproduce backup failure on BOX, fix evidence-based cause and add regression.
- [ ] Upgrade preflight rejects unknown/reordered DO tags, including H2; valid check passes.
- [ ] Automatic upgrade rollback restores previous consistent state and reports rollback failure clearly.
- [x] Unique compose projects, exact ownership proof for destructive operations; no legacy adoption.
- [x] Keep-data retains data plus needed identity; permission errors remain visible, never treated as absence.
- [x] Documentation and CLI command wiring updated, including S3 region.
- [ ] Relevant automated checks; independent security and task-completion reviews on current head.
- [ ] BOX claimed after FREE; real backup, disposable restore with data verified, passing/refused upgrades.
- [ ] Disposable owned teardown proven; all resources cleaned, BOX healthy, BOX FREE posted.
- [ ] Merge latest main, current-head CI/CodeRabbit/reviews, announce merge, merge, real production deploy success, SHIPPED idea note.

## Acceptance criteria

Each checklist item is required. BOX evidence must come from real operations and disposable owned resources; never teardown shared box data. No secret values in output, PR, Actions or scratch logs. Stop for any missing secret/permission. Local scratch only `.tmp/`; no sudo/apt.

## References

Idea 01M72M9AEB933ZY8269D376DKC LANDING PLAN part 6; policy 795e72a6; rule 56 destructive ownership; /do; task 01M7TTKAS78AMJ3853S5N4BYAK; channel feature.selfhost-landing.

## BOX reproduction 1 (2026-11-19 21:44–21:47 UTC)

- Claimed before access: channel sequence412/event8ef78fe4. Original BOX checkout e7ac643b, four legacy sam-selfhost containers.
- Current BOX has no backup CLI/package script after L22 trimming: first invocation exits254 (command missing), no data operation. Used historical f09a294ae backup algorithm copied to private `.tmp/l24` and actual gcloud/docker against original store.
- Historical backup failed: live pre-copy incomplete; stopped delta `gcloud storage rsync` failed; structured safe result `{ok:false, reasonClass:rsync, liveIncomplete:true}`. Wrapper captured neither exact gcloud exit code nor full stderr before yielding, so underlying F23 cause remains UNCONFIRMED. Do not infer the old tracker hypothesis is proved.
- finally restarted celld; verified all four original containers running, API health200, checkout unchanged. No config/bucket writes or candidate deploy.
- Coordinator mistakenly gave L23 overlapping claim413 from frozen history; acknowledged L24 claim412 was first. L24 yielded, BOX FREE414. L24 explicitly next after L23 releases.
- Own partial backup/code/log removed, metadata SSH key absence and own firewall404 verified, local token/private key removed. Existing saml24 OS account has no key.

## Local validation and review update

Root lint (23 packages), typecheck (38), build (19) pass. Root tests remain in flight. Encryption/operator focused68, scanner187 and realDocker2 pass (synthetic test data, disposable volumes cleaned). Final full self-host run:541pass/17fail, all upgrade-preflight setup affected by stricter CI guard; fixture repair under review. Security reviewer caught real stopped-container selection bug and service-reselection deletion; fixed with Compose --all/full IDs and exact container deletion, real stopped-container/overlay controls pass. Final candidate review and BOX gates still pending.

Final local suite after upgrade preflight wiring/fixture repairs:560tests/30filesPASS, upgrade96PASS, tsc/eslintPASS. One remaining final review volume-label control being added; live criteria still unfulfilled. Root timeout retry12/12PASS; scanner0findings, type-boundary0blocking.

## Sonar followup

Quick CI at4c41531c4 passed lint, build/typecheck, code quality, secret scan and smoke. Sonar raised45 issues (mostly function complexity/style, plus an alphabetical sort comparator bug). Refactored operations into private helpers without changing ownership/failure ordering; replaced ambiguous regex/string conversions and added parser regressions. Also fixed failure-stop customstate environment propagation with a runner-boundary assertion. Final selfhost573tests/31filesPASS, scanner187PASS/0findings, focusedWIF/teardown101PASS, upgrade96PASS, tsc/eslint/typeboundaryPASS. Independent teardown/WIF refactor reviewPASS; final security delta review running. BOX still L23; H2 newly queued afterL24 (event0c37c5db).

## BOX slot418 evidence (in progress)

Claim987d8996 after L23FREE2a876ebc. Original shared checkoute7ac643b/fourcontainers/API200. Own SSH firewall sam-l24-ssh-slot418 immutableid7663373354569745545 +metadata key, cleanup owed. Store root uniquely owned gs://sam-selfhost-vmtest-fleet/l24-01m7ttkas78amj3853s5n4byak-slot418 has random ownership marker and was proven empty before creation; never shared/celld.

F23: retrieved the original failed stopped-copy gcloud log2026.11.19/21.46.12.578974.log read-only. Trace reaches SDK523 file_download_task.execute -> posix_util.run_if_setting_posix -> set_posix_attributes_on_file_if_valid -> get_posix_attributes_from_file/os.stat, then ENOENT for local nodes/node_*.json. Log has9HTTP404 occurrences, atime/mtime POSIX metadata, no hash mismatch. SDK source proves finalize_download returnsFalse when temporary download missing, but caller ignores return and applies POSIX metadata/stat. Root failure mechanism is missing download followed by POSIX stat; tracker reuse alone remains unproved. Historical fresh retry succeeded4251objects, confirming intermittent behavior. Old plaintext diagnostic tree removed. New isolated live paths/temp cleanup/fresh full-copy fallback avoid partial-download reuse; targeted GCS POSIX ENOENT regression verifies complete final data/no partial node artifact and restarted writer.

Live found adjacent writer-selection bug: shell COMPOSE_PROJECT_NAME ignored with a legacy YAML whose name was static. Compose stop on nonexistent derived project returns0, so no writer had stopped. Fixed always-control precedence and fail-before-copy singleton running-writer observation;114 focused and full578tests, realDocker2, scanner187,tsc/eslint pass. Finalcommit/retest pending. Explicit private target env instead of shared edit yielded real encrypted backup4270objects, down4919ms, authentication success, original API200. Restore to fresh owned /restore prefix complete;4270objects including3701LTX +476statefiles SHA256 compared exactly, source receipts stripped. Restore app not started (avoid shared background alarms). Init/disposableupgrade/teardown/refusal still owed.

## BOX final backup/restore and valid upgrade

Final f546 backup:4,324objects,5,824ms downtime, authenticated encrypted tree. Fresh /restore-final prefix and fresh state:4,324objects/3,756LTX/476statefiles exactly match SHA256 inventories. No restored shared alarms started. Actual shared H2 live deployment manifest and source tags reject main's unknown/removed selfhost-hosted-git-v1 before mutation. Separate fresh main worktree/state/env/project sam-selfhost-062a6279cc37 deployed4c415, then actual upgrade to f546 passed encrypted806object snapshot, installed-vs-live-vs-target DO check and API health. Shared checkout e7ac and four original services remain unchanged/healthy.

## Ready review followup

CodeRabbit requested23:03UTC via trusted label workflow, returned review limit/rate-limit; wait ended, no findings from it. Codex review found3 issues, fixed before final candidate: retry cache deletion after transient restoration failure; executable populated-install manual rollback bound to authenticated snapshot source SHA; exact created/reused workloadIdentityUser service-account grant receipts and cleanup. Recovery now stages state before swap, retains upgrade recovery pointer, writes private exact cache-deletion progress so partial deletion can retry, refuses replacement cache identities. 53backup tests pass; deleting pending-cache consumption makes the transient-volume retry control fail (RED), source restored. Independent recovery security review PASS. Teardown diagnostic stderr/JSON never surfaces raw cloud content;3actualCLI sentinel controls pass. Clean CI deploy validation exposed unbuilt providers dependency from existing node-provider-labels import; selfhost-only tsconfig resolves provider/shared sources directly, no runtime/Worker change.

Full current review suite602tests/32filesPASS; latest manual command tests add real emitted CLI entrypoint and operator-checkout recovery on failed rollback. Disposable final rollback/teardown/cleanup and exact-head release gates pending.
