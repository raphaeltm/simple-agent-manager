# Authenticate platform GCP orphan reconciliation

**Current status (November15 02:11UTC): arranging naturally eligible staging sweep proof.** Code and full local validation/reviews pass; staging deployment and browser checks pass. No PR or merge. Documented staging KV writes return401/code10000, so the next hourly inventory was outside the bounded window. Baseline restored and all billable fixtures independently removed; staging released.

## Problem and findings

The selected platform cloud credential goes through the static provider builder in `apps/api/src/scheduled/provider-orphan-reconciliation-core.ts`. That builder rejects every GCP credential, including workload identity and service-account keys. Failed runs retry on each five-minute cron because only successful scans stamp the hourly interval. User/project inventory already uses the GCP-aware exact resolver and isolates account failures.

Classification (b). Read-only production check November 15 ~00:03 UTC: one enabled platform Hetzner credential, no platform GCP; one active user GCP and three user Hetzner credentials, no project credentials. Narrow Nov14–15 failure-signature log query and Nov1–15 platform-error search found none. Production GCP inventory has three exact-installation VMs, all claimed by nonterminal nodes, zero orphan candidates. No observed orphan charges. Findings delivered to coordinator before implementation (event 785862fd-96a5-4790-b4b5-4aa128f116de).

The sweep recovers billable provider VMs left without a live D1 claim by create/crash races. Exact installation, environment, managed label, valid node label, minimum age, validated D1 claims, and final immutable identity/ownership checks authorize deletion. This task changes authentication only.

## Checklist and acceptance

- [x] Investigate main, production credential shapes, logs and read-only cloud inventory; report before fix.
- [x] Add behavioral regression through real `runProviderOrphanReconciliation`, real GCP config/token path and provider HTTP boundary; demonstrate red before fix.
- [x] Support platform workload identity and service-account keys through existing GCP token provider/factory, retaining the platform credential's owner context.
- [x] Prove foreign/legacy resources never reach DELETE, with owned positive control; prove per-credential failure isolation.
- [x] Keep static provider configuration and orphan ownership/selection unchanged.
- [x] Run lint, typecheck, tests and build; specialist reviews and implementation task-completion validation.
- [ ] Coordinate shared staging, deploy, verify real platform GCP workload identity and safe deletion/preservation; bound test spend to cents and clean up immediately.
- [ ] Recheck production first-run deletion risk; stop before merge if newly enabled deletion is expected.
- [ ] PR, green CI, best-effort CodeRabbit wait, normal merge gates.
- [ ] Monitor production deployment; basic health and next sweep log check only.

## References

- SAM task 01M7E7PHTQH57W6EPC8ZJQ3VP8; coordinator 01M7AF82KG9C78WAABTG3V1MN1.
- Idea 01M77HYN8N41MQ17TQZ622PPPV, R13 D7; investigation note 01M7E8AQBH1K4V7KRH5YAGHY4D.
- `packages/providers/.claude/rules/56-destructive-provider-ownership-proof.md`.
- API scheduled isolation rule 53; shared predicate rule 67; root proxy-signal rule 74.
- Existing provider orphan real-boundary tests; GCP token owner/factory and catalog seed conventions.

## Implementation evidence

Both platform GCP WIF/key tests failed before the fix with configuration errors; after the fix all 74 orphan tests passed. Tests use real encrypted platform credential lookup, parser, token exchange and provider HTTP/delete implementation; foreign and legacy resources are returned beside the owned positive control. Baseline repository lint/typecheck passed. Main task-only push rejected GH013 (required Durable Object Workers); keeping task commits in the feature PR.

## Review and staging preparation

Local security-auditor, cloudflare-specialist, test-engineer, constitution-validator, implementation task-completion-validator A-F and doc-sync-validator all PASS; no findings. Full lint, typecheck and build PASS. Root `pnpm test` rerun PASS: 39/39 package tasks; API 1015 files/15180 tests passed, 3 files/4 tests skipped. Initial concurrent run had one unrelated deployment-error-recovery timeout; isolated file 34/34 and full rerun both passed.

Isolated test-project fixtures (cleanup required): sam-vm-control-plane-test, us-central1-a; sam-orphan-jq3vp8-owned (7791020495571601202, created00:16:29Z) and sam-orphan-jq3vp8-foreign (2345179896148739888, created00:16:31Z), two e2-micro/10GB pd-standard/no public IP/no attached SA. Both stopped after creation; age floor reached01:16:32Z. Conservative total budget < $0.10. Own SA orphan-jq3vp8, own compute role membership, own pool orphan-jq3vp8/provider staging; trust initially refuses all tokens. Must remove all own resources after proof. No shared staging credential/pool/deploy change yet, handoff requested.

Fixture cleanup guard: accepted same-session schedule 76a3a75c-a98b-443d-9481-8025cb2138e2, version 1, due November15 01:45 UTC; cleanup deadline is absolute (no indefinite extension). PRShepherd is coordinating staging queue; no slot granted yet. Both fixture VMs confirmed TERMINATED00:20Z, disks autoDelete. Pool issuer is https://api.sammy.party (matches jwt.ts getIssuer); trust remains false until exact staging platform creator is captured. Full validation completed green at00:49Z; no runtime changes after specialist review.

## Inventory details (unchanged)

The five-minute handler calls the isolated sweep; successful scans default to hourly. The selected enabled platform credential is attempted first (`getPlatformCloudCredential` selects one), then a bounded rotating page of active legacy user/project cloud credentials is resolved by exact reference/fingerprint. Each account failure is contained. Missing/failed inventory is a failure/skip, never authority to delete. This sweep inventories VMs, not detached cloud storage or IPs.

| Provider | Existing inventory |
| --- | --- |
| Hetzner | Paginated project servers with the exact scope label selector. |
| GCP | Paginated aggregate instances across project zones, requiring SAM-managed plus exact scope labels; unreachable zones reject the partial result. |
| Scaleway | Servers in the configured zone plus other supported zones, with scope tags; 404 zones skipped. |
| Vultr | Account instances, then exact scope labels filtered locally. |
| DigitalOcean | Account droplets, then exact scope labels filtered locally. |
| UpCloud | Account servers, then exact scope labels filtered locally. |
| Infomaniak | Authenticated compute endpoint server detail inventory, then exact scope labels filtered locally. |

Core independently checks managed/environment/installation/node/age, validated D1 claims and final immutable identity/ownership before provider VM deletion. Associated auto-delete disks follow provider semantics; detached resources are outside this inventory. The production zero-orphan observation is specifically for GCP VMs in the inspected production project.


## Durable failure reporting follow-up

Coordinator observation e7898474-108f-4d92-b2fc-6ec06c065811 confirmed that contained credential failures previously appeared only in log counters, not durable failed-sweep records. After all credential attempts complete, the scheduled handler now passes a count-only failure through its existing isolator when errors are nonzero. Completed metrics remain available even after partial success, and downstream sweeps continue. No ownership, selection, credential isolation or deletion logic changed.

Two reporting regressions failed before this addition; final real-handler/real-isolator tests cover failed-only, partial-success and zero-error controls, persisted observability context, preserved metrics and downstream continuation. Focused three-file run:16/16 PASS. Follow-up security/Cloudflare review PASS; test-engineer and constitution follow-up PASS after preserving metrics and adding the clean control. Broad handler-delta validation PASS: root lint22/22, typecheck36/36, build18/18, test39/39tasks; API1015files15183testsPASS, 3files4testsskipped. Runner-only upstream2744 merged from main d60c28efd before staging; runtime source unchanged.

Cleanup bound replan01:07UTC: actual security window targetsFREE01:30 and observed deployment takes20min. Moved own stopped-fixture cleanup wake ONCE to02:15UTC (scheduleversion2), unchanged totalbudget<$0.10. Earlier01:45 deadline superseded explicitly in shared staging channel. No further indefinite extension; if this bound cannot fit, clean up and report. No staging mutation/claim yet.


## Live window and recovery receipt

Staging actualTAKEN event79c5aa84, run43663972851, reviewed fullSHA8807b4bd96df8f6b69a2c4556f8e7e382df098c8. Fresh01:35 preflight: only own stopped fixture matches scope, foreign control distinct, zero D1 node claims/live nodes. Browser token-login and dashboard/projects/settings pass; original platform Hetzner credential01KNY6DC06C9QCYQM0389NAGNT enabled, updated2026-04-11T11:56:37.766Z. Recovery metadata sent to staging coordinator: restore original via normal adminAPI PATCH isEnabled=true FIRST, then remove only own temporary WIF credential (ID to be recorded before flip); guard against peer updatedAt changes. KV last-run saved locally, not cleared yet. No temporary staging credential created yet. Local Chromium dependencies extracted under .tmp without sudo.

Production read-only recheck01:43UTC: still one enabled platform Hetzner, zero platform GCP. GCP inventory now five exact-production-scope VMs, all five claimed by nonterminal nodes; zero unclaimed/terminal candidates. Current production credential mix enables no new GCP deletion path after this fix. No production mutation.

Before-flip recovery receipt01:54UTC: own temporary platformGCP credential01M7EEGY11G6FZ9EBM1E6VJ2NG created01:53:05.057Z; original Hetzner01KNY6DC06C9QCYQM0389NAGNT still enabled. Restore original enabled first, then DELETE only own credential; guard IDs/provider and post-flip updatedAt against peer changes. Receipt sent to staging coordinator before disable. Cloudflare independently confirms100% Worker version7983f87d-a613-48ca-9a97-2d97747eeaeb, annotation commit8807b4bd96df8f6b69a2c4556f8e7e382df098c8.

Staging blocker01:57UTC: documented CF_TOKEN reads succeed but DELETE intervalmarker returns401; PUT saved original returns401/code10000. Neither KV mutation succeeded. Own temporaryGCP selected, original Hetzner disabled at01:54:37.517Z (guard). Coordinator+parent notified. Inspect next naturalcron then restore/cleanup by02:15 with no gate waiver.


## Final staging evidence and unresolved gate

Deploy43663972851 succeeded, including smoke tests, on fullSHA8807b4bd96df8f6b69a2c4556f8e7e382df098c8. Independently confirmed Worker100%version7983f87d-a613-48ca-9a97-2d97747eeaeb with that commit annotation. Real platform GCP workload identity credential was created and selected through normal adminAPI. Post-deploy browser DOM checks for dashboard/projects/settings pass with zero page errors.

**Required live cron deletion/preservation proof did not run.** Natural01:55 and02:00 cron summaries reported interval-not-elapsed, scanned0/destroyed0/errors0. FreshKV read was2026-11-15T01:50:32.815Z. Both authorized debug write attempts failed (DELETE401; PUT401/error10000). Contrary to scoped rule32's stated capabilities, the available CF_TOKEN has working reads but rejected these writes. No documented normal API reset exists (independently checked by staging coordinator). No token/privilege/deploy workaround, extra fixture loop or deadline extension was used. The obsolete saved00:50 timestamp was not restored over legitimate natural cadence; no test KV write succeeded.

Restoration completed02:02: original Hetzner enabled first, ownGCP credential removed, normalAPI metadata matched baseline, session signed out and local cookie cache removed. Root independently confirmed original Hetzner only and currentKV at02:03:56.

Independent provider/IAM/D1 cleanup proof02:04: both fixture VMs and both auto-delete boot disks absent; own service account absent from authoritative project list; own compute IAM membership absent; own WIF pool stateDELETED (provider removed with pool); only original platform Hetzner credential enabled and ownGCP credential absent. Wildcard GET of a deleted service account returned403, so that response was not used as absence proof. Only unavoidable nonbillable remnant: deleted WIF pool name reserved30days. Total bounded fixture spend estimate remains<$0.10.

Staging FREE published event1cdc5c84-dc43-42fa-85f9-7107c7b1f23a. Cleanup guard cancelled before02:15, schedule76a3a75c-a98b-443d-9481-8025cb2138e2 version3. Root coordinator received recovery and cleanup receipts. Parent receives the blocking outcome; no PR, merge or production deploy claimed. Resume requires a coordinated legitimate verification window spanning the next eligible hourly sweep, or restored documented KV write capability. Keep all normal gates; do not archive this unfinished task.


## Natural-window continuation

Coordinator event9f402b28 directs continuation by a timed natural sweep, no KV workaround/new permission. Prior window remains concluded and fully cleaned. Fresh02:09 read still shows last-run01:50:32.815UTC, interval1h; first cron tick after eligibility is02:55 (actual invocation around02:50 can also be eligible depending on elapsed timing). New resources must also age for1h, and deployment observed20–24min, so a fixture created12min before the earliest tick cannot be selected. Requested a coordinated approximately03:30–04:15 window and will re-read the marker after02:55 to finalize. Prepare only two own stopped fixtures outside the shared claim sufficiently early; no platform/global state mutations until actual handoff.

Coordinator permits at most one next-hour retry after a missed tick, with at most one extra hour of shared staging and a report after two failed attempts. This is a separate newly coordinated natural-window plan, not extension of the concluded02:15 guard. No new resources provisioned yet. Cumulative conservative fixture budget remains<$0.10.

Environment reporting tool returned report_failed/storage failed. Durable follow-up filed at `tasks/backlog/2026-11-15-staging-cloudflare-kv-write-capability.md` with sanitized calls/statuses; no retry or permissions workaround.

R2 scope/guard before creation: prefix sam-orphan-jq3vp8-r2, fixture label jq3vp8-r2, ownSA/pool orphan-jq3vp8-r2/providerstaging, same isolated test project/zone. Accepted hard cleanup guard68c064a2-f56f-4077-8780-73ee23489fa1 version1 due05:15UTC. Fallback tentative04:30–05:15 covers likely04:55/05:00 natural tick after earlier owners; no staging reservation. Preparing at03:10 and stopped by03:12 gives age eligibility04:12. Reconcile fresh marker after02:55 before provisioning; trust false and no shared credential mutation until actual handoff. Cumulative budget<$0.10; no automatic next-hour extension.

Workspace recovery02:48–02:59: SAM recreated the live workspace while waiting. Pushed branch724eecddd and task record persisted; feature worktree recovered. Lost local scratch/cookies/browser dependencies were rebuilt under gitignored `.tmp/`, without sudo. No resources or sessions were held. Existing full validation/review evidence remains valid; no runtime source changed. Root user `.codex/config.toml` modification preserved.

Fresh02:58 read: last-run advanced naturally to02:55:32.684UTC, interval3600000ms, next eligible03:55:32.684 (likely04:00 cron), following eligible likely04:55/05:00. Independently checked R2 cleanup guard still PENDING v1. Reconciliation request b8fb95a0 sent to staging root before preparation; no R2 resources yet, tentative04:30–05:15 is not a grant. Catalog's GH deployment43669456326 failed; failure alone is not a staging release. Supported workload-identity sign-in route found in source for later staging verification, avoiding expired stored PATs.

R2 preparation admitted by root DM1ca81520, conditional fresh queue and guard check. Fresh03:07 queue watermark198 and no active deployment still fit the bounded target; hard05:15 guard PENDING v1. New-main merge7751911a4 incorporates2742/2747 without conflicts or changes to this task's runtime diff. Refreshed lint22/22, typecheck36/36, build18/18 pass; full suite running.

R2 resources now exist (cleanup required): test-project service account orphan-jq3vp8-r2, immutable uniqueId102101547578799913249; own compute IAM membership; pool orphan-jq3vp8-r2/provider staging, trustfalse. Initial IAM grant returned400 immediately after account creation; a guarded resume confirmed the own account and succeeded without recreating it. Own VM sam-orphan-jq3vp8-r2-owned id6398351824852917435, created2026-11-15T03:09:08.927Z, stopping immediately; foreign VM not yet recorded. No platform/global staging mutation or login. Preparation job sx-a2cf590ca00a89af39803768fd14feb2333e4395f62fa527f27aa61ec605400a still running. Exact local metadata recorded immediately in `.tmp/orphan-r2/fixture-ids.json`; all billable resources remain inside the accepted05:15 guard.
