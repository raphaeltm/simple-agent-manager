# Resilient compute catalog refresh and sleeping wake recovery

Idea: `01M77P985TDMCJ28JTTQHEYMC7`. SAM task: `01M77Q6A32CJRZAE06QE8NH1YJ`.
Agent: Sol (`01KSSMJCG4EE1XS153GNZX5B09`), openai-codex.
Draft PR: https://github.com/raphaeltm/simple-agent-manager/pull/2693.
Current coordinator: `01M7CVSBR1SDZFDZNY3TD863RQ`; original coordinator `01M77NV1B621TKTV79272F7YX3` is unreachable.

## Current state — November 14 review revision

Main `4bdaaf61f6cecb83b6a3bab30e011257ea019710` is incorporated with a history-preserving merge, including2739 test stabilization and2740 bounded archive writes. The handler changes merge without conflict; archive metering and wake exact-write fencing are retained.
Pushed head `fe6019eff0fcedc29eabe0958b88d413496a6163` passed all functional CI; coordinator reviews
[part 1](https://github.com/raphaeltm/simple-agent-manager/pull/2693#issuecomment-6884423659) and
[part 2](https://github.com/raphaeltm/simple-agent-manager/pull/2693#issuecomment-6884457589) requested changes.
The source/test fixes below are committed locally, with final current-main local verification complete before one new candidate push. Fresh CI and live staging remain open.
Those earlier CI results do not certify the new candidate. Keep the PR DRAFT with `needs-human-review`
until the coordinator approves the final full SHA and normal release gates pass.

The coordinator's engineering amendment makes catalog2693 the first standalone source/staging/release;
force2691 follows its merge. The historical combined4c73 input is retired. Staging acceptance for fe6019
was withdrawn after review; the corrected bounded operational recipe carries to the next SHA, with
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
- [x] Final documentation/constitution review and consolidated native/Workers/full quality pass. Completion remains WARN for open runtime/release gates.
- [ ] Real coordinated staging retained-publication VM chain, short sequential Instant compatibility, promotion timing and independent provider/control-plane cleanup.
- [ ] Fresh candidate CI, best-effort CodeRabbit request/wait, final exact-SHA coordinator approval and authorized release/production smoke.

## Review changes and discriminating evidence

- Promotion uses columnar staging with scoped conflict identity, indexed exact-issued SQL and no JSON extraction. Completed promotion releases staging rows; missing cleanup skips already-unavailable rows. Unchanged validated non-exhaustive catalogs write no staging/candidate rows; enumeration completeness participates in the digest. The 7,200-row bootstrap/replacement test uses declared indexes and a 100-bind-limited SQLite adapter. Three independent scan/pool/source mutants each produce one intended red test and restore byte-exact source. Existing 46 interleaving/fencing tests remain green. Local samples are 135/149ms versus original 242/435ms; these are not D1 measurements.
- Unstarted work has attempts/start/deadline zero. Its first claim anchors the two-hour episode. Fifteen-second base backoff caps at five minutes; the old one-minute maximum caused119 real provider calls in two hours, while the regression requires at most30. Failed-state CAS persists Admin Errors and an operator notification once; six-hour cooldown allows a later daily discovery to revive. Real daily-provider failure → cooldown → fresh-handle revival → minute publication completes without Refresh. Minute kill-switch reads are isolated and ticks log resumed/failed/skipped outcomes.
- Wake activation checks D1 archive routing and local transcript freeze before capture, then rechecks the local fence in the atomic metered transaction after awaited authority. Two actual Workers archive cases fail before the fix. Real terminal-task producer → committed wake → follow-up delivery tests fail as retry before the fix and pass after it. Active delivery uses the existing durable chat/workspace status, a synchronous local SQLite callback, one target D1 read, and no readiness self-RPC. Removing reconcile's allowWake:false makes two receipt-probe controls red.
- Never-published state checks selected source/credential authority before publication progress. Only actual pending, unexpired work (or unstarted queued work) gives a publication wait. Twenty-one real-SQL integration cases include failed/expired/missing work and a competing unselected credential. Committed catalog temporary capacity remains retryable. Source-disabled stays terminal.
- Existing-node relay/admission tests cover legacy user/project, platform and cc user/project credentials, cross-user nodes, exclusions, removed default status, higher precedence, viewer access and timestamp/config/attachment revocation. Each negative starts from a valid owner control. Thirteen mutants cause111 intended failures; all sources are restored byte-exact. Allocation/JWT boundaries are mocked in this focused suite; SQL authority and workspace writes are real.

Focused current-source evidence under `.codex/tmp/refresh-20261114/review-fixes/`: catalog59, refresh183,
authority123, classification/recovery221, wake native161, wake/cron actual Workers64 pass. Counts overlap
and must not be summed. The consolidated38 native suites passed1,445 cases and failed the old configured-empty expectation for a switched-off sole account. Its corrected complete43-case suite passes while retaining the off/on reuse/admission/picks/revision assertions:1,446 unique cases covered. The original failure is retained. Current manifests are `native-manifest.txt` (38 suites) and the parent `workers-manifest.txt` (8 suites). On integrated current main, all8 actual Workers suites pass115 cases (263.89s); full lint/typecheck/build passes62/62 tasks (3m55s,14cached), and merged-handler/config10/10 pass. Migration safety/order and runtime-boundary semantic checks pass. Tests execute against real D1/DO/TaskRunner entry points, with provider/VM HTTP boundaries mocked; these are not live provider or isolate-crash proof.
Historical port evidence includes1,280 native/110 Workers and62 local quality tasks, plus functional
CI43640124451 at fe6019. Original failed runs and corrected fixture assertions are retained; no test,
timeout, retry or production guard was suppressed. UI is unchanged in this review revision;19 rendered
UI tests and12 reviewed desktop/mobile dark/light screenshots are linked in PR comment6825123103.

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
