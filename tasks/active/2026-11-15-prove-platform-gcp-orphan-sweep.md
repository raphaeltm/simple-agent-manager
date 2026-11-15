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
- `scheduled/handler.ts`: a sweep run with `errors > 0` is reported through `sweeps.isolate`'s
  durable failed-sweep path while keeping its counters.
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

### Bounds (rule 81, rule 47), defaults

- Request timeout T = 5 s per provider call; sweep budget B = 20 s; destroy limit L = 5.
- Per account: list <= T; per candidate re-read <= T + delete <= T = 2T = 10 s.
- No candidate starts after B, so one pass is at most about B + 2T + T = 35 s of provider I/O
  per account loop (platform account first, then user accounts until B or L is reached).
- Candidates per pass: at most L = 5 deletions; at GCP latency (each lookup up to 9 zonal GETs
  plus one aggregated list, about 100-300 ms each) a candidate costs about 1-4 s, so all 5 fit
  in B. The rest are not touched (nothing sent) and are selected again on the next eligible pass
  (hourly by default). Worst-case drain of N orphans: ceil(N/5) passes, e.g. 20 orphans in 4 h.
- Next pass after a request: VM gone -> not listed; still present (deleting or delete failed)
  -> requested again (idempotent).

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
- [ ] Box round R16: baseline failure, preflight, fixtures, positive deletion proof, controls,
      clean next run, cleanup, restore, FREE, note on idea 01M77HYN8N41MQ17TQZ622PPPV
- [x] Main branch change (this PR), byte-identical runtime files
- [x] Extended fix: per-call timeouts, sweep budget, send-and-return GCP delete bound to re-read (`expectedInstance`), `deletionRequested` counter, Hetzner unchanged control, tests incl. incident reproduction (proven red on shared signal), limit > one pass, budget, next-pass present/absent, identity change
- [ ] Pre-PR validation: lint, typecheck, test, build
- [ ] task-completion-validator
- [ ] Staging no-regression: one natural sweep tick with unchanged platform Hetzner credential,
      zero errors, zero destroyed (no fixtures, swaps or KV/D1 writes)
- [ ] Production first-run deletion-risk read before merge
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
- Extended build (deploy 11:36:36, box branch 7df2551d5): in progress.
