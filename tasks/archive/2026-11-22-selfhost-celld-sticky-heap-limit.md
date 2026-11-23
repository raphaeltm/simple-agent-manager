# Self-host: celld stays over the V8 heap limit until restarted, silently failing sweeps

Self-hosting only; hosted SAM (Cloudflare) is unaffected. Idea `01M7W6ZTZETXE75N8NRKR3R0CF`.
Task `01M828M3S4HZ5R003DFWQSS7ZD`, branch `sam/self-host-reliability-celld-qss7zd`.

## Problem

On the shared box (deploy `b1ebe031`, unchanged since 2026-11-20 22:36Z), from 2026-11-21 08:45Z
until a celld restart at 2026-11-22 18:09Z (~33 h), every 5-minute sweep failed
`deployment_release_retention` and `gcp_price_table` with "the isolate is over its V8 heap limit,
so it stopped materializing a result set (see CELLD_V8_HEAP_LIMIT_MB)": about 800 rows in the
observability `platform_errors` table. Only the restart cleared it; nothing alerted.

## Research findings (measured)

1. **One cell isolate holds everything.** Box `/state` (celld internal port, 2026-11-22 18:48Z,
   39 min after restart): the only live cell isolate held all 7 resident cells: `.cron` (SAM's
   scheduled handler), two `__D1Database`, `__KvNamespace`, `ProjectData`, two `HostedGitRepo`.
   Heap 106-112 MB physical at idle; limit 128 MB (celld default).
2. **It is never recycled.** celld retires only cell-free isolates (`logic/isolate.rs` `retire`);
   `CELLD_IDLE_EVICT_S` is unset and cron fires every minute, so these cells never leave. The 30 s
   isolate recycling the API relies on applies to stateless isolates only.
3. **Baseline sits on celld's recovery line.** celld lifts condemnation when used heap < 75% of the
   limit (96 MB; `js.rs` `HEAP_RECOVERY_SHARE`, `recover_heap` runs before every event).
   celld compiles the module from an on-heap string (`js/modules.rs` `v8::String::new`), its
   esbuild run does not minify (~32 M chars for SAM), and esbuild keeps comments in object
   literals verbatim: ~1,440 chars above U+00FF (~970 SAM sources, ~470 deps) make V8 store the
   source two-byte (~64 MB). Node V8 measurement of the same bundle: ~38 MB heap after import.
4. **Local reproduction on pinned celld 0.6.3** (`.tmp/heapexp/exp.ts`, celld-lab + MinIO):
   - 32 M chars, one-byte: 54.5 MB idle; two-byte: 85.5 MB idle (60 MB spike condemned then
     recovered).
   - 40 M chars two-byte: 105.7 MB idle, a 40 MB spike: every later DO SQL `.toArray()` fails with
     the exact box error for the whole window (sticky, no leak).
   - Same baseline with `CELLD_V8_HEAP_LIMIT_MB=384` and a 300 MB spike: condemned, then
     `isolate_heap_recovered` at the next event.
5. **The two sweeps are victims, not the cause.** Both fail on their first KV read (a tiny
   last-run key, `d1-retention.ts runIntervalGatedSweep`, `gcp-price-table.ts readStored`); the
   price table is small (regions x series x 2 numbers); retention deletes through bounded
   `UPDATE/DELETE ... LIMIT` statements and hands no rows to JS.
6. **Why silent.** Failed-sweep notifications read KV first (1,202
   `cron.failed_sweep_notification_throttle_failed` on the box); `provider_orphan` and
   `stuck_task` swallow it as `*_read_failed`; celld logs nothing on condemnation; the celld
   container has no health check, and Docker would not restart an unhealthy container anyway.
7. **Supervisor.** `deploy/selfhost/celld/start.sh` is PID 1 of the celld container and already
   reads every line celld prints (log redaction); the egress fence blocks celld's uid from
   127.0.0.1:8080, so it cannot poll a health URL. Restart policy is `unless-stopped`.
8. No new Worker Env scalar is allowed (`pnpm quality:runtime-tunables`), so the restart threshold
   is box config (compose env), not Worker config.

## Implementation checklist

- [x] Pure move: capacity-pool continuation cron out of `handler.ts` (500-line ceiling)
- [x] `scheduled/isolate-heap-limit.ts`: count consecutive ticks whose sweeps failed with celld's
      refusal; reset on a clean tick; log `cron.isolate_heap_limit` + `consecutiveTicks`; persist a
      platform error (D1); no KV
- [x] Wire into the operational tick; `isolateHeapLimitTicks` in `cron.completed`
- [x] `docker-compose.yml`: `CELLD_V8_HEAP_LIMIT_MB` default 384; `SAM_CELLD_HEAP_RESTART_TICKS`
      default 2
- [x] `start.sh`: on `consecutiveTicks >= SAM_CELLD_HEAP_RESTART_TICKS`, SIGTERM celld, exit 75
- [x] Vertical test through real `scheduled()` (count, reset, non-heap control) — proven red with
      the reset removed and with the call removed
- [x] Fence-lab test of the real `start.sh` (restart, below-threshold and spoofed-line controls) —
      proven red with the restart disabled
- [x] Rule-81 test: retention backlog of 2 batches + 1 at default bounds through the sweep's own
      scheduled entry point (`runScheduledDeploymentReleaseRetention`, with its interval gate); no
      statement returns rows to JS
- [x] README troubleshooting section updated
- [x] Review fixes: threshold parsed base 10, one-shot restart, pre-`pid` request honoured; the
      fence-lab test now feeds start.sh lines produced by the real detector + logger behind celld's
      recorded console prefix (stdout and stderr, `0` disables); `celld-heap-marker.live.test.ts`
      pins the marker against the pinned celld binary
- [x] Live: box upgraded to the branch 2026-11-22 19:19:58Z (`selfhost:upgrade`, encrypted
      pre-upgrade backup); celld's process env has `CELLD_V8_HEAP_LIMIT_MB=384` and
      `SAM_CELLD_HEAP_RESTART_TICKS=2`; sweeps after it: 0 failed, `isolateHeapLimitTicks:0`
- [ ] Return the box to main after merge
- [x] Follow-ups: idea 01M82BATKM4PS4Z0GGR27QCY1N (shrink the celld bundle); upstream celld note
      on idea 01M7W6ZTZETXE75N8NRKR3R0CF

## Acceptance Criteria

- [x] Find what those two sweeps materialize and whether the state is per isolate or per celld
      process (reproduce on a box or the live lab)
- [x] Bound the queries, or recover automatically (recycle the isolate or restart celld) when a
      cell reports the heap limit repeatedly
- [x] A repeated heap-limit failure is visible to the operator (admin errors page or a health
      signal), not only as rows

## Reconciliation (2026-11-23, weekly queue reconciliation)

- Shipped in [#2980](https://github.com/raphaeltm/simple-agent-manager/pull/2980) (merged 2026-11-22, deployed as `2e22a317f`). The minified-bundle follow-up is idea 01M82BATKM4PS4Z0GGR27QCY1N.
- Production deploys from `main` have succeeded continuously since then (latest `7d40cfb2d`, 2026-11-23).
- 1 line(s) stay unticked. They are verification or reporting steps that were not re-checked here; this record does not claim them.
