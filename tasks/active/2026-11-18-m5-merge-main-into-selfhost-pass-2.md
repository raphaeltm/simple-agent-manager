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
- [ ] Local validation: build, typecheck, lint, full test, selfhost:test, quality checks
- [ ] Draft PR into sam/selfhost-pass-2; CI dispatched (workflow_dispatch) and green
- [ ] architecture-reviewer, task-completion-validator ADDRESSED
- [ ] CodeRabbit request and wait
- [ ] Box: claim, in-place upgrade to PR head, smoke (health/services, migration ledger incl.
      analytics table, admin analytics event in D1, free-model task reply, reverse-tunnel
      heartbeat), cleanup, BOX FREE

## Acceptance criteria

- Real merges (3 merge commits whose second parents are 0c5fd10e7, 4cc8f0198, 114e1d98b); no
  force-push to the integration branch.
- Full CI green on the PR head.
- The box upgraded to the PR head passes every smoke item above.
