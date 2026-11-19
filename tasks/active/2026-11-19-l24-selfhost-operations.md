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
