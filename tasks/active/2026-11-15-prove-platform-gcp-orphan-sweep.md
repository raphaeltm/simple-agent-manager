# Prove and land the platform-GCP orphan sweep fix (P1b)

SAM task 01M7FCKQ6B82AM5SYWEDDYK8ZB. Coordinator 01M7FB384QHQ1TQCK95D0SX0TX. Continues P1
(01M7E7PHTQH57W6EPC8ZJQ3VP8), whose record is `tasks/active/2026-11-15-platform-gcp-orphan-sweep.md`
on branch `sam/task-p1-find-out-jq3vp8` (tip e87360c6f). That branch is not merged; this PR carries
the same runtime change onto current main without P1's task files.

## Problem

`resolveProvider()` in `apps/api/src/scheduled/provider-orphan-reconciliation-core.ts` built the
provider for the selected platform cloud credential with the static `buildProviderConfig()`, which
rejects every GCP credential. On an installation whose platform credential is GCP (workload identity
or service-account key) the sweep failed on every five-minute cron and orphaned VMs were never
deleted. The failure was also invisible in `failedSweeps`, because account failures are contained
inside the sweep.

## Change, part 1 (same as P1, byte-identical runtime files; commit edf482791)

- `provider-orphan-reconciliation-core.ts`: a platform credential with `provider === 'gcp'` goes
  through `parseGcpCredential` + `createGcpTokenProvider` (credentialSource platform, acting as the
  credential's creator, no project scope) + `createGcpProviderForEnv`. Ownership and selection
  logic unchanged.
- `services/platform-credentials.ts`: `getPlatformCloudCredential` also returns `createdBy`.
- `scheduled/handler.ts`: a sweep run with platform-account or infrastructure errors
  (`result.errors > 0`) is reported through `sweeps.isolate`'s durable failed-sweep path while
  keeping its counters; failures confined to one user/project account are `accountErrors`,
  logged (`providerOrphanAccountErrors`) and never fail the sweep (commit 73f570618).
- Tests: `tests/unit/scheduled/provider-orphan-platform-gcp.test.ts` (platform WIF and key through
  the real entry point, token exchange and provider HTTP boundary; owned positive control plus
  foreign/legacy preservation; per-credential isolation), `handler-kill-switch.test.ts` (failed-only,
  partial-success and zero-error reporting).

## Change, part 2 (scope grew after the box proof; commits 44bd1bfb0, 3f6d35272, 253e6662d)

Box R16 showed that authentication alone does not make GCP orphan cleanup work. Coordinator
approved the extension (event 44439269) with conditions recorded in the checklist below.

- `44bd1bfb0` pure move: the destroy half of `provider-orphan-reconciliation-core.ts` (575 lines)
  moves to `provider-orphan-destroy.ts` (rule 18).
- `3f6d35272`: per-call request timeouts (list, ownership re-read, delete each get
  `NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS`, as `env.ts` already documented "per-candidate");
  no candidate starts after the sweep budget; providers with `requestVMDeletion` (GCP) get a
  send-and-return delete bound to the re-read instance via new provider option
  `expectedInstance` (id + zone, refuses before anything is sent), counted as
  `deletionRequested` (new result field, `providerOrphansDeletionRequested` in cron summary),
  never `destroyed`, and counted toward `PROVIDER_ORPHAN_DESTROY_LIMIT`. Others keep `deleteVM`.
- `253e6662d`: drops unrelated prettier reformatting from the docs change.

### Bounds (rule 81, rule 47), defaults (corrected per cloudflare-specialist round 2)

- T = `NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS` (5 s) bounds one PHASE (all its sequential
  requests): the list, the ownership re-read, or the delete. B = sweep budget (20 s). L = destroy
  limit (5), shared by the platform account and the user/project accounts in one pass.
- A candidate may only start before B and costs at most re-read T + delete T, so a whole pass
  ends by B + 2T = 30 s; a list that ends after B starts nothing (at most B + T = 25 s).
- GCP requests per candidate (current code): re-read `GcpProvider.getVM` walks the 8 labelled
  zones (`GCP_LOCATIONS`) until found (k GETs, k = 1..8; europe-west1-b is k = 4), plus the
  aggregated list only if no labelled zone matches; the delete reads only the proven zone:
  zone GET + GET by id + DELETE = 3. So k + 3 fetches (4-11; 12 outside the labelled zones) plus
  4-5 KV token reads and 1 D1 audit write: about 9-18 subrequests, about 90 per pass at L = 5.
  A cold WIF token exchange adds 2-3 fetches once per token lifetime.
- Typical wall time per candidate 0.7-3.6 s, so all L = 5 fit in B. Candidates refused at the
  re-read do not count toward L; they are bounded only by B (about 6 per pass).
- D1 claim lookup is batched at 100 ids per statement (D1 bind limit), so a backlog of any size is
  classified; tested with 105 candidates.
- Drain: ceil((N_platform + N_user) / 5) hourly passes, platform account first; with 5 platform
  deletions in a pass the user accounts are not reached that pass. Outer probable limit: a 100-VM
  leak drains in about 20 h. A requested but still-present VM is requested again and spends L
  again (backlog item 2).
- Not bounded by T: D1 and KV calls, credential resolution, the cold WIF exchange (all small).

## Research findings

- Files on main + this change are byte-identical to P1's reviewed tip; the modules they call
  (`gcp-provider-factory.ts`, `gcp-token-provider.ts`, `provider-credential-codecs.ts`, providers
  GCP files, shared constants) have no drift between P1's tip and main. P1's security-auditor,
  cloudflare-specialist and test-engineer results therefore apply unchanged.
- The sweep's interval (`PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS`) and minimum age
  (`PROVIDER_ORPHAN_MIN_AGE_MS`) are Worker vars; on a self-host box they can be overridden in
  `.state/secrets.env`, which `wrapWorker` merges into the cron's `env`
  (`apps/api/src/selfhost/runtime-secrets.ts`). Used for the box proof only.
- The GCP list filter requires `sam-managed=true` plus `managed`, `env`, `installation` labels
  (`packages/providers/src/gcp-instance-lookup.ts:listGcpInstances`); a foreign-installation VM is
  excluded server-side and never reaches classification.
- Production: platform credential is Hetzner, so the new GCP branch does not run there. Must
  re-check the first-run deletion risk before merge.

## Checklist

- [x] Box branch: draft PR #2750 (base `sam/selfhost-pass-2`, adopted from cancelled copy
      01M7FBJF8CK4Y9KTY1PW4Y9QTR, identical tree), CI started by hand
- [x] Box round R16: baseline failure, preflight, fixtures, positive deletion proof, controls,
      clean next run, cleanup, restore, FREE, note on idea 01M77HYN8N41MQ17TQZ622PPPV
- [x] Main branch change (this PR), byte-identical runtime files
- [x] Extended fix: per-call timeouts, sweep budget, send-and-return GCP delete bound to re-read (`expectedInstance`), `deletionRequested` counter, Hetzner unchanged control, tests incl. incident reproduction (proven red on shared signal), limit > one pass, budget, next-pass present/absent, identity change
- [x] Pre-PR validation: lint 22/22, typecheck 36/36, build 18/18, test 39/39 tasks (API 1022 files /
      15254 tests passed, 4 skipped; providers 48/892) on 73f570618; later commits test/task-only
- [ ] task-completion-validator
- [ ] Staging no-regression: one natural sweep tick with unchanged platform Hetzner credential,
      zero errors, zero destroyed (no fixtures, swaps or KV/D1 writes)
- [x] Production first-run deletion-risk read (12:01 UTC; repeat right before the approval request)
- [ ] PR, CI, CodeRabbit request and wait, merge
- [ ] Deploy Production monitored; health check; one look at the next production sweep run

## Acceptance criteria

1. On an installation whose only cloud provider is a platform GCP workload-identity credential, the
   sweep authenticates and deletes exactly an owned, unclaimed, old-enough VM (box R16).
2. Foreign-installation and too-young owned VMs survive; the following run is clean (box R16).
3. Staging (platform Hetzner) sweep run after deploy: zero errors, zero destroyed.
4. Unit/integration regressions above pass; full suite green.
5. Production first sweep after deploy destroys nothing unexpected.

## Evidence

### Box R16 (sam-box, platform GCP WIF credential 01M7EH6D77XEGNXNTZZN688CQG, env selfhost,
installation ceb69517d92d6a294f697c7957f01d79). Config overrides in `.state/secrets.env`:
PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS=240000, PROVIDER_ORPHAN_MIN_AGE_MS=900000 (restore at end).

- Baseline on 4e88377be: `provider_orphan.credential_resolution_failed` every 5-min cron (36 in
  3 h, 07:50-10:45), config error from `buildProviderConfig`; cron.completed scanned 0, errors 1,
  skip `credential-resolution-failed`, failedSweeps [] (hidden).
- Preflight 10:51: 0 node rows; only VM in project sam-box (no labels): zero candidates.
- Fixtures e2-micro/10 GB/stopped/no IP/no SA, europe-west1-b: owned 4670269250816192548
  (10:51:55), foreign (installation fedcba98...) 8501352887410241593 (10:52:06), young
  1822245929685888572 (11:00:35).
- P1-only build (deploy 10:53, version 6a6dac89a0e60aec): authenticates (10:55/11:00/11:05:
  scanned 1/1/2, young 1/1/2, errors 0). 11:10 and 11:15: owned selected, delete aborted by the
  shared 5 s signal BEFORE sending (no GCP delete op). 11:20 and 11:25: DELETE sent by
  sam-nodes (GCP ops 11:20:05 owned, 11:25:04 young, each ~6 s), then the poll aborted:
  reported destroy_failed, errors 1-2, failedSweeps [provider_orphan_reconciliation], no
  deletion record, second candidate dropped. Deletion happened but was reported as failure.
- Interim extended build (deploy 11:36:36, box branch 7df2551d5, before review fixes): fixtures
  owned2 5063697356165490589 (11:37:22), young2 9223337014421890235 (11:41:08). 11:40/11:45/11:50
  young skips, errors 0. 11:55: `provider_orphan.destroying` + `deletion_requested` for exactly
  owned2; young2 skipped young; foreign not listed; errors 0, failedSweeps []. GCP: owned2 gone,
  foreign + young2 present. 12:00: young2 (eligible since 11:56) requested, errors 0.
- Final build (box branch 6265923f3 = main 73f570618 runtime, deploy 12:00:13, version
  746831d13a0c99a6): owned3 766231454351106104 (12:00:23), young3 4389463958291226569
  (12:10:14), foreign 8501352887410241593. 12:05: scanned 1, young 1, errors 0, accountErrors 0.
  **12:20 proof:** `destroying` + `deletion_requested` for exactly owned3 (claim no-row); GCP
  delete op by sam-nodes 12:20:03.489, DONE 12:20:09; young3 skipped young; foreign never listed;
  errors 0, failedSweeps []. **12:25 next run clean:** scanned 1 (young3), young 1, requested 0,
  errors 0, failedSweeps []. No live nodes on the box (claimed-node control covered by tests).
- Cleanup 12:25-12:37: young3 + foreign deleted after name/id/label check; project holds only
  sam-box. secrets.env restored byte-for-byte; sealed bundles MERGE secrets.env, so the override
  bundle was moved out and the box redeployed onto the pre-R16 bundle e46cd268 (Worker
  75b926858b62153c); 12:35 tick `interval-not-elapsed` confirms the hourly interval is back.
  SSH key + rule sam-selfhost-allow-ssh-p1b removed. FREE published (event 897c3ff6). Box left on
  the fix (6265923f3). Write-up: note 01M7FKCN6R7R4H6EY75S9KFX73 "BOX ROUND R16 (orphan sweep
  fix)" on idea 01M77HYN8N41MQ17TQZ622PPPV.

### Discrimination (each guard reverted alone; exactly these went red)
- shared pass signal (list/re-read/delete on one signal): INCIDENT test only.
- limit counts `destroyed` only: limit-per-pass test only.
- force `deleteVM` on GCP: the 9 GCP request-path tests; Hetzner control stays green.
- provider `expectedInstance` id/zone guard off: the two refusal tests (provider package).
- provider label check off: label-change test (provider package).
- claim lookup not batched: 105-candidate backlog test only.
- sweep does not pass labels: delete-boundary label-change test only.
- no-zone refusal off: no-zone test only.
- account scoping off: the 5 account-failure tests.

### Production first-run risk (read-only, 12:01 UTC, P1's `production_read.py`)
- Enabled platform cloud credential: 1 Hetzner. Active user cloud credentials: 1 GCP, 3 Hetzner;
  no project credentials.
- `sam-prod-infra` (exact production installation + env labels): 3 VMs, all claimed by
  non-terminal nodes; 0 unclaimed, 0 eligible, 0 young, 0 ambiguous. The GCP delete path would
  delete nothing on its first production run.
- Production logs (24 h): no `provider_orphan.destroying`/`destroy_failed`; one
  `provider_orphan.list_failed` roughly every 2 h (one account failing its list when the cursor
  reaches it; with 4 user credentials in one cursor page, a pass attempts all four and the next pass
  gets an empty page, so a failing account shows every other hour). With this change that is
  `accountErrors`, not a failed sweep. User Hetzner
  accounts cannot be read from here; their path keeps `deleteVM` and is unchanged except that
  each call now has its own timeout.
