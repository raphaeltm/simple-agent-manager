# Resilient compute catalog refresh and sleeping wake recovery

Idea: `01M77P985TDMCJ28JTTQHEYMC7`. SAM task: `01M77Q6A32CJRZAE06QE8NH1YJ`.
Agent: Sol (`01KSSMJCG4EE1XS153GNZX5B09`), openai-codex.
Draft PR: https://github.com/raphaeltm/simple-agent-manager/pull/2693.
Current coordinator: `01M7CVSBR1SDZFDZNY3TD863RQ`; original coordinator `01M77NV1B621TKTV79272F7YX3` is unreachable.

## Release state — November 15

Staged and coordinator-approved source: `aeace2bea5b0ca440ab19ac748c868df249aaa35`.
Current release branch incorporates main `ef7d3af4d` with no runtime-source delta from the staged SHA.
Exact-SHA approval: [coordinator decision](https://github.com/raphaeltm/simple-agent-manager/pull/2693#issuecomment-6902429829).
Raphaël authorized shipping in chat `838d94fb-9439-4369-b7e6-f73b95c3d145` at 17:48:17Z on November 15,
message `01M7G55Z67DR47F8M0F5213C8F`: “Yes please. Let's get it shipped.”
The original `needs-human-review` label was the delegated internal coordinator gate, not an outstanding
local reviewer failure. Release still requires current-head CI and the normal production deployment checks.

R8 base Bash, strict sleep, original accepted wake during unfinished publication, same-node recovery,
and independent pre/post file preservation passed. Both raw-file reads returned HTTP 200 with the same
36 bytes and SHA-256 `efbdd5cbabc8453179700e30822a18d7250b03d67706e60a90c638471633128d`.
The original delivery reached terminal `acked` with a delivered timestamp and a completed Bash turn on
the recovered workspace; no follow-up prompt was used. Node pool revision 96 remained reusable while
current pool revision advanced to 98, with current source/credential/candidate authority revalidated.

**R8 promotion time bound missed by 82.291 s.** Promotion completed at 22:20:35.222Z through the
cleanup membership PATCH, which reached the API at 22:20:20.947Z. This trial does not prove cron-only
completion. The separate untouched legacy adoption completed automatically at 21:45:45–21:46:02Z.
Actual GCP 3,418-row promotion was 449 ms wall time / 105.7523 ms summed D1 duration (not CPU).
The conservative GLOBAL-zero request interval was 92.206 s; the reviewer accepted this target deviation
because the binding restoration cutoff was met. No full R8 pass is claimed. Screenshots were skipped
after the publication deadline miss. Slow continuation follow-up: Idea `01M7GN7PK7QVN6ZSV0CP1ZAXWZ`.

Safe evidence packet: Library `01M7GN519MFCMREMBM7QWN3ZJ3`, SHA-256
`872936f54fb74451148698a4865b13b612c33685f6c335ebccaa6bf44803e99b`.
Strict first/delayed cleanup and independent two-pass D1/GCP FREE succeeded. All owned resources,
including terminal node tombstones, are absent; exact VM/disk GETs returned 404; complete aggregate
inventories were empty. Memberships and the complete admin-settings baseline were restored. One WIF
login was used; sign-out 200, session null, and auth-cache removal were verified. All finite jobs terminated.
Snapshot D1 rows were removed by normal cleanup; independent R2 object absence is not claimed.
Release workflow [43769494662](https://github.com/raphaeltm/simple-agent-manager/actions/runs/43769494662)
succeeded; authoritative lease deployment `7811031962` is released and supersedes both prior holds.
The staging window is CLOSED. Production verification remains basic health/version smoke only;
the protected production task/chat/snapshot remain untouched.

Final completion review: checks A–F PASS with no blocking implementation findings. The release-head CI,
merge and production smoke remain explicit release gates; this archive records completed implementation
and accepted verification evidence rather than claiming deployment has already happened.

## Historical state — November 14 review revision

Main `4bdaaf61f6cecb83b6a3bab30e011257ea019710` is incorporated with a history-preserving merge, including2739 test stabilization and2740 bounded archive writes. The handler changes merge without conflict; archive metering and wake exact-write fencing are retained.
Pushed head `281da79d7407ee04f0fc1a630993ee6a04ca8b52` is being revised after the
[second coordinator review](https://github.com/raphaeltm/simple-agent-manager/pull/2693#issuecomment-6885357194).
Prior high findings are cleared. Required A–F changes are limited to pending-only catalog waits,
removing an unreachable historical-receipt path, real-runner negative controls, finite pre-begin
refresh failures, public mutation evidence and the deferred eviction comment. The minimal
account-exclusion summary correction caught by five native CI failures is explicitly in scope.
Current CI and staging evidence must follow the new full SHA. Keep DRAFT and `needs-human-review`
until final coordinator approval and the normal release gates pass.

The coordinator's engineering amendment makes catalog2693 the first standalone source/staging/release;
force2691 follows its merge. The historical combined4c73 input is retired. Staging acceptance for281da79
was withheld pending the small A–F candidate and coordinator diff confirmation; the corrected bounded operational recipe carries to the next SHA, with
an added requirement to measure the actual 3,418-row GCP promotion batch. No staging deployment,
setting override, VM or Instant resource has been created by this port. A fresh Shepherd lane handoff
and source disposition remain necessary. The Nov15 release target does not reduce any gate.

## Problem, research and authorization

An established pool became migration-pending while republishing. Healthy enabled offerings fit the
original 400millicpu /820MB /2GB reservation, but the summary hid them and recovery treated the accepted
wake as permanently impossible. The earlier publication-throughput fix left readiness/continuation deferred.
All four requested changes are authorized: retain committed capacity safely; resume refresh durably;
preserve temporary accepted wake intent; test interruption/restart/recovery together.

The data path is scheduled discovery/continuation → saved D1 work/source cursor → private candidate staging
and atomic promotion → summary/placement/current authority → snapshot claim/TaskRunner → ProjectData
activation and original durable delivery. Existing publication cursors and interruption/fencing tests are retained.
Scheduler and ProjectData extraction are incorporated rather than duplicated. New allocation plans remain
revision-fenced; running-node reuse checks current authority without rewriting allocation provenance.

Protected production conversation `113a693f-8f1c-4b3f-88d8-69fa1ee4ab91`, task
`01M72KTXWD8FJ0Z7TXKN5GF20J`, snapshot `01M72M5N2ZSBSTSADBTKXCF90V` must never be
used for a fixture, forked or replaced. Production release verification is basic health/version smoke only.
References: `tasks/backlog/2026-11-09-capacity-pool-readiness-gate-during-republication.md` and
`tasks/archive/2026-11-09-capacity-pool-publication-deadline-loop.md`.

## Checklist and acceptance

- [x] Stage private replacement sets; generation/source/pool/configuration-fenced atomic promotion; no mixed live rows or premature missing cleanup.
- [x] Retain trustworthy publication through interruption/failure; never-published pools cannot place unvalidated rows. Revocation, disabled/excluded sources, explicit removal and current user/project authority remain immediate.
- [x] Persist next action, claim/generation, first-start and last-success state. Minute continuation survives restart/lost notification independently of daily discovery, under a shared source/scope budget.
- [x] Bounded exponential backoff, finite first-claim deadline, visible exhaustion and operator signal. Daily discovery can revive failed episodes after cooldown; manual Refresh can retry sooner.
- [x] Typed temporary waits retain accepted durable message/event identity, TTL and cancellation; impossible requirements, disabled/revoked authority and exhausted unpublished refresh remain accurate actionable failures.
- [x] Expected state/attempt/generation guards make stale callbacks no-ops; uncertain VM creation is reconciled before another allocation; chat activation follows committed restore/agent-ready/handoff.
- [x] Running VM reuse and snapshot relay revalidate current authority across harmless revisions. Strict pre/post paid-allocation fences remain unchanged.
- [x] Archive exact-write fencing covers direct wake activation. Once this exact chat/workspace is durably active, completed/failed historical recovery tasks no longer withhold new prompts; cancellation and current target ownership still apply. Receipt probes never activate.
- [x] Real entry-point regressions cover initial versus established pools, interrupted multi-batch/restart, unchanged catalogs, daily-independent retry/lost notification, stale/concurrent publishers, revocation, cancellation/TTL and automatic original inbox delivery without repeated Continue.
- [x] Production-size 7,200-row indexed promotion, current migration chain and guard-deletion discrimination tests; scoped source/test specialist review.
- [x] Adopt rollback/redeploy legacy interruption despite a stale completed work row; quarantine unsafe live prefixes through full promotion; indexed minute discovery and write-authorized point adoption preserve leases, cooldowns and prior success.
- [x] Pin rollback digest incompatibility: same semantic candidate values must differ from the old main-format digest for exhaustive, partial and default catalogs; preserve the format distinction explicitly.
- [x] Final documentation/constitution review and consolidated native/Workers/full quality pass. Completion remains WARN for open runtime/release gates.
- [x] Coordinated R8 retained-publication VM wake/file chain, actual promotion timing and independent provider/control-plane cleanup; deadline deviation accepted and documented above. Earlier untouched legacy adoption supplies cron-only completion evidence. Focused tests retain Instant compatibility.
- [x] Staged exact-head functional CI, required CodeRabbit request/wait and final exact-SHA coordinator approval.
- [ ] Final release-head CI, authorized merge and production deployment/basic health smoke: intentionally pending release gates, tracked in the PR and `.do-state.md`; no implementation work is deferred.

## Review changes and discriminating evidence

- Promotion uses columnar staging with scoped conflict identity, indexed exact-issued SQL and no JSON extraction. Completed promotion releases staging rows; missing cleanup skips already-unavailable rows. Unchanged validated non-exhaustive catalogs write no staging/candidate rows; enumeration completeness participates in the digest. The 7,200-row bootstrap/replacement test uses declared indexes and a 100-bind-limited SQLite adapter. Three independent scan/pool/source mutants each produce one intended red test and restore byte-exact source. Existing 46 interleaving/fencing tests remain green. Local samples are 135/149ms versus original 242/435ms; these are not D1 measurements.
- Unstarted work has attempts/start/deadline zero. Its first claim anchors the two-hour episode. Fifteen-second base backoff caps at five minutes; the old one-minute maximum caused119 real provider calls in two hours, while the regression requires at most30. Failed-state CAS persists Admin Errors and an operator notification once; six-hour cooldown allows a later daily discovery to revive. Real daily-provider failure → cooldown → fresh-handle revival → minute publication completes without Refresh. Minute kill-switch reads are isolated and ticks log resumed/failed/skipped outcomes.
- Wake activation checks D1 archive routing and local transcript freeze before capture, then rechecks the local fence in the atomic metered transaction after awaited authority. Two actual Workers archive cases fail before the fix. Real terminal-task producer → committed wake → follow-up delivery tests fail as retry before the fix and pass after it. Active delivery uses the existing durable chat/workspace status, a synchronous local SQLite callback, one target D1 read, and no readiness self-RPC. Removing reconcile's allowWake:false makes two receipt-probe controls red.
- Never-published state checks selected source/credential authority before publication progress. Only actual pending, unexpired work (or unstarted queued work) gives a publication wait. Twenty-five real-SQL integration cases include failed/expired/missing work and a competing unselected credential. Published catalogs with unavailable picks wait only while refresh work remains pending within budget; complete/failed/expired/missing refresh work yields an actionable refusal. Actual source disablement remains terminal; user-excluded account choices retain configured-empty semantics.
- Existing-node relay/admission tests cover legacy user/project, platform and cc user/project credentials, cross-user nodes, exclusions, removed default status, higher precedence, viewer access and timestamp/config/attachment revocation. Each negative starts from a valid owner control. Thirteen mutants cause111 intended failures; all sources are restored byte-exact. Allocation/JWT boundaries are mocked in this focused suite; SQL authority and workspace writes are real.

Second-review evidence: A has26 classification controls plus the unchanged44-case CI/editor/message
matrix and43 effective-authority tests passing (113 unique cases).
D has184 native and6 actual cron Workers passing, including fixed pre-begin deadlines and one
persisted error/Notification DO alert across fresh handles and concurrent/stale claims. B/C has36
actual delivery Workers passing; deleting the runner's workspace equality and matching bind makes
exactly the new different-workspace negative red, followed by byte-exact restore and package rebuild.
The obsolete historical-helper tests were removed in native and Workers suites; primary readiness,
interruption and generation-fencing tests remain. Current remaining wake-native4 suites pass109.
Consolidated8 Workers pass93 cases in258.09s; final scoped lint and full API typecheck pass before push. Earlier62-task full
quality and7200-row results belong to281da79 and remain historical. Counts overlap and are not summed.

Current281 CI failed five native assertions because account exclusions were treated as source
disablement; the minimal count correction retains the original tests. Its unrelated touch-only visual
scenario failed at clear.click after CDP touch (known flake), tracked01M7E4GCYJ2NHSBQV3KCDX110H.
Temporary clear.tap proof passes4/4 viewports with unchanged timeouts/assertions; original bytes are
restored. Coordinator excludes this change unless the new candidate fails at the same place.
CodeRabbit trusted request43649014451 at22:36:48UTC produced101-file-limit skip6885290634;
15-minute observation completed with no formal review. No repeat trigger or waiver is needed.

Nonblocking second-review followups: unchanged small catalog/staging retention/cleanup cursor
01M7E45G42MTTY2QF6DHMA1PWV; correlated plan coverage01M7E45GT7X31TVJ6927QS5524;
credential re-save bootstrap01M7E45HGVM7ASNJC58FPXP68K; lost activation then terminal task
01M7E45J6B12T1384H1506HD4Q; daily fairness/cooldown01M7E0QEZ3NJQ199S1RTFK20JY;
local archive source-intent regression01M7E0QGC85R1X67X7EQMMGXCX. Bare eviction/no UI wait record
remains01M7E0QC19VCAHN64XQCFCTMW1 and is cited at the callback. All are linked to the canonical idea.

## Latency and throughput budget (rule81)

Defaults: one-minute ticks; eligibility backoff15s doubling to300s;180s crash lease;20s shared work
budget per pass and20s per-source publication budget;2h episode deadline from the first claim;
6h failed cooldown before daily discovery may start another episode. Work, retry, lease, deadline and cooldown budgets use admin-editable settings; the one-minute cron is deployment-configured.
Queue residence does not spend the episode budget; retry never retimes a started deadline. Eligibility
is not delivery: add the next tick, and a crashed claim first waits for its lease. A saved retry may
therefore wait up to five minutes plus tick quantization. Provider calls attempt to abort at the remaining deadline; an already-started atomic D1 batch can
finish after a pass. The budget also prevents starting more work.

At7,200 materialized rows/source and200 rows/batch, a replacement needs36 staging requests,
about36 durable cursor writes and one promotion transaction: roughly73 write round trips. Assuming
0.5s/write gives36.5s of write work, excluding reads, fetches, scheduling and promotion processing.
One source can therefore need two default20s passes under that assumption. Local SQLite timing is
not a network, Worker CPU or D1 writer guarantee; real staging must measure the3,418-row GCP batch.

Default discovery page51 scopes (25 users +25 projects +installation), one changed source each:
51×36.5/20≈93 minutes at full20s/minute utilization is an optimistic throughput lower bound.
Two sources/scope give≈186 minutes; the maximum401-scope page gives≈732 minutes (12.2h), before
overhead/backoff. Concurrent due scopes can fill ticks, but fairness, backoff and shared budget make
actual completion slower; large started episodes can exhaust visibly while queued episodes have not
started. These calculations do not promise all scopes finish within two hours. Forcing one200-row
batch per pass needs36 claims: the first35 backoffs total15+30+60+120+240+30×300=9,465s
(157.75min), already beyond2h before tick quantization. That diagnostic setting must be restored
promptly in the staging recipe; it is not a sustainable production throughput setting.

## Rollback/redeploy interruption found on staging (2026-11-15)

Exact staging deploy43711661347 and all smokes passed at2f04b03f54affadc220f0df5c63ef27b42abc889.
Before allocation, the real readiness guard found poolR95 migration pending and a legacy GCP cursor
stopped at3,000/3,418, with zero private staging rows and an older completed refresh/gen6. The prior
83705cb4 build had begun its in-place refresh during12:00–12:01; the new build returned afterward.
This models a production rollback followed by redeploy. Previously it stayed pending until a daily
refresh or a human Refresh, while the retained marker incorrectly trusted half-rewritten rows.

The successor adopts active pending pools with unfinished legacy cursors even when completed work
already exists. The existing generation/attempt/lease CAS and first-claim deadline remain authoritative.
Only the optional cursor `atomic:true` proves that incomplete writes used private staging; inherited
legacy unsafety survives changed digests and every partial write until full promotion succeeds. An
older parser ignores the extra field and its older writer omits it; completed old-format cursors
release quarantine normally. Current staged refreshes retain their valid committed catalog. Failed
or expired work remains non-retryable; a separate unfinished-publication diagnostic reports quarantine.

Minute adoption still uses idx_capacity_pools_migration_state, scoped source indexes and exact settings
PK lookups. It replaces one existing SQL request per tick, not one request per pending pool; an empty
continuation pass still uses adoption plus the due-work lookup. The quarantine projection adds no SQL
round trip to a summary. A write-authorized placement hitting a mirror-complete unsafe pool queues
that exact pool by PK and uses RETURNING to acknowledge its fenced write. If another owner wins,
one narrow refresh-state lookup observes pending/failed/expired state. The original candidate and
credential-authority reads run once; no synchronous provider refresh occurs. Measured selection
helper totals are10 executions read-only,11 on adoption and12 on a conflict/no-op; these exclude
the caller's existing route/authentication work, not a claim that the whole task route costs12.
ensure=false does no writes. Operator candidate edits call reconcileDefaultPoolStatus and can create
that complete mirror. Idle-only background discovery remains daily (up to24h plus publication), tracked
as known-temporary Idea01M7FN82782X6K04SEHF6JBY2E; accepted placement demand queues it immediately.

At3,418 materialized rows and200/batch, fresh rebuilding requires18 staging writes, about18 cursor
writes and one promotion transaction:37 write round trips. At the stated0.5s/write assumption this
is18.5s of writes, excluding reads/provider/preparation/promotion; it can exceed a20s pass and needs
continuation. Adoption normally starts on the next one-minute tick, with the existing180s lost-claim
lease and≤300s eligibility backoff. If forced to one batch/pass,17 backoffs total4,065s (67.75min),
plus≤17min tick quantization; aggregate contention/other I/O can exhaust the existing2h episode.
This is not a promise that all scopes or provider calls finish in one pass. No budget is reset by retry.

Pre-fix real Workers cron RED left generation6 and resumed only the no-row case; successor matrix
passes with all6 existing cron tests retained. Native pre-adoption quarantine/complete-failed-expired
and provider-backed private rebuild/restart assertions were red before the fix. Controlled deletion
of adoption eligibility, conflict CAS, quarantine, or sticky provenance each causes intended assertion
failures; original bytes are restored afterward. Three real point-conflict cases also assert that
the winning pending, failed and expired state controls the returned wait/error without spending
another generation or provider call. Full live wake proof remains UNMET.

Coordinator I2 is now pinned before staging: candidateSetDigest documents that a rollback must
never resume past a privately staged prefix. The regression fixes the same-values main4bdaaf61
legacy digest vector and checks default, partial and exhaustive new formats differ. Removing
the format element produces the intended assertion failure; source bytes are restored. All47
publication interruption/fencing/digest cases pass. No runtime behavior changes in this follow-up.

R7 stopped before project/profile/candidate/settings/VM/sleep/wake/T0. Its one login was signed out200,
session200/null and cache gone; complete provider inventories0 repeated after136s and34 managed jobs
terminal were independently accepted by Root0440c9ae. Closed12:52:43, both cleanup guards cancelledv2.
Evidence Library01M7FKVGVB97JGYG6EJ1Y0ARRM; PRcomment6894508145. New source needs full CI,
scoped review from2f04 and a mechanical recipe head/hash successor before any new live window.

## Deliberately tracked boundaries

The coordinator explicitly allowed item11 to be fixed or narrowed/tracked. Automatic continuation here
covers accepted human/event durable inbox requests. A bare eviction blocked before its first claim,
without such an inbox row, still relies on the dying VM's callback; its snapshot has NULL recovery
status/task/attempt and cron does not select it. Followup `01M7E0QC19VCAHN64XQCFCTMW1` records the
nullable-attempt ownership, cancellation/TTL and durable driver design. No automatic bare-eviction claim.

Other accepted followups: deployment/direct-workspace strict allocation boundary
`01M7DX501KMF9FNXAKAW1HD96R`; BYO/legacy existing-node contract `01M7E0QCRKYW6149XY3CT3DR4D`;
read-only viewer hydration side effects/project scope `01M7E0QDHREA8Z8PAA4DQ106D6`;
admin setting floors/combinations `01M7E0QE8CN2RRS8FNMEV0ZPMV`; daily failed-discovery fairness
`01M7E0QEZ3NJQ199S1RTFK20JY`; async refresh/wake UI feedback `01M7E0QFP9FSV6HRDYG9YH0NKX`;
remaining producer-driven coverage `01M7E0QGC85R1X67X7EQMMGXCX`. These are linked to the canonical idea.
Deployment linking/volume relocation mixes existing and pre-create/stopped-node authority and remains
strict; explicit-node POST/workspaces can refuse old revisions before final admission. No blanket
allocation relaxation or exactly-once external-effects guarantee is made.

## Release and staging evidence boundaries

The chosen live case is retained-publication: an established pool remains placeable while replacement
stays private, ordinary cron completes, and the original accepted wake/context returns without repeated
Continue or recovery Refresh. Bootstrap/crash/blocked-wake/races are actual Workers/SQLite tests,
not live provider-crash or abrupt isolate proof. The operational recipe uses normal APIs, one intended
2vCPU/4GB GCP VM (maximum two alive), a short sequential Instant run,20-minute total ceiling including
cleanup, and conservativeUSD0.85 underUSD1 estimate. Fresh quote/authority, all-in cost/headroom,
exact admin/candidate CAS restoration, actual lane handoff and independent provider absence plus
late control-plane cleanup are required. No SQL fixture mutation, fake callback or production trial.

## Deployment runner prerequisite and final reviewed boundaries (2026-11-15)

The preaccepted touch-only successor `fab996fec01b9816a3aeefa9a43089b9c5d4d585`
passed every functional CI job, including 735 visual tests (76 skipped), native tests and all
Workers shards. Its one-line `clear.tap()` change followed the same visual failure on both earlier
candidates. Local runs passed before and after, so they do not establish causality; the pinned CI
result is the observed validation. The draft/coordinator marker still blocks release.

GitHub's Ubuntu 26.04 runner migration then blocked deployment independently of this feature:
immutable cgo VM-agent bytes differed and Playwright could not install Chromium. Exact upstream
PR [#2744](https://github.com/raphaeltm/simple-agent-manager/pull/2744) pins the deploy and browser
jobs to Ubuntu 24.04. Its commits `b39c0a33e2098728b304d1466f38f82e07888352`,
`a0f07c6ebc7a57032501db0bc6b052d7468ee21a` and `74877d405f4bd7ea217a18dd14b648757085b9bf`
are incorporated with cherry-pick provenance. Its exact staging run
[43659373700](https://github.com/raphaeltm/simple-agent-manager/actions/runs/43659373700)
passed deployment and all 12 smokes; this validates the runner prerequisite, not this feature's
required live catalog/wake lifecycle. Focused workflow validation passes 167 tests in four suites.
All API, package and script bytes remain identical to the functional-CI-green predecessor.

A completed publication that changes offering metadata (price or disk) still invalidates a new
allocation already in flight under the existing revision/authority fences. The coordinator accepted
that pre-existing boundary outside this PR; retained committed catalogs and authorized existing-node
reuse are protected here. Two separate ideas retain the self-host R14 evidence without claiming
main/staging reproduction: `01M7EB64WBBRSZJJ0M08M8APNM` (price versus allocation authority) and
`01M7EB88QA1P81MFT9T389BZFB` (node stuck destroying after compensation). No extra source change or
live fixture was requested for them.

The successor still requires its own full-head CI and coordinator source acceptance, a later actual
Shepherd staging handoff, the bounded catalog/wake/Instant run and strict provider cleanup, and final
coordinator release approval for that SHA. Keep the PR draft until that approval. Preserve the chosen
Sol/openai-codex identity. Production verification remains basic health/version smoke only.
