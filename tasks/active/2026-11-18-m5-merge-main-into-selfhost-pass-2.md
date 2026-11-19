# M5: merge main into sam/selfhost-pass-2, then box upgrade smoke

Task 01M7RECJC07S1XFNCS24HZ576G, dispatched by coordinator 01M7JMXS2JRW6QQMB1356ENPM3.
PR base `sam/selfhost-pass-2`; do not merge (the coordinator reviews and merges).

## Problem

Since M4 (#2884, 942d2c0a4), main landed L18 #2885 (0c5fd10e7), L21 #2887 (4cc8f0198) and
L20 #2889 (114e1d98b). The integration branch must take them (main's landed code wins, the
branch keeps only unlanded functionality), and carry the L20 author's follow-ups so a box
still gets the analytics table and sink.

## Research findings

- Trial merges from integration tip 5834e9be0: L18 0 conflicts, L21 29, tip 26.
- L18: the branch's cloud-init was already byte-identical (L18 review fixes #2886); after the
  merge `packages/cloud-init` has no diff against main.
- L21: main's SMTP client/config/probe, sam-mx, inbound-email route and tests supersede the
  branch copies. Branch-only pieces still used: `hasInboundAgentEmail` (unlanded
  `inboundAgentEmail` capability) and two capability assertions in L21's test files.
- #2888's create-account guard lives in `scripts/selfhost/` (no conflict).
- L20: main's `services/analytics-sink.ts` + `selfhost/analytics/` supersede the branch's
  `services/analytics-d1-sink.ts`; main's `r2-presign-config.ts` requires `R2_S3_REGION` for
  an operator store; `operations.analyticsD1*` became self-host-installed `analytics.d1.*`.
- Main's `platform-capabilities.ts` now has 6 capabilities; the branch has 18 (unlanded ones
  re-attached onto main's shape).
- Box: app.vmtest.sam2.party (sam-box, GCP sam-vm-control-plane-test, europe-west1-b);
  previous run's evidence on branch sam/box-debt-run-upgrade-ffs6de.

## Checklist

- [x] Step 1: merge L18 0c5fd10e7 (86534969a), push
- [x] Step 2: merge L21 4cc8f0198 (7a05dac11), push
- [x] Step 3: merge tip 114e1d98b (f46fc9119), push
- [x] Follow-up 1: delete the shared-dir `db/migrations/observability/0002_analytics_events.sql`
- [x] Follow-up 2: `withSelfHostBuild` calls `installAnalyticsD1Sink()`; `prepareCelldProject`
      appends `SELFHOST_OBSERVABILITY_MIGRATIONS` to OBSERVABILITY_DATABASE's projection (tests:
      `selfhost-build.test.ts`, `celld-project.test.ts`, proven red without the call)
- [x] Follow-up 3: `presignVars` passes `R2_S3_REGION` (`auto` default for `gs://`, required for
      `s3://`); README and `.env.example` updated; real-resolver test
- [x] Follow-up 4: `operations.analyticsD1*` removed (defaults restored to main's);
      `analytics.d1.*` come from `installAnalyticsD1Sink`
- [x] Follow-up 5: sam-mx/SMTP files byte-identical to main; #2888 guard byte-identical
- [x] Branch-only capability assertions moved into `platform-capabilities.test.ts`
- [x] Local validation: build, typecheck, lint, full test, selfhost:test, quality checks
- [x] Draft PR #2899 into sam/selfhost-pass-2; CI 44424146504 green on 4e2e43509
- [x] architecture-reviewer, task-completion-validator ADDRESSED (fixes in 4e2e43509)
- [x] CodeRabbit request and wait (Review skipped: 229 files > 100)
- [x] Box: claim, in-place upgrade to PR head, smoke (health/services, migration ledger incl.
      analytics table, admin analytics event in D1, free-model task reply, reverse-tunnel
      heartbeat), cleanup, BOX FREE

## Acceptance criteria

- Real merges (3 merge commits whose second parents are 0c5fd10e7, 4cc8f0198, 114e1d98b); no
  force-push to the integration branch.
- Full CI green on the PR head.
- The box upgraded to the PR head passes every smoke item above.

## Box evidence (2026-11-19, sam-box, app.vmtest.sam2.party)

- Claimed on feature.selfhost-landing at 23:55Z (seq 384). Temporary SSH key (user `node`) and
  firewall rule `sam-selfhost-allow-ssh-m5-hz576g` for this workspace's egress IP only.
- Before: checkout ba35d4905, 7 containers up, health 200. Primary ledger 281 rows; observability
  ledger 3 rows incl. `0002_analytics_events.sql` (2026-11-15); `analytics_events` 2852 rows; no
  `operations.analyticsD1*` rows in `platform_settings`; no `R2_S3_ENDPOINT` in the box .env, so
  presigning stays off and the region rule has no live effect on this box.
- Upgrade: `pnpm selfhost:upgrade --to 4e2e435090a6…` 00:05:08Z: "253 files, compose inputs
  changed, D1 migrations none", backup 11402 objects with celld down 19.3 s, stack restarted,
  "upgraded to 4e2e43509…; healthy".
- 1 Health/services: PASS. Checkout 4e2e43509, clean tree, 7 containers up (celld restarted),
  api/health 200, app 200; public capabilities as a box expects (logSearch/liveLogStream false).
- 2 Ledger: PASS. Primary 281 rows, 281 distinct names (no migration ran, none new). Observability
  ledger unchanged (3 rows, 0002 not re-run); `analytics_events` + 2 indexes present; the
  projection `observability-dev/0002_analytics_events.sql` now links to
  `apps/api/src/selfhost/migrations/observability/` (3 files); primary projection still links
  the self-host 0255.
- 3 Admin analytics into D1: PASS. Workload-identity sign-in as smoke-admin; `POST /api/t` event
  `m5_box_smoke_001617` → 204; row in OBSERVABILITY_DATABASE `analytics_events` at 00:16:17
  (event name, app host, the signed-in user id); `GET /api/admin/analytics/events?period=24h` →
  200 from the D1 sink (top 50 dominated by machine traffic, so the single event is not listed).
- 4 Free-model task: PASS. agent-test, OpenCode `opencode/deepseek-v4.1-flash-free`, conversation
  task 01M7RJN986N81GEM3VCTQAGDMJ: submit 00:17:47Z, assistant "pong" 00:22:42Z (VM boot
  included).
- 5 Reverse tunnel: PASS. Node 01M7RJNCZH225672TPWRFYGNC3 created 00:17:50Z; lease port 20010
  active 00:17:51Z; frps client login + proxy on 20010 at 00:19:00Z; heartbeats logged
  `heartbeat.ip_backfill_skipped_tunnel_node`; node healthy, heartbeat 00:22:06Z;
  `GET /api/nodes/:id/system-info` 200 in 2.6 s through the gateway. No error-level celld events
  since the upgrade.
- Cleanup: session stop 200 (workspaceDeleted); node DELETE 200 at 00:23:48Z; lease released
  `runtime_terminated`; VM gone at GCP (only sam-box); 0 active nodes/workspaces; both sessions
  signed out (get-session null); pre-upgrade backup (1.1 GB, plaintext secrets) and scratch dir
  deleted; SSH key removed from metadata (next SSH refused) and firewall rule deleted; local
  token, cookies and keys deleted. Left on the box: the smoke task/session history and its
  analytics event row.
