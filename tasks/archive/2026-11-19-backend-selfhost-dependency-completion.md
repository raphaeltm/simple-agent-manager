# Complete backend and self-host dependency PRs

SAM task: `01M7RJ316H7BABN9QTW6M3KMRH`.

## Problem and scope

Complete existing PRs #2891, #2892, #2893 and #2896 sequentially, preserving branches and history. Merge only after all applicable gates. An isolated major requiring coordinated migration may instead be closed with evidence and a preserved SAM idea. No force pushes, branch deletion, paid overage, resource-default changes or secrets readback in Actions.

## Research findings and preflight

- #2891: go-smtp 0.25.1 to 0.26.0. The GitHub compare view includes BDAT fixes already backported in immutable v0.25.1; direct downloaded-module diff confirms those are retained compatibility behavior, while v0.26.0 changes Postmaster parsing and moves DELIVERBY/MT-PRIORITY from RcptOptions to MailOptions. SAM enables neither extension and uses neither moved field (`deploy/selfhost/sam-mx/main.go:newServer`, `session.go`). Existing receiver harness uses real TCP SMTP and HTTP gateway boundaries with DNS fixtures. BDAT compatibility controls pass both versions; Postmaster reaches SAM rejection only on v0.26.0 (501 parser rejection before, 550 SAM rejection after). Verify accepted/rejected mail, repeat transactions and new BDAT behaviors under race/vet.
- #2892: runtime Alpine 3.22 to 3.24. Verify actual image compatibility with pinned libcap-utils and unprivileged port 25 before deciding.
- #2893: isolated builder Go 1.27.3 while module and repository require 1.26.11. Reconcile supported coordinated strategy and Sonar findings before deciding.
- #2896: client-s3 updated alone, presigner remains older. Reproduce strict type mismatch and align compatible SDK versions without casts; exercise presigning/artifact boundaries.
- Classification: external-api-change, security-sensitive-change, infra-change. Primary upstream source for #2891: GitHub emersion/go-smtp v0.25.1...v0.26.0 comparison. No new interfaces/configuration intended; search affected docs for version/behavior references before commits. Dependency pins and test fixtures introduce no new runtime knobs.
- Coordinate self-host box use with current owner; both staging leases must be checked before use. Fresh PR head/checks/comments/reviews/threads, all association pages, exact URL/branch owners and linked tasks required before editing each PR.

## Checklist and acceptance criteria

Release acceptance (the first three PRs have completed these gates; #2896 release gates below remain pending):
- [ ] Reconcile fresh GitHub and SAM ownership/evidence.
- [ ] Validate compatibility and diagnose all failures; implement smallest complete fix or supported documented closure.
- [ ] Run applicable tests/build/race/vet and actual runtime verification; record totals and limitations.
- [ ] Complete independent domain/security/task-completion reviews and resolve findings.
- [ ] Request CodeRabbit on ready candidate and record result; all CI and Sonar gates pass.
- [ ] Complete applicable staging/self-host evidence with coordinated leases and cleanup.
- [ ] Verify final merged/closed GitHub state, preserve branch, monitor applicable deployment, update SAM ideas and maintenance.pr-shepherd.

PR completion:
- [x] #2891
- [x] #2892
- [x] #2893
- [ ] #2896

References: `.agents/skills/do/SKILL.md`, rules 02/05/09/13/14/25, constitution principles II/X/XI/XII/XIII; `tasks/archive/2026-11-18-l21-smtp-sign-in-selfhost-inbound-email.md` for receiver flow and prior box evidence. Every checkbox requires concrete test/runtime/GitHub evidence before completion.

## #2891 evidence (complete)

- Original head 3233d51bba069b30605874d4f31d67a4374e9a93 reconciled with all threads/owners/associations; normal merge from main, four protocol controls added. 39 receiver race tests, vet/build, 212 self-host tests, 110 SMTP/real-receiver vertical tests and six workerd tests passed; Docker nonroot port25 proof passed.
- Independent Go/security/completion reviews PASS/ADDRESSED; upstream compare claims corrected against immutable sources. Candidate afa800bac269d4622e688a84239e27379bbc1281 CI44523195754 attempt2 passed; CodeRabbit explicit Review skipped, no findings.
- Coordinated BOX proof reached real Worker gateway verdict; unsigned mail refused before gateway. Accepted live task/reply not exercised on fresh BOX; automated vertical tests cover it. All config fingerprints restored, temporary image/container/access cleaned, BOX released to H2. Staging44523357951 succeeded, workflow Playwright12pass/1optional skip; authenticated API smoke/signout200, zero new/growing error groups. Pre-existing noise waived per Raphaël 2026-11-18. Lease released44526616931.
- Merged at12:48:43Z as efe96eb12ab74ae467f9ce8349f361aa2913ef31. Original branch unexpectedly disappeared after merge; restored with ordinary non-force push and independently verified at reviewed afa800bac. Main CI44527364370 passed attempt2 after one Ubuntu package timeout retry; production44532642501 succeeded with container rollouts/health. Independent API health200 healthy and app200 at13:37Z. No active lease or BOX resources remain.
- No public docs reference the old pin; no user-facing SAM interface/configuration changed. Task remains active for remaining PRs.

## #2892 evidence (complete)

- Fresh original head 3e80b0aa96013dc0dbb22f6528419af6239c9d08 on original Dependabot branch. No review threads/reviews/closing issues or competing owners; all association pages empty before own claim. Search found own assigned task only as relevant owner, no matching SAM idea. Main merged normally, retaining history and #2891 receiver controls.
- Sonar API reported exactly two docker:S8431 maintainability issues AaHwH2bn54NAEkiABVQ_ and AaHwH2bn54NAEkiABVQ-: FROM tag plus digest. Both references now use the same immutable digest as sole authority, with version comments. Runtime changes to original Alpine3.24 digest; builder remains exact Go1.26.11 digest. No suppression or gate waiver.
- Original and final Dockerfile builds passed. Actual runtime /etc/alpine-release is3.24.4; libcap-utils2.78-r0 installs/setcap succeeds, then libcap tools/libraries removed. Final image UID7102:7102; read-only/no-new-privileges, cap-dropALL/cap-addNET_BIND_SERVICE, 512MiB/128pids smoke binds internal25, EHLO250, relay/Postmaster550, unsignedDATA550 without gateway, trusted fixtureDATA250 through HTTP with exact payload/auth. Test containers removed. Fixture-only trusted control does not claim real Worker task acceptance.
- 39 receiver tests passed race; vet passed; self-host15files/212tests passed. Local smoke assertion assumptions corrected (Docker CAP_ normalization and trusted auth label); final smoke passed without product changes.
- Configuration-only Docker FROM changes: Cloudflare app artifacts and VM provisioning are unchanged; live verification targets the exact receiver image on the coordinated existing BOX rather than an unrelated Cloudflare redeploy or new VM. H2 released BOX at sequence405; own bounded claim406 followed a fresh channel reconciliation.
- Independent domain/security/task-completion reviews passed implementation/local validation; A/B/C/F pass, D/E N/A. CodeRabbit label workflow44536122386 skipped; trusted main workflow44536259494 requested once, explicit Review skipped reply at13:43:35Z ended wait. Auto-review also reported no bot seat; no paid change requested. Sonar fresh analysis passed with zero new/accepted issues and zero hotspots.
- Actual Alpine candidate ran on BOX at unchanged clean checkout e7ac643b18f4ca864e403d33f7fbcf7a1a5e8fe8. Enabled inbound through original deploy exit0; two consecutive trusted loopback messages received real SAM gateway550 Unknown address, unsigned mail550 before gateway. Postmaster550 and valid agent RCPT250; UID7102/read-only/no-new-privileges/capability/memory restrictions confirmed. No configured trigger was available for accepted live task/reply; existing automated vertical tests cover that path.
- Restored original .env and actual deploy exit0; .env/secrets.env/gateway.env fingerprints all byte-identical, checkout unchanged/clean, four original containers up, API health200 healthy. Candidate image/container, private configuration snapshot/log directory and remote scripts removed. Script cleanup initially hit ownership mismatch after successful restore; root-scoped unlink resolved it and absence was verified. Own temporary SSH metadata key absent and firewall404 verified, local key removed. Empty metadata-created OS account sam2892 has no authorized key. BOX released after these checks.
- Final head a48737d13f6e94ef267c545784fdbb6a5f0ea5cb passed CI44538336721 and Sonar. Merged2026-11-19T14:08:51Z as512fc11bcbce6694bed11780a1a4d4643a21da71. Original branch restored by ordinary non-force push after bot cleanup and independently verified. Main CI44540614441 and production44542854669 passed; independent API health200 healthy/app200 at14:42:07Z. No resources remain held.


## #2893 evidence (documented closure complete)

- Fresh head217b3fb1680cb3b01f37d99cc1173c18db66e950 reconciled against all comments/reviews/threads/closing issues, exact branch/URL owners, all association pages and linked-task search. No competing owner or held artifact. Dependabot had already closed it unmerged at2026-11-19T14:11:09Z after the digest-only FROM change; its up-to-date message is not evidence that Go1.27 shipped.
- Original diff changed only the receiver builder from1.26.11 to1.27.3. Current builder digest, receiver module directive and CI GO_VERSION remain1.26.11. Chosen authorized disposition: keep isolated upgrade closed and evaluate a coordinated toolchain migration. No compiler incompatibility is claimed; the official Go toolchain documentation distinguishes minimum language version and selected compiler.
- Exact historical Sonar findings were two docker:S8431 tag-plus-digest issues, not compiler failures; equivalent fixes passed in #2892. No failed historical check was waived to merge a closed PR.
- SAM idea01M7T479B8HS7D7MEN2RZG127Z preserves migration and digest-update tracking follow-up, linked to PR/chat and re-read. All three independent domain/security/completion closure reviews passed. Evidence comment: https://github.com/raphaeltm/simple-agent-manager/pull/2893#issuecomment-7012478845.
- Original branch had been deleted by bot closure; restored exact217b3fb with ordinary non-force push, independently verified. Final state closed/unmerged; no runtime change, deployment or new CI needed for closure.

## #2896 evidence (implementation complete; release gates pending)

- Fresh original b0d6dcaadac08d7d49b66ab4f75f1881525e161d on original Dependabot branch; all threads/reviews/closing issues empty, no competing owner/association, own task is only relevant active owner. Claimed after full reconciliation. Current main merged normally; no history rewrite.
- Reproduced strict TS2345 with the original dependency split in the app-deployment build: client3.1169.0/Smithy types4.20 versus presigner3.1141.0/Smithy types4.19. Four real getSignedUrl call sites failed, matching the reported failure. Actual package is packages/app-deployment; original task used a plural path.
- Aligned s3-request-presigner to client3.1169.0 in the catalog and regenerated the lockfile. Registry metadata confirms matching Smithy types^4.20 requirements; pnpm why now reaches only Smithy types4.20.0 from app-deployment. No overrides, casts/suppressions at SDK boundaries, compiler changes or production application logic changes.
- App-deployment strict build and typecheck pass; package14files/192tests pass. Existing real TCP upload/HMAC verifier covers nonempty context body, signed length/SHA metadata and tamper controls. Two added real-SDK tests independently verify build-context GET and per-service artifact PUT/GET signatures, prefix/bucket/key/TTL binding, and wrong-key/method/query controls. Operator path-style fixtures and Cloudflare virtual-host fixture are both exercised. These signature fixtures do not claim actual S3 object persistence.
- API dependency build13tasks passes. Focused API presign/config/attachment/artifact-boundary suites: 5 files / 84 tests passed; final ESLint passed. All three independent domain/security/task-completion reviews PASS; completion A/B/C/E/F pass locally, D N/A. Actual staging upload/download, current CI/Sonar/CodeRabbit and final merge/release verification remain pending. Implementation task archived after the Phase4 validator as required by /do; this does not mark #2896 or the overall SAM task complete. Pending release gates remain tracked in the PR and .do-state.md.
