# L24 self-host operations

## Outcome and scope

Land backup, restore, upgrade checks and teardown from `sam/selfhost-pass-2`, fixing F22/F23/F24 and #2703. Fresh main base917077fef contained L22. Imported selected paths with `git checkout origin/sam/selfhost-pass-2 -- <paths>`, trimmed them, and never cherry-picked. Runtime code remains under `scripts/selfhost/` and `deploy/selfhost/`; no Worker-loaded code, bindings or migrations change.

Implementation and live verification are complete. Release administration (current-head CI, merge, production deployment and SHIPPED note) remains tracked in `.do-state.md` and PR2918 until complete.

## Research and findings

Security-sensitive infrastructure and cross-component change. Policy795e72a6 forbids secret readback/decryption in CI and secret-bearing output. Rule56 requires exact installation/environment and immutable resource ownership before destruction. Main's S3 region validation is preserved and documented: `s3://` operator stores require `R2_S3_REGION`.

The historical backup failed on the actual BOX during a stopped gcloud copy. Retained SDK523 evidence traces `file_download_task.execute` through POSIX metadata application to ENOENT for a vanished local node JSON destination. `finalize_download` can return false when its temporary download vanished, but the caller still stats the destination. Running-writer404s and incomplete copies are real; tracker reuse alone remains unproved. A fresh historical retry succeeded4251objects, confirming intermittency. The fix uses isolated live-copy paths, removes temporary download artifacts, and falls back to a fresh full copy with the writer stopped. Helper and actual CLI regressions exercise the exact POSIX ENOENT shape and data completeness; surgical fault controls go red.

## Implementation checklist

- [x] Port only the operations paths and command wiring from integration.
- [x] Encrypt all persisted backup payloads and authenticated inventory with a separate operator key; preserve owner-execute permissions, private payload modes and existing parent ownership/modes.
- [x] Refuse CI before secret reads, sanitize command failures and authenticate the entire backup before target mutation.
- [x] Restore into a fresh target; durable identity-bound progress allows only exact authenticated partial retries and refuses foreign ownership, hard links, symlinks and changed data.
- [x] Give restored targets a distinct, retry-stable installation identity while preserving cryptographic keys; project generated config and omit the active deployment pointer until fresh deploy. Source ownership receipts are stripped.
- [x] Pre-upgrade check refuses unknown/out-of-order DO tags, including H2 `selfhost-hosted-git-v1`; compare installed history, live manifest and target source.
- [x] Automatic rollback restores snapshot data/cache, code/dependencies and health. Preserve current creation/removal receipts and durable recovery proof through successful health. Handle read-only Go cache staging safely.
- [x] Persist the interrupted upgrade's resolved target; refuse changed, moved or unrecorded targets before recovery. Provide an executable authenticated populated-install manual rollback command.
- [x] Use unique Compose projects and exact live container/volume/provider identity checks; never adopt legacy names.
- [x] Keep-data retains storage, keys and WIF/service-account access; same-step failure blocks new destructive actions immediately.
- [x] Retained keys keep active ownership receipts for a later env-absent destroy-key retry. Backup deletion requires active exact directory/inventory inode/hash proof, rechecked at deletion.
- [x] Documentation matches actual key separation, restore identity, retry, migration, rollback and teardown behavior.
- [x] Independent security, documentation and implementation-completion review passed on tested source39f3fa951c104e410d1feb43123c8166580da727.
- [x] Required real BOX backup, fresh restore/data verification, valid/refused upgrade and automatic rollback passed.
- [x] Disposable keep-data/restart and two-step full teardown passed; all created resources cleaned; shared BOX healthy and BOX FREE posted.

## Automated validation

Full self-host suite648PASS/1conditional skip across36files. The root-only foreign-owner setup skips for an unprivileged runner; the actual foreign-owned `/tmp` preservation control passes. The entire suite also passed with `packages/providers/dist` physically absent, proving clean-checkout CLI/Vitest resolution through the explicit self-host source configuration. Typecheck, focused lint, formatting and diff checks pass. Secret scanner reports zero findings;187 scanner/exception controls passed. Real MinIO backup/restore and injected partial upload/resume tests passed and cleaned their resources. Projection, guard removal, cache retry and read-only cleanup fault controls fail when their respective protections are removed.

Repository lint23packages, typecheck38packages and build19packages passed. Root tests40/41tasks passed, with API17902passed and one timeout in an unchanged test; that entire file passed12/12 on retry. Type-boundary ratchet has zero blocking findings. Current-head CI is tracked separately before merge.

All11 Codex findings were fixed with focused regressions and replies; their threads were resolved. CodeRabbit was requested through the trusted label workflow at ready23:03UTC Nov19 and returned a review-limit/rate-limit response; the wait ended on that response, with no CodeRabbit finding or waiver.

## BOX evidence and cleanup

Claim slot418/event987d8996 only after L23 FREE417. Shared BOX is `app.vmtest.sam2.party`, GCP sam-box immutableid6620627785558986265. The coordinator explicitly required retaining original H2 checkoute7ac643b18f4ca864e403d33f7fbcf7a1a5e8fe8 because main lacks its migration tag. No shared teardown, rebuild, downgrade or app-data change occurred.

Final tested operations source39f3fa951c104e410d1feb43123c8166580da727:

- Real authenticated encrypted backup4521objects; writer downtime5423ms.
- Fresh disposable restore4520objects and474unchanged state files matched exact SHA256 inventories, including3951LTX files and immutable deployment objects. Separately verified new distinct/stable ID, unchanged cryptographic keys, generated-config ID projection, omitted active `deploy/current.json`, stripped source receipts and preserved executable modes. Restored shared alarms were never started.
- Actual shared H2 manifest/history refused target main's unknown/removed `selfhost-hosted-git-v1` before mutation.
- Actual disposable8f7882d→39f3fa951 upgrade passed migration preflight, encrypted snapshot and API health with data retained.
- Deliberate failed health check modified an owned GCS marker; automatic rollback restored old8f code, original marker data and health. Two health checks reached the real recovery path.
- Disposable project `sam-selfhost-062a6279cc37`: keep-data removed only own containers, retained exact volumes/state/keys/store; restart passed health/data and exact volume identity. Full removal without destroy-key retained key and active receipts; a later env-absent destroy-key invocation removed key/state payload successfully. Foreign containers and shared images stayed intact.

All18547 objects under the uniquely owned task prefix were deleted with generation conditions; existing shared bucket and `/celld` data were preserved. Removed the owned worktree, scratch tree, decrypted plaintext, backups, key,14 uploaded files, exact metadata SSH key and immutable-id-verified SSH firewall. Verified metadata-key absence and firewall404, then deleted local token/private key. Final shared checkout and four original services were unchanged, APIHTTP200. BOX FREE sequence422/eventef041954-cde5-4ebb-951f-4bbd9d95adeb; coordinator and next H2 task notified.

Latest main20675016f (Claude action dependency bump only) was merged before release. Self-host source after synchronization is byte-identical to the tested39f source; final evidence/archive changes are documentation only. Current-head specialist/CI evidence and merge/deploy receipts live in PR2918 and `.do-state.md`.

## Post-mortem

Plaintext backups, missing rollback/history validation and name-based lifecycle assumptions were unsafe. Real SDK failure evidence replaced the unconfirmed tracker hypothesis. Real disposable execution exposed read-only cache cleanup and executable-mode loss; both have discriminating regressions. Review added clone identity isolation, inactive restore deployment, durable retries, exact backup deletion proof and retained-key retry ownership. Clean CI exposed an unbuilt workspace-package dependency that locally built output had hidden; the full suite now proves source resolution with that output absent.

## References

PR https://github.com/raphaeltm/simple-agent-manager/pull/2918; idea01M72M9AEB933ZY8269D376DKC LANDING PLAN part6; SAM task01M7TTKAS78AMJ3853S5N4BYAK; coordinator01M7JMXS2JRW6QQMB1356ENPM3; policy795e72a6; rule56; `/do`.
