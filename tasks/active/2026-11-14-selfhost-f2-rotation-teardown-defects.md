# F2: self-host defects from box rounds R11 (key rotation) and R12 (teardown and rebuild)

Task 01M7DPHGY2329N4JMRN3372YKZ, dispatched by the self-host coordinator (task
01M7AF82KG9C78WAABTG3V1MN1). Draft PR into `sam/selfhost-pass-2`, not merged by this task. No
Cloudflare staging deploy and no CodeRabbit, by the coordinator's override; a later box round
verifies on the real box.

## Problem

Box rounds R11 and R12 (November 14, 2026) ran self-host operations on the real test box for the
first time. Evidence: idea 01M7DHBFERXG63MBNBMXB5068H and its notes "BOX ROUND R12" parts 1-3 on
idea 01M77HYN8N41MQ17TQZ622PPPV; idea 01M7DC14KQ4EMSBQRF4FG819M8 note "Findings from the first real
run, box round R11", full note "BOX ROUND R11 (key rotation)" on idea 01M77AG90EQB4F9VAKDVH94ZK4.

## Research findings

- T1: `clearState` (`scripts/selfhost/teardown-box.ts`) ran `rmSync(recursive)` per entry and threw
  on the first EACCES; Go's module cache under `.state/go-cache/mod` has 0555 directories. The key
  file and `.state` items share one action (`runKey: 'state'`), so the key file reported failed too.
- T2: `teardown.ts` passed only `--gcp-project` flags; `.env` `GCP_PROJECT` was ignored.
- T3: `teardown-outside.ts` listed the machine generically and only the wildcard DNS record; static
  IP, network, subnet, box firewall rules and the apex record were not named.
- K1: `adoptAndCheck` (`secrets-box-deps.ts`) made one reload and one health request; any failure
  was final. The deploy's own `waitForHealth` retries until a deadline.
- K2: `secrets.ts` called `parseArgs` (strict) before its try block; `--help` was unknown.
- K3: `formatPlan` always printed "rotate --resume after the N h overlap".
- K4: `rotate --status` printed `formatSummary`, which iterated `journal.keys` only; the final
  `reseal` step lives outside `keys`.
- K5: `runRotate` always took the lock, and `acquireLock` creates `.state/key-agent/rotation/`.
- K6: every seal keeps the newest `DEFAULT_KEPT_BUNDLES` = 3 (`key-service.ts`, since the spike
  7cf833355); rotation's `store.prune` applies the same rule. Intended, not documented, not reported.
- I1: better-auth `session.cookieCache` (5 min). The bootstrap owner is created `role: 'user'` and
  promoted in `session.create.before` (`bootstrapSessionAllowed`); `setSessionCookie` then caches
  the pre-promotion user. `/api/auth/get-session` (`readAuthSession`) was the only SAM session read
  without `disableCookieCache`; the web app reads the role from it.
- I2: README and `gcp-bootstrap.sh` pointed at "Admin → Integrations → Google Cloud", which does not
  exist; the credential is Admin → Credentials, API Token = JSON parsed by `parseGcpCredential`.
- I3: saving a platform cloud credential already runs `reconcileCapacityPoolsForCredentialMutation`
  inside the request (`admin-platform-credentials.ts`), the same ensure path as Refresh
  (`POST /api/admin/capacity-pools/defaults/reconcile`). Two candidate causes, not decidable
  without box data: (A) the save's reconcile threw, ran out of its publish budget, or was dropped,
  and the scheduled reconcile retries only once per 24 h (`capacity-pool-reconciliation.ts`); (B)
  the Infrastructure page kept a cached copy of the half-finished pool (no invalidation after a
  credential save, no polling while `migration-pending`). See "I3 outcome".
- I4: `ComputePoolEditor` hard-coded "Empty · Instant sessions only"; `compute-pool-copy.ts` said
  Instant runs on Cloudflare. The app already has the cached `/api/config/instant-runtime` query.

## Checklist

- [x] T1 teardown removes a read-only Go cache tree; secrets first; leftovers named (test red first)
- [x] T2 GCP_PROJECT from .env, flag wins
- [x] T3 complete "left for you" output; proposal for a bootstrap-install "remove everything" in PR
- [x] K1 adopt-and-health check retries over SELFHOST_ADOPT_CHECK_WINDOW_MS (default 30 s) (red first)
- [x] K2 `--help` / `-h` / unknown option
- [x] K3 hard-cut plan text
- [x] K4 `--status` shows the staged reseal and staged steps
- [x] K5 dry run creates nothing
- [x] K6 pruning kept; plan, summary, journal and status list the bundles
- [x] I1 get-session reads D1 (red first, through the real email sign-in handler)
- [x] I2 README and bootstrap output, JSON documented with fake values
- [ ] I3 NOT fixed: stopped per the task's rule for ambiguous/risky items; findings in the PR
- [x] I4 empty pool text from the Instant-availability answer
- [x] Docs: deploy/selfhost/README.md teardown, rotation and machines sections

## I3 outcome

Not fixed in this PR. To decide between A and B on the box:
`SELECT MIN(created_at) FROM capacity_pool_candidates WHERE pool_id = <installation pool id>` (the
upsert keeps `created_at`): about the save time means the save's refresh finished (B); about the
Refresh click means it did not (A). Also grep the Worker log around the save for
`capacity_pools.credential_lifecycle_reconcile_failed` and `catalog_build_failed`, and note the
save request's duration. Proposed fixes, by cause: (A) let `claimScheduledReconciliationRun` skip
the 24 h limit while a default pool is unfinished (already filed:
`tasks/backlog/2026-11-09-capacity-pool-readiness-gate-during-republication.md`); (B) invalidate
`capacityPoolQueryKeys.installationDefaults` after a platform credential save and refetch while the
pool is `migration-pending`.

## Acceptance criteria

- Each fixed item has a test that fails without the fix (T1, K1, I1 red output recorded in the PR).
- `pnpm selfhost:test`, affected API and web unit tests, typecheck, `pnpm check:fast` pass.
- Cloudflare impact stated per shared-code item (I1, I4; I3 untouched).
