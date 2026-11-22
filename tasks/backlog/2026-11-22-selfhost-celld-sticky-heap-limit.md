# Self-host: celld stays over the V8 heap limit until restarted, silently failing sweeps

Self-hosting only. Idea `01M7W6ZTZETXE75N8NRKR3R0CF` (first seen after a sealed upgrade).

## Problem

On the shared box (deploy `b1ebe031`, unchanged since 2026-11-20 22:36Z), from 2026-11-21 08:45Z
until a celld restart at 2026-11-22 18:09Z (~33 h), every 5-minute sweep failed
`deployment_release_retention` and `gcp_price_table` with "the isolate is over its V8 heap limit,
so it stopped materializing a result set (see CELLD_V8_HEAP_LIMIT_MB)": about 800 rows in the
observability `platform_errors` table. Only the restart cleared it; nothing alerted.

## Context

Found 2026-11-22 during multi-box step 3 (`tasks/active/2026-11-22-selfhost-registry-evidence.md`).

## Acceptance Criteria

- [ ] Find what those two sweeps materialize and whether the state is per isolate or per celld
      process (reproduce on a box or the live lab)
- [ ] Bound the queries, or recover automatically (recycle the isolate or restart celld) when a
      cell reports the heap limit repeatedly
- [ ] A repeated heap-limit failure is visible to the operator (admin errors page or a health
      signal), not only as rows
