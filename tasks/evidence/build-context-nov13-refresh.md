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

## Migration renumbering and staging-only prerequisite

Main ends at migration 0237. Both renames preserve file contents byte-for-byte:

| Previously applied staging name | New name |
| --- | --- |
| `0230_publish_job_build_context.sql` | `0238_publish_job_build_context.sql` |
| `0231_publish_job_context_shadow.sql` | `0239_publish_job_context_shadow.sql` |

Coordinator approved these filenames, but **no authorization to mutate staging migration bookkeeping has yet been received**. A normal deployment would replay the renamed ADD COLUMN statements and fail. Before deployment, verify the old records and actual context columns, then obtain explicit coordinator OK for staging-only insertion of the renamed `d1_migrations` records. Copy the old records' `applied_at`, with an existence guard for the new names. Do not apply this bookkeeping to production; production should execute the additive migrations normally. No D1 mutation occurred during local repair.

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
