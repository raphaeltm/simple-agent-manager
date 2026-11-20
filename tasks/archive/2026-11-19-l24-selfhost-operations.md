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
- [x] Independent security, documentation and implementation-completion review passed on the combined operations tree, including the comprehensive interruption/retry audit; exact release head is recorded in PR2918.
- [x] Required real BOX backup, fresh restore/data verification, valid/refused upgrade and automatic rollback passed.
- [x] Disposable keep-data/restart and two-step full teardown passed; all created resources cleaned; shared BOX healthy and BOX FREE posted.

## Automated validation

Final main-integrated self-host suite973PASS/4conditional skips across55files. The conditional skips cover privileged ownership and unavailable local nft validation; the actual foreign-owned `/tmp` preservation control passes. The entire suite also passed with `packages/providers/dist` physically absent, proving clean-checkout CLI/Vitest resolution through the explicit self-host source configuration. Typecheck, focused lint, formatting and diff checks pass. Secret scanner reports zero findings;187 scanner/exception controls passed. Real MinIO backup/restore and injected partial upload/resume tests passed and cleaned their resources. Projection, guard removal, cache retry and read-only cleanup fault controls fail when their respective protections are removed.

Repository lint23packages, typecheck38packages and build19packages passed. Root tests40/41tasks passed, with API17902passed and one timeout in an unchanged test; that entire file passed12/12 on retry. Type-boundary ratchet has zero blocking findings. Current-head CI is tracked separately before merge.

All11 earlier Codex findings were fixed with focused regressions and resolved threads. Five additional findings (interrupted Compose replacement, bundled-store restore bootstrap, completion-journal durability, conditional IAM ownership and the target health-command domain) are fixed with discriminating retries; final review reconciliation is recorded in PR2918. No further Codex request is required by the coordinator. CodeRabbit was requested through the trusted label workflow at ready23:03UTC Nov19 and returned a review-limit/rate-limit response; the wait ended on that response, with no CodeRabbit finding or waiver.

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

Latest main20675016f (Claude action dependency bump only) was merged before release. Subsequent changes cover failure/retry bookkeeping and the formerly blocked bundled-store restore path. The existing GCS happy-path projection/data and migration algorithms are unchanged. Under the coordinator’s explicit exception, those failure-only changes are covered by real-filesystem/store tests and the canonical local-store path by real MinIO, without reacquiring BOX. Current-head specialist/CI evidence and merge/deploy receipts live in PR2918 and `.do-state.md`.

## Comprehensive interruption and retry audit

The final audit traced backup, restore, upgrade/rollback and keep/full teardown through interruption and retry, rather than addressing only review examples. Backup restarts its exact writer even when stop returns failure after taking effect; copied read-only plaintext scratch is removed without following symlinks or changing foreign directories. Surgical controls confirm both protections are necessary. A killed process still requires documented operator inspection/restart and a fresh destination.

Restore durably records ownership before target writes, re-syncs a surviving journal on retry, and retains a durable completion receipt before unlinking progress. Real filesystem fault tests cover initial write/file-sync/directory-sync, completion link/unlink/sync and torn state copies. Only exact authenticated state prefixes may resume; bucket objects require complete equality. Read-only `--print-project` authenticates first and allows the canonical bundled store to bootstrap under the final projected identity; strict runtime inspection refuses app/foreign containers and mismatched mounts, labels, config or images. Three real MinIO tests cover canonical Compose with custom ports, restore, real deployment init, retained volume/data and actual app-container refusal. The pinned store healthcheck now uses its configured IPv4 port. All containers and named/anonymous fixture volumes were removed with exact ownership proof.

Upgrade persists a snapshot-bound cache recreation intent before Compose. Partial container/volume creation, failed command response and failed inspection can recover only with exact project, service, paths, mount and creation-time proof. Ten boundary faults, three encrypted repeated-attempt scenarios and changed-target A→B→C controls pass; no replacement cache is adopted without its durable intent.

Teardown durably records original Docker inventories, key-removal authorization and backup inode proof before mutation. Partial deletes and lost receipt saves resume only remaining original resources, while replacements refuse. Atomic grouped tombstones halt later destructive steps on save failure; identity survives key/env cleanup, and exact absent IAM grants settle lost-success responses. Eight teardown files/81 tests include actual CLI filesystem faults and Docker/IAM adapters. The audit matrix is retained locally with PR evidence; no new BOX/cloud resources were used.

## Final main integration and IAM review delta

Final Codex review identified a conditional project IAM binding misclassified as reused before `--condition=None` adds an unconditional grant. Bootstrap now validates binding/condition shapes and marks only an existing unconditional grant as reused. Teardown removes only the receipted unconditional member/role, leaving conditional siblings unchanged; lost-success retries recognize that exact unconditional grant as absent. Nine actual bash controls cover conditional-only, unconditional and malformed/unparsable policy cases, with independent security delta PASS. The existing bootstrap test fixture now uses exact cleaned `.tmp` roots.

Main L23 `860718dc3878095322772c43cc7d385ba35aeb16` was integrated before final CI, preserving fence fingerprint/force recreation and filtering image rebuilds against old active services. Integration exposed its exited data-owner helper retaining Docker’s cache-volume reference; recovery requires exact owned-helper cleanup before deleting that cache. Real Docker helper recovery (one test) and canonical local MinIO (three tests) pass with owned resources cleaned. The final combined suite passes986tests across56files, with four conditional skips; TypeScript, lint, formatting and secret scanner pass. The test fixtures model the new helper metadata boundary and follow canonical-project setup before repeated init.

The coordinator explicitly accepted that the combined L23+L24 upgrade has not been proven live before merge: this self-host-only integration has no Cloudflare impact. **Owed: coordinator post-merge combined smoke**, tracked on landing idea01M72M9AEB933ZY8269D376DKC: after both H2 #2907 and L24 #2918 are on main, upgrade from the then-current BOX state to main, recreate the fence, verify health and trigger one rollback. Real Docker and MinIO remain the pre-merge proof; any upgrade/rollback failure remains this slice owner’s follow-up responsibility. This is an accepted validation gap, not a claim that the combined source is byte-identical to BOX39.

An incremental review also corrected the printed health check to use the shell-quoted target domain read from its private .env, instead of an unexported shell variable. The actual CLI regression clears the shell variable and verifies the emitted target URL; five CLI tests, typecheck and lint pass. Independent security/completion/docs delta review passed; operation and data algorithms are unchanged.

## Durable grant intent review delta

Project and service-account IAM mutations now persist exact unconditional grant intent before cloud mutation using the existing ownership ledger. File sync, atomic rename and parent sync complete first. Interrupted or lost-success retries preserve created ownership; preexisting grants remain reused. Changed scope/account identity, malformed pending intent and explicit conditional teardown receipts refuse. Thirteen new controls cover actual bash termination after side effects, final receipt failure, sync failures before cloud mutation, safe retry/recreation and conditional sibling preservation. Full self-host validation: 986 passed, four conditional skips, 56 files; TypeScript, lint, format and secret scanner pass. Independent security review found no blocker.

The coordinator explicitly deferred the pre-existing pool/provider/service-account/firewall post-create receipt windows to backlog idea 01M7VB4538WSGP3QBP8EBDVTZA. README teardown now lists manual inventories and requires immutable identity, audit-log and exclusive-use proof. Such resources are preserved rather than destructively adopted. A leaked firewall retains precisely the configured source ranges, target tags and ports; interruption cannot broaden them, though their original exposure persists until proven-owned cleanup.

## Post-mortem

Plaintext backups, missing rollback/history validation and name-based lifecycle assumptions were unsafe. Real SDK failure evidence replaced the unconfirmed tracker hypothesis. Real disposable execution exposed read-only cache cleanup and executable-mode loss; both have discriminating regressions. Review added clone identity isolation, inactive restore deployment, durable retries, exact backup deletion proof and retained-key retry ownership. Clean CI exposed an unbuilt workspace-package dependency that locally built output had hidden; the full suite now proves source resolution with that output absent.

## Rollback state-swap interruption delta

Automatic review 4638273658 exposed a process-kill gap between moving live state aside and recording the replacement inode. The same emitted rollback command reproduced both missing-state and stale-ledger failures. The replacement ledger now binds its new inode before publication; a private sibling swap receipt durably binds installation scope and original/staged directory identities before either rename. Automatic, explicit and direct recovery reconcile that receipt before reading installation metadata. An interrupted cleanup retains the proof; replaced or symlinked directories and receipts refuse before destructive work.

Ten real-CLI scenarios cover uninterrupted recovery, SIGKILL after receipt publication, each directory rename and stage removal, plus foreign previous/live/stage/restored inodes and a symlink receipt. Every retry uses the same printed command and state path with spaces. Tests assert preserved upgrade/cache pointers, restored bucket/state, the new ledger inode, exact scratch cleanup and refusal before cloud/cache mutation. The two rename controls failed on the original implementation and pass with the fix. Existing BOX evidence and the coordinator-owned post-merge combined smoke remain as recorded above.

Final delta validation: full self-host suite 995 passed, four conditional skips, 56 files; TypeScript, focused lint, formatting, diff and secret-readback scanner pass. Independent security and completion/documentation/constitution delta reviews pass with no unresolved finding. FIFO receipts refuse before opening and malformed key diagnostics withhold source contents.

## References

PR https://github.com/raphaeltm/simple-agent-manager/pull/2918; idea01M72M9AEB933ZY8269D376DKC LANDING PLAN part6; SAM task01M7TTKAS78AMJ3853S5N4BYAK; coordinator01M7JMXS2JRW6QQMB1356ENPM3; policy795e72a6; rule56; `/do`.
