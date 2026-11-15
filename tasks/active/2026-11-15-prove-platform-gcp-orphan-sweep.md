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

## Change (same as P1, byte-identical runtime files)

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

(filled in as the work proceeds; see also PR body)
