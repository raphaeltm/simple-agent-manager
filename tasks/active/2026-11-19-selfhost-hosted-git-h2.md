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


## Takeover by task 01M7TY7Z3HBTSDSSV85FPRHE1B (2026-11-19 ~21:00 UTC)

Previous owner 01M7SR1B79 stopped after repeated provider content-filter refusals; its pushed head 0eda6a2bd was intact.

- [x] Merge main 917077fef (L22c merged): conflicts only in L22c files (took main's final versions) and deploy/selfhost/README.md (kept the hosted-git section, dropped main's now-false "Hosted git: not included" bullet). Merge 553a9060f.
- [x] Codex P2 r4633317762: `reachableComplete` now walks each command into a scratch OidSet and merges into `known` only once the closure is complete.
- [x] Same class, found while fixing it: the cache-less path trusted `packComplete` + `store.has(tip)`. That is sound only if every object outside the new pack is closure-complete, but a pack whose refs were all rejected stays ingested until GC. A later push (ref-only, or a pack whose commit's parent is the stale commit) could point a ref at an incomplete closure. Every command now proves its closure with the same walk; `packComplete` and the `push_edges` helpers/table creation are removed (existing repos keep an empty, unused `push_edges` table; no DO DROP).
- [x] Real git/SQLite tests (describe "push connectivity admission"): cache-path multi-ref attack, cache-less stale-rejected-pack attack (ref-only and child-pack variants), and positive controls (overlapping multi-ref push extends the cache and a full clone fscks; shallow-clone push on the cache-less path). Both attack tests fail on 0eda6a2bd. Discrimination: A non-transactional walk -> both attack tests red; B cache-less presence-only -> stale-pack test red; C never merging into `known` -> cache control red (clone from extended cache fails fsck). Hosted suite 29/29, self-host unit 186/186, API typecheck and focused lint pass.
- Bound (rule 81): one walk is bounded by the repository caps (30,000 objects, 256 MiB stored), the 128 MiB per-request inflation budget and the 120 s git-operation deadline. Worst case is one walk over every object in the repository: at most 30,000 SQLite presence probes plus inflating the non-blob objects, completing in one attempt or failing closed with the budget error. A fresh push's walk reads the same non-blob objects `packComplete` read before.
- [x] Security delta review of d16d1538e: 0 CRITICAL/HIGH. MEDIUM-1 (failed walks not memoized, so repeated failing commands cost K x N) and MEDIUM-2 (a throw in validatePush left the ingested pack without GC; pre-existing) were fixed; LOW items were tested.
- [x] One adversarial pass over the whole push admission path (auth, parsing, limits, ingest, validatePush, commitPush, GC, status): 1 HIGH, 4 MEDIUM, 5 LOW; auth, CAS, savepoint, deletion and the earlier fixes held. Fixed in this PR:
  - HIGH: seeding `known` peeled every ref tip, inflating each under the push budget, so nine large tips wedged every later push, deletions included. Seeding now reads no objects; it uses cached peel targets only.
  - MEDIUM-2: the walk now checks the type git requires at every edge (commit.tree is a tree, parents are commits, tree entries match their mode, a tag's object matches its type header, including edges into already-validated objects). Branches refuse non-commits. A mismatch blames the referencing object, so a valid shared object is never poisoned.
  - MEDIUM-5 (part): deleting a missing ref succeeds without queueing GC; arming the GC alarm keeps an earlier armed alarm, so pushes cannot postpone GC indefinitely.
  - LOW-6: directory/file ref conflicts are refused (git transaction semantics, deletions in the same push first).
  - Per-push failure memo (BFS path to the failing oid), GitParseError rejected per command, GC queued when validation/commit throws after ingest.
- Deferred with justification to `tasks/backlog/2026-11-19-hosted-git-gc-and-ingest-hardening.md`: MEDIUM-3 (GC inflates migrated objects under the same budget, so it cannot finish past 128 MiB of uncollected inflated content; needs a raw-copy GC redesign; documented as a known limit in the README), MEDIUM-4 (delta depth not checked at ingest; git defaults to 50), MEDIUM-5 rest (GC holds the input gate), LOW-7..10. Every deferred item needs a write token for that repository and is confined to it.
- Tests: unit hosted-git-closure-walk (memo at 1201 commits / 2001 commands, parse errors) and hosted-git-push-admission (seeding reads zero tips at 1201 refs, edge types, branch rule, D/F, no-op delete, alarm arming); real git: mixed failing/valid sibling with cache, malformed commit, validation fault after ingest queues GC (one-shot read-fault hook), large tips under a 14 MiB budget, edge types, no-op delete and D/F. Every guard was mutated once and the intended tests went red (memo, parse catch, GC on throw, non-transactional walk, peel seeding, child-vs-parent blame, duplicate-edge check, D/F, branch rule, no-op delete, first-edge type).
- Request-body helpers moved to `hosted-git-body.ts` so `hosted-git-repo.ts` stays under 500 lines; GC queueing is one helper (`queueHostedGitGc`, `armHostedGitGcAlarm`).
- [ ] Fresh CI green, 0 open threads, Codex re-requested on final head
- [ ] Final BOX smoke on the exact final head over main (closes the L22c "box from main runs an agent session" criterion deferred to H2 by Raphaël)

## Independent re-verification of f9eb945ef (23:20 UTC)

A fresh security-auditor re-verified f9eb945ef. It found 0 CRITICAL and 0 HIGH. Its 400-seed differential fuzz confirmed the failure memo, the parse-failure handling, GC-on-throw, the no-op delete, the alarm and the D/F checks. Mutating the blame-parent logic to blame the child made 74 fuzz cases red.

MEDIUM-F2 was fixed: lenient parsers let a writer push a commit with `author` before `tree`, tags missing or reordering `object`/`type`/`tag`, or tree modes like `8`, and git then cannot clone. `assertGitObjectShape` now runs in the walk, so a malformed object rejects its own command. A real-git test reproduces each shape; a signed commit with continuation lines and extra headers stays accepted.

MEDIUM-F1 was partly fixed: with a valid reachable cache the walk stops at cached objects (SQL lookup, no read), and an ancestry check that exhausts the work budget counts as a forced update rather than failing the push. The dead `getPeeled` seeding was dropped. The cache-less heavy-history case and F4 (alarm error handling) were deferred to the backlog task. Discrimination was checked again: removing the shape check, the cache stop or the budget tolerance each turned its intended tests red.

## Narrow verification of 8bc9a3af4 (23:45 UTC)

The narrow verification found a HIGH regression introduced by the cache stop in 8bc9a3af4. A clone that raced a deleting push could stamp a stale reachable set as current (`saveReachable` captured its version after the walk). After GC deleted a stranded object, the cache stop admitted a push naming it, and clones failed. The same race on f9eb945ef rejected the push. Fixes:
- The cache stop is removed: admission never trusts the reachable cache.
- `saveReachable` stamps only the version its clone walk started from.
- GC invalidates the cache whenever it deletes objects.

The shape check moved to raw bytes. Lossy UTF-8 decoding hid BOM-prefixed commits and tags (clone-breaking) and falsely merged distinct non-UTF-8 names. Header sections must be newline-terminated, header NUL is refused, `.`, `..` and `.git` variants are refused, and every `100xxx` file mode is accepted. The budget-tolerant ancestry check was confirmed sound (verdict D: PASS).

Unit tests cover each fix: an absent cached parent is refused, with a control; the stamp guard; GC invalidation, with a control; BOM, unterminated, NUL, `.git` and `..` cases, plus accepted Latin-1, BOM-only and `100600` names. Each fix was mutated once and its test went red.

## Final re-verification of 77e55dbb (00:10 UTC)

The original HIGH is closed. The race reproduced in 5 of 11 runs on 8bc9a3af4 and never on 77e55dbb. No admission path reads the reachable cache, and the shape check accepts everything git handles.

New findings, fixed:
- HIGH: a leading continuation line before `tree`/`object` was skipped by the key list, but git rejects such an object. The first header line must now be exactly `tree <oid>` or `object <oid>`.
- MEDIUM: a second cold clone rewriting a stamped cache left it partial during a yield, and a push in that window could stamp the partial set valid. `saveReachable` now unstamps before rewriting.
- LOW: `git~1`, `.git:` streams, a `.gitmodules` symlink and names over 255 bytes are now refused.

Deferred to the backlog: path depth, and accepting uppercase-hex oids. Each guard was mutated once and its test went red. The real-git shape test also pushes the leading-continuation commit.

## Scoped verification of dc8e9e4c (00:25 UTC)

- Q1 PASS: the leading-continuation bypass is closed. 27 crafted commit and tag shapes went through the real Durable Object; none of the accepted ones broke a clone.
- Q2 PASS: nothing that git fsck accepts and a default clone checks out is refused.
- Q3 found two MEDIUM cache-concurrency races, both fixed:
  - Two overlapping clone saves could stamp a partial table. `saveReachable` is now single-flight through a generation counter, checked before and after every yield and before stamping.
  - A push that read `hadCache` before a save unstamped could extend the partial table. `commitPush` now re-checks `reachableCacheValid()` at commit time, before refs move.
- LOW: the `.gitmodules` symlink check now covers `gitmod~1` and `.gitmodules:` streams.

Unit tests cover overlapping saves (only the latest stamps; the superseded save stops after one batch), the commit-time re-check with a control, and the NTFS forms. Each guard was mutated once and its test went red. The admission HIGHs were independently verified closed; these last cache fixes have discriminating tests but no further review round.

## Codex threads on dc8e9e4c (00:40 UTC)

Seven Codex findings were reconciled:
- **P1 r4636317748:** at most 256 `ref-prefix` arguments are honored; past that the answer is unfiltered, as git does.
- **P2 r4636466068:** an abandoned upstream fetch stream is now cancelled, so an upload slot is released.
- **P1 r4636595142 (partly addressed):** GC drops whole unreferenced packs before inflating anything, which reclaims rejected-push packs even when migration exceeds the budget. Resumable migration is in the backlog.
- **P2 r4636595147:** delta bases are kept only while packs are kept, so migration no longer preserves delta-only bases.
- **P2 r4636595152 (deferred):** delta depth at ingest is in the backlog.
- **P2 r4636751965:** `ChunkBuffer` grows geometrically, so command-section copying is linear.
- **P2 r4636751970:** the personal token route honors `ARTIFACTS_TOKEN_TTL_SECONDS`; the test runtime now sets 900 s and asserts the expiry.

Tests: prefix cap, cancel-on-abandon with a read-to-end control, `ChunkBuffer` copy bound for 1 MiB arriving one byte at a time, GC whole-pack drop before any read, base retention in both GC modes, a real-git rejected pack reclaimed under a 2 MiB budget, and the TTL route. Every guard was mutated once and its test went red; with exact-size growth the buffer test took 95 s and failed.
