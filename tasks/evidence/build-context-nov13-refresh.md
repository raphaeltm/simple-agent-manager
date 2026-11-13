# November 13 refresh of PR #2605

Coordinator resumed this task in message `3d1cac0f-a82e-4b52-937c-7fe329f496b2`. The required gate is a real VM genuine-publish proof; no composite-evidence waiver has been granted. PR remains draft with `needs-human-review` and requires coordinator approval naming the exact final SHA before readiness/merge.

## Main integration and package boundaries

Merged main `d65360dcd` into the existing branch, preserving the implementation and prior review fixes. Intermediate merge `b46b127d715eb52bcf8e85cd7faf2fa1c535099d` deliberately uses `[skip ci]`, under coordinator message `dbfb2481-dbff-422a-940e-9a0c48139e75`. This first push includes main's installer paths and suppresses the unrelated automatic installer staging deployment. No installer run appeared for this branch/head. Repair changes are a separate second push without installer paths, so final-head CI runs normally. The intermediate merge is not a deployment candidate.

Main's worker modularization now owns the D1 schema in `packages/worker-core` and deployment services in `packages/app-deployment`. The repair:

- Adds the six context fields to the canonical schema; API keeps its schema re-export.
- Moves context planning/state/signing/shadow policy/retention to app-deployment and preserves the shadow release, visibility, lifecycle and ordinary-node admission fences.
- Keeps JWT signing, authenticated node transport and admin-setting resolution in narrow API adapters. Source transport now uses main's tunnel-aware backend URL helper, preserving scoped bearer/header checks and no-wake/no-recovery behavior.
- Wires the real cron through the settings adapter into context cleanup, including per-object error isolation and totals.
- Moves the independent SigV4 presigning test to the canonical package. API boundary tests keep real callback/SQLite coverage.

The Go collector, trusted-root acquisition, trailing `rel + "/."` FIFO guard, source PUT, upload diagnostics, context job admission and cancellation/spool logic are unchanged from `23b6171bd353350457c51f0692e2972cbd637521`.

## Preserve the staging-applied migration names

Coordinator message `1c2af4cd-25d7-454a-938f-24e98fb43393` supersedes the initial renumber plan. Keep `0230_publish_job_build_context.sql` and `0231_publish_job_context_shadow.sql`, byte-identical to `23b6171bd`. The coordinator verified their staging ledger records as ids **261/262**, applied on **2026-11-09**, and confirmed the columns exist. No D1 bookkeeping is needed or authorized; no staging mutation was performed by this task.

Use the repository's existing exact-file `LEGACY_ALLOWED_DUPLICATE_FILES` convention. Prefix0230 permits capacity-pool, node-tunnel and publish-context files; prefix0231 permits node-tunnel pending-create and publish-shadow files. The guard still rejects an additional unknown filename under either prefix. Renaming already-applied files would replay their ADD COLUMN statements.

Production's lexical apply order is:

1. `0230_capacity_pool_excluded_sources.sql`
2. `0230_node_cloudflare_tunnels.sql`
3. `0230_publish_job_build_context.sql`
4. `0231_node_tunnel_pending_creates.sql`
5. `0231_publish_job_context_shadow.sql`

Both dependency orders hold: node-tunnel creation precedes its pending-create ALTER, and publish context columns precede the shadow marker. Main currently ends at0237; the preserved duplicate prefixes do not require renumbering it.

## Local validation

- Dependency graph build, including worker-core and app-deployment: PASS.
- Worker-core: 98 tests / 9 files PASS.
- App-deployment: 175 tests / 13 files PASS, including signing and retention.
- Affected API: 77 tests / 9 files PASS (31 callback/release/renamed-migration tests plus 46 service/sweep tests).
- API typecheck and app-deployment build/lint: PASS. API lint initially found one import-order error in index registration; autofix applied and the full lint rerun passed.
- Full collector/config race tests PASS (2.362s / 1.083s); focused server context/source/admission race tests PASS (10.567s); targeted Go vet clean.
- Migration ordering/safety, runtime tunables, file sizes and source-contract checks: PASS.
- Independent Go merge audit and security/Cloudflare/completion review: PASS for static integration. No pending local reviewers. Live transport, staging bookkeeping and exact-SHA release approval remain open gates.

## Bounded proof plan and staging queue

Coordinator approved option (a): one TASK-mode claude-code run on a small VM, with an ordinary request to publish a tiny Compose app through genuine `build_and_publish`, requesting 0.2 vCPU / 0.5 GiB. Stop cleanly after approximately five minutes without capacity; bound task execution to ten minutes. If Claude refuses, one pre-approved identical TASK-mode Codex attempt is allowed only after fully cancelling/cleaning the first attempt and verifying installer availability. Never more than one VM at a time. Verify Instant compatibility sequentially.

No staging deployment or fixture is authorized yet. Coordinator will grant the slot after #2658 and #2691/#2693 release; no separate owner negotiation is required. During the granted window: exact-head deployment, staging-only shadow, genuine publish calls, R2 PUT/completion/HEAD descriptor plus independent GET/hash/tar inspection, shadow off, cancel tasks and chats before deleting nodes, immediate D1/R2 audit and five-minute late-VM audit, then explicit slot release. Preserve current cleanup requirements and report retained objects truthfully if an explicit retention disposition is granted.
