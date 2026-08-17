# SAM weekly production health review — 2026-08-17

Review window: `2026-08-10T09:03:10Z` through `2026-08-17T09:03:10Z` (exact rolling 168 hours). Prior report: `/health-reports/health-report-2026-08-10.md`. Code citations were checked against repository HEAD `6ab275923db15ee06cfef944e9db87ca34f180bb` by three local read-only Explore agents.

Freshness checks: `platform_errors` contains `17,219` window rows from `2026-08-10T09:03:20.420Z` through `2026-08-17T09:02:20.416Z`; the database had a newer row at `2026-08-17T09:05:29.621Z`, after the fixed cutoff. AI Gateway returned `162` rows from `2026-08-10T14:47:56.589Z` through `2026-08-17T09:00:37.852Z`. Both sources are current. Cloudflare retained `306` sampled Worker telemetry events from `2026-08-10T09:18:54.536Z` through `2026-08-17T07:45:28.640Z`; deployed Worker settings report log `head_sampling_rate = 0.01`, so HTTP status counts are explicitly reported as samples and are not extrapolated.

## Executive diff

### New since last run

- `chat.session_detail_load_failed` resurfaced `2` times for one session in `15.332` seconds after a `0` count last week. The two exact errors were `internal error; reference = 7val6l14gc9rgk236gofepp0` and `Internal error while starting up Durable Object storage caused object to be reset; reference = kuhq2a6skmh2r5kmegqkebli`. Both bypass the current retry classifier; follow-up remains in [`01KTK8F6DYC992T5H6WHQDGJ0S`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KTK8F6DYC992T5H6WHQDGJ0S).
- Snapshot resolution failed after workspace stop `12` times across `12` workspaces and `4` nodes from `2026-08-16T21:11:58.686Z` through `2026-08-17T08:55:46.594Z`. The exact message was `resolve snapshot devcontainer: workspace is not running/recovery (status: stopped)`. This matches the existing late-capture work in [`01M04SB5QS0ASYKDSZR8FFSY38`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M04SB5QS0ASYKDSZR8FFSY38); no duplicate idea was created.
- Four expired-JWT `500` rows came from one `/api/workspaces/:id/git-token` call burst at `2026-08-15T23:05:19Z`; the workspace no longer has a primary-D1 row. The wrong `500` classification is covered by [`01KZNGJF5ZQK48Z481WX5NSG8B`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJF5ZQK48Z481WX5NSG8B). Whether the caller was a still-live workspace is unverified.

### Still open

- Deleted Hetzner node `01KYXGTSF4B0WK4Y1DGJGY6VAV` emitted exactly `10,080` expired-JWT heartbeat errors—one per minute for all `168` hours—up `241.7%` from `2,950`. Its D1 row remains `status='deleted'`, `provider_instance_id=NULL`, and `health_status='healthy'`; the originating task still records a `30,000 ms` create timeout. Provider recovery: [`01KZNGJEPBFEVFVVN5K9ZXCYGR`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJEPBFEVFVVN5K9ZXCYGR). Callback normalization/rotation: [`01KZNGJF5ZQK48Z481WX5NSG8B`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJF5ZQK48Z481WX5NSG8B).
- TaskRunner mismatch telemetry grew from `665` warnings / `74` tasks to `973` / `149`. Current code proves this warning is emitted for the designed orchestration-handoff state; it is observability noise, not `973` D1 failures. Tracked in [`01KT90PKF6167SXZ9YZY0R26MM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90PKF6167SXZ9YZY0R26MM).
- Terminal task metadata remains inconsistent, although `failed/cancelled` rows without `completed_at` fell from `75` to `22`: `5` failed rows lack an error, `2` completed rows retain an error, and `1` completed row lacks `completed_at`. Tracked in [`01KZNGJG1DCH8DBC835Y0272P4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4).
- Lower-volume task failure buckets remain current but improved: missing branches `20 → 4` ([`01KZ3KFWET8Q9X1K82KCTWD8NK`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZ3KFWET8Q9X1K82KCTWD8NK)); Container capacity `15 → 2` ([`01KYHDXR6689KFYR8S1WNXBNYP`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KYHDXR6689KFYR8S1WNXBNYP)); Hetzner unsupported location `3 tasks / 3 errors → 1 / 2` ([`01KY008HK0GK23YHKZHHSJ71WK`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KY008HK0GK23YHKZHHSJ71WK)); agent unresponsive `9 → 3` and ACP recovery warnings `176 → 50` ([`01KZDDYEBSCNVTE1J1YPKADAH8`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZDDYEBSCNVTE1J1YPKADAH8)).

### Resolved or currently quiet

- Exact Worker errors fell from `726` to `0`; `scriptThrewException` fell from `726` to `0`. Worker volume fell from `977,951` to `771,672` (`-21.1%`).
- Hetzner account server-limit failures fell from `14` tasks / `14` platform errors to `0 / 0`; monitoring remains linked to [`01KTK8FR00448N1GRJR9W4MC9H`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KTK8FR00448N1GRJR9W4MC9H).
- Active-session mismatch rejects fell from `30` to `0`; the fail-closed rebind idea is [`01KZNGJFKACG5C2ZR2E9ZJK2DP`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJFKACG5C2ZR2E9ZJK2DP).
- Stuck-sweep pattern errors remained at `0`, and OAuth refresh-token reuse remained at `0` for a third quiet report ([`01KYHDXB42CMM8CDN7B6XWW34K`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KYHDXB42CMM8CDN7B6XWW34K)).
- `clientDisconnected:success` was `2,195 / 768,842 = 0.00285:1`, up `15.3%` from `0.00248:1` but still far below the original approximately `15:1` incident ([`01KT90P8M8YZ0CKZPH5WRH16MS`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90P8M8YZ0CKZPH5WRH16MS)).

## 1. Workers analytics — `sam-api-prod`

Cloudflare `workersInvocationsAdaptive` returned `771,672` requests, `0` Worker errors, and `921,735` subrequests.

| Outcome | Requests | Errors | Subrequests | CPU P50 / P99 | Wall P50 / P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `success` | `768,842` | `0` | `916,949` | `1,564 / 114,199` | `66,200 / 6,184,652` |
| `clientDisconnected` | `2,195` | `0` | `3,758` | `68,923 / 178,739` | `13,178,025 / 8,432,736,000` |
| `responseStreamDisconnected` | `635` | `0` | `1,028` | `98,060 / 233,686` | `32,005,716 / 21,925,177,000` |

Quantiles above and below are Cloudflare's reported integer units; the GraphQL response did not include a unit label.

| UTC date | Success | Client disconnected | Stream disconnected | Success CPU P50 / P99 | Success wall P50 / P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `2026-08-10` partial | `78,030` | `492` | `92` | `1,479 / 127,717` | `37,400 / 11,951,384` |
| `2026-08-11` | `122,159` | `244` | `147` | `1,335 / 132,361` | `37,449 / 5,367,355` |
| `2026-08-12` | `162,035` | `368` | `109` | `1,803 / 109,020` | `84,512 / 5,206,082` |
| `2026-08-13` | `138,734` | `341` | `110` | `1,680 / 105,945` | `80,654 / 4,786,859` |
| `2026-08-14` | `81,511` | `313` | `77` | `1,361 / 108,462` | `39,551 / 5,525,923` |
| `2026-08-15` | `82,548` | `232` | `56` | `1,322 / 87,650` | `68,595 / 4,424,062` |
| `2026-08-16` | `84,295` | `156` | `40` | `2,278 / 90,377` | `152,798 / 4,274,778` |
| `2026-08-17` partial | `19,530` | `49` | `4` | `1,660 / 117,597` | `49,589 / 5,311,242` |

The sampled telemetry query returned `187` fetch events; `119` contained a response status and `68` did not. The status sample was `200: 94`, `204: 16`, `301: 3`, `401: 2`, `404: 3`, and `500: 1`. The single sampled `500` was `POST /api/nodes/01KYXGTSF4B0WK4Y1DGJGY6VAV/heartbeat` at `2026-08-13T04:12:20.411Z`, matching the exact persisted JWT-error series. The two sampled `401` responses were workspace-port proxy requests. Because deployed log sampling is `0.01`, none of these sample counts is treated as an exact request total.

Interpretation: the exact Worker exception rate improved from `726 / 977,951 = 0.0742%` to `0 / 771,672 = 0%`. Disconnect volume remained low at `0.00285` client disconnects per success.

## 2. Observability — `platform_errors`

The window contains `17,219` rows: `10,198` error, `5,496` info, and `1,525` warn.

| Level / source | Count |
| --- | ---: |
| error / API | `10,178` |
| error / vm-agent | `19` |
| error / client | `1` |
| info / vm-agent | `2,809` |
| info / API | `2,687` |
| warn / API | `1,455` |
| warn / vm-agent | `70` |

Top five exact non-info message values:

| Rank | Exact message | Level / source | Count | First / last UTC | Trend vs prior |
| ---: | --- | --- | ---: | --- | --- |
| 1 | `"exp" claim timestamp check failed` | error / API | `10,084` | `2026-08-10T09:03:20.420Z` / `2026-08-17T09:02:20.416Z` | Growing from `2,950` (`+241.8%`) |
| 2 | `TaskRunner DO completed but task still in 'in_progress' — possible D1 update failure` | warn / API | `973` | `2026-08-10T09:05:43.066Z` / `2026-08-17T08:35:23.900Z` | Growing from `665` (`+46.3%`) |
| 3 | `Rejecting messages for inactive workspace 01KZWVB65B9S2NFHAYZQYEWXD3` | warn / API | `109` | `2026-08-13T06:26:58.241Z` / `2026-08-13T06:34:26.396Z` | New exact workspace; grouped signature declined |
| 4 | `Rejecting messages for inactive workspace 01KZTMNX46Y50HPBDT8TZSZ993` | warn / API | `94` | `2026-08-12T10:53:30.421Z` / `2026-08-12T11:04:06.432Z` | New exact workspace; grouped signature declined |
| 5 | `Rejecting messages for inactive workspace 01KZX3TSJX4TRQAAC9P676VDX1` | warn / API | `68` | `2026-08-13T09:13:37.528Z` / `2026-08-13T09:17:06.857Z` | New exact workspace; grouped signature declined |

The inactive-workspace signature totals `359` rejects across `7` workspaces, down from `628` across `10`; the session-mismatch signature is `0`, down from `30`. `apps/api/src/routes/workspaces/runtime.ts` rejects inactive or mismatched routes before persistence; the `359` rows therefore prove guard activity, not message acceptance.

Other exact signatures: `59` generic code-update Durable Object resets; `3` memory-limit DO resets; `50` ACP crash-recovery attempts; `12` stopped-workspace snapshot errors; `6` D1 `Failed query:` errors across three exact queries; and `2` `chat.session_detail_load_failed` rows. The ACP warning series ended at `2026-08-13T06:30:34.741Z`; the snapshot series was current through `2026-08-17T08:55:46.594Z`.

Interpretation: the `10,084` expired-JWT rows account for `98.9%` of all `10,198` error-level rows. Error volume is therefore concentrated in one per-minute node callback series plus four workspace-token rows, not distributed across unrelated signatures.

## 3. Task reliability — `sam-prod.tasks`

| Recent status | Count |
| --- | ---: |
| `completed` | `133` |
| `failed` | `60` |
| `draft` | `32` |
| `in_progress` | `2` |
| `ready` | `1` |
| `delegated` | `1` |
| `cancelled` | `0` |

Using the same comparable denominator as the prior report—completed, failed, cancelled, and in-progress—the raw recent failure rate is `60 / (133 + 60 + 0 + 2) = 30.8%`, down `6.2` percentage points from `37.0%`. Excluding `5` explicit `stopped_by_parent` rows gives `55 / (133 + 55 + 0 + 2) = 28.9%`, down from `33.3%`. The all-time failed/cancelled rate is `(1,344 + 8) / (3,642 + 1,344 + 8 + 2) = 27.1%`.

| Recent failed-task bucket | Count | First / last `created_at` UTC | Trend |
| --- | ---: | --- | --- |
| Runtime conclusively gone (`workspace_deleted`/`workspace_stopped`) | `16` | `2026-08-13T14:19:07.479Z` / `2026-08-17T08:25:24.008Z` | Current; largest bucket |
| Runtime no longer live after `240`/`480` minutes | `12` | `2026-08-10T09:16:20.283Z` / `2026-08-16T07:09:52.265Z` | Down from prior `16` at 480 minutes; signatures now include 240 minutes |
| Failed with missing `error_message` | `5` | `2026-08-12T09:25:52.980Z` / `2026-08-13T08:29:13.187Z` | Up from `2` |
| Explicit `stopped_by_parent` | `5` | `2026-08-11T22:25:13.291Z` / `2026-08-15T10:49:15.808Z` | Down from `21`; excluded from adjusted rate |
| Missing remote branch | `4` | `2026-08-12T03:08:40.251Z` / `2026-08-14T13:43:53.108Z` | Down from `20` |
| Agent unresponsive after check-in | `3` | `2026-08-12T04:37:50.560Z` / `2026-08-12T13:21:03.932Z` | Down from `9` |
| Prompt timed out after `8h` | `3` | `2026-08-14T04:40:39.375Z` / `2026-08-16T07:13:26.565Z` | New exact timeout bucket |
| Workspace unavailable / node not running | `2` | `2026-08-12T04:37:56.409Z` / `2026-08-12T04:38:01.049Z` | Current |
| Container `max_instances` | `2` | `2026-08-12T04:38:05.647Z` / `2026-08-12T06:05:39.251Z` | Down from `15` |
| OpenCode monthly spending limit | `2` | `2026-08-14T14:04:41.958Z` / `2026-08-14T14:21:58.906Z` | New provider/account limit; exact message names `$30` |
| Git-token HTTP/2 header timeout | `2` | `2026-08-10T16:01:05.735Z` / `2026-08-10T16:01:15.631Z` | One burst |
| Hetzner unsupported location `422` | `1` | `2026-08-11T08:14:52.461Z` / same | Down from `3` |
| Human-input timeout | `1` | `2026-08-12T06:59:54.398Z` / same | Down from `4` |
| Queued longer than `1,200s` | `1` | `2026-08-12T03:10:19.413Z` / same | One row |
| Agent turn ended with no result | `1` | `2026-08-16T06:11:48.677Z` / same | One row |

The `28` runtime-gone/not-live rows are `46.7%` of the `60` failures. Current code preserves terminal metadata in this specific stuck-task recovery path (`apps/api/src/scheduled/stuck-tasks.ts:1121-1155`), so those `28` rows do not explain the `22` missing `completed_at` values.

State drift among tasks created in-window is `22` failed/cancelled rows without `completed_at`, `5` failed rows without an error, `2` completed rows retaining errors, and `1` completed row without `completed_at`. The shared startup failure helper itself omits completion metadata (`apps/api/src/services/task-failure.ts:23-45`), and direct terminal writers also bypass the central helper in Instant launch (`apps/api/src/services/instant-session.ts:470-489`), attention expiry (`apps/api/src/durable-objects/project-data/attention-expiry.ts:199-211`), and mission cancellation (`apps/api/src/durable-objects/project-orchestrator/index.ts:172-192`). Aggregate rows do not prove which writer produced every inconsistency.

At cutoff, the two `in_progress` tasks were `1h45m18s` and `2m39s` old; neither exceeded the `240`-minute failure threshold visible in current task errors.

## 4. AI Gateway — `sam`

AI Gateway returned `162` fresh rows: `162` successes and `0` errors (`100%` success). There were `0` HTTP `401/403` authentication errors and `0` HTTP `429/503/529` overload errors.

| Model | Total | Success / error | HTTP status | Duration P50 / P99 / max ms |
| --- | ---: | ---: | --- | ---: |
| `@cf/zai-org/glm-5.2` | `154` | `154 / 0` | `200: 154` | `1,083 / 4,703 / 4,793` |
| `@cf/google/gemma-4-26b-a4b-it` | `8` | `8 / 0` | `200: 8` | `7,102 / 8,094 / 9,337` |

Interpretation: rows are current through `2026-08-17T09:00:37.852Z`, `152.148` seconds before cutoff. Volume fell from `316` to `162`, while the prior single HTTP `500` did not recur.

## 5. Trends vs the 2026-08-10 report

- Worker requests: `977,951 → 771,672` (`-21.1%`); Worker errors: `726 → 0`; subrequests: `1,036,776 → 921,735` (`-11.1%`).
- Disconnect ratio: `0.00248:1 → 0.00285:1` (`+15.3%`), still approximately `5,250×` below the original `15:1` incident.
- `platform_errors`: `12,837 → 17,219` (`+34.1%`); error-level rows: `3,536 → 10,198` (`+188.4%`), with expired JWTs contributing `10,084 / 10,198 = 98.9%`.
- Raw task failure rate: `37.0% → 30.8%`; adjusted rate excluding parent stops: `33.3% → 28.9%`.
- Missing branch `20 → 4`; Container capacity `15 → 2`; Hetzner server limit `14 → 0`; unsupported location `3 → 1`; agent unresponsive `9 → 3`.
- TaskRunner warning rows `665 → 973` (`+46.3%`) and distinct task IDs `74 → 149` (`+101.4%`); the code trace classifies these as repeated normal-handoff noise.
- ACP recovery attempts `176 → 50` (`-71.6%`); inactive-workspace rejects `628 / 10 workspaces → 359 / 7`.
- AI Gateway `315 / 316 → 162 / 162` successful; auth and overload errors remained `0`.

## Prioritized findings

| Severity | Finding | Evidence | Suspected root cause / code citation | Idea |
| --- | --- | --- | --- | --- |
| High | Ambiguous provider-create timeout left a deleted but still-calling Hetzner VM | Same node produced `10,080` heartbeat `500`s, exactly one/minute; task failed at `30,000 ms`; node has `provider_instance_id=NULL` | Default timeout and exact error: `packages/providers/src/provider-fetch.ts:5,43-51,122-126,218-224`; Hetzner returns ID only after POST completes: `packages/providers/src/hetzner.ts:239-268`; D1 stores ID only after return: `apps/api/src/services/nodes.ts:318-340,363-383`; missing-ID cleanup skips deletion: `apps/api/src/services/nodes.ts:509-559,607-664`. **Hypothesis:** Hetzner accepted the create before the response timed out; provider inventory was not available to verify the remote object directly. | [`01KZNGJEPBFEVFVVN5K9ZXCYGR`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJEPBFEVFVVN5K9ZXCYGR) |
| High | Expired callback JWTs are persisted as `500` and retried indefinitely | `10,084` exact errors: `10,080` node heartbeat + `4` workspace git-token; one sampled HTTP `500` matches the node route | Raw JWT expiry escapes callback verification (`apps/api/src/services/jwt.ts:207-218`; `apps/api/src/services/node-callback-auth.ts:47-63`; `apps/api/src/routes/workspaces/_helpers.ts:99-105`) and the global handler persists non-`AppError` failures as `500` (`apps/api/src/middleware/app-error-handler.ts:83-110`). The VM's 60-second ticker does not stop or back off on non-2xx (`packages/vm-agent/internal/config/config_load.go:108`; `packages/vm-agent/internal/server/health.go:52-74,215-225`). | [`01KZNGJF5ZQK48Z481WX5NSG8B`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJF5ZQK48Z481WX5NSG8B) |
| High | Fragmented terminal writers continue to violate task metadata invariants | `22` terminal rows lack `completed_at`; `5` failed lack an error; `2` completed retain errors; `1` completed lacks `completed_at` | Central helper enforces some invariants (`apps/api/src/routes/tasks/_helpers.ts:163-234`), but the shared failure helper omits them (`apps/api/src/services/task-failure.ts:23-45`) and multiple direct writers bypass it, including `apps/api/src/services/instant-session.ts:470-489` and `apps/api/src/durable-objects/project-data/attention-expiry.ts:199-211`. | [`01KZNGJG1DCH8DBC835Y0272P4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4) |
| Medium | TaskRunner normal handoff is mislabeled as possible D1 failure | `973` warnings across `149` task IDs; sample is D1 `in_progress/awaiting_followup`, DO `completed/running`, live ACP runtime | TaskRunner deliberately marks DO orchestration complete at handoff (`apps/api/src/durable-objects/task-runner/state-machine.ts:161-166,236-238`; `task-runner/index.ts:228-234`), while the sweep documents that meaning then warns on it (`apps/api/src/scheduled/stuck-tasks.ts:984-987,1003-1046`). Thirty-minute dedupe permits repeated rows (`stuck-tasks.ts:1014-1021`). | [`01KT90PKF6167SXZ9YZY0R26MM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90PKF6167SXZ9YZY0R26MM) |
| Medium | ProjectData retry classifier misses two current reset signatures | `2` failed `get_session` calls for one session in `15.332s`; both stacks include `callProjectDataWithRetry` | Classifier matches only contiguous reset/overload phrases (`apps/api/src/services/durable-object-retry.ts:3-30`); both exact production strings miss and are rethrown (`apps/api/src/services/project-data.ts:49-87`), then recorded as `500` (`apps/api/src/routes/chat.ts:245-295`). | [`01KTK8F6DYC992T5H6WHQDGJ0S`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KTK8F6DYC992T5H6WHQDGJ0S) |
| Medium | Async snapshot acceptance can race with workspace stop | `12` exact stopped-workspace errors across `12` workspaces / `4` nodes in the last `11h43m48s` of the window | VM returns `202` before background capture finishes (`packages/vm-agent/internal/server/session_snapshot.go:190-201`); later errors are promoted (`session_snapshot_coordinator.go:55-86`); devcontainer resolution rejects stopped state (`git.go:355-364`). Normal flow snapshots before stop (`apps/api/src/services/session-sleep.ts:489-520`), so the competing stop caller remains an unverified hypothesis. | [`01M04SB5QS0ASYKDSZR8FFSY38`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M04SB5QS0ASYKDSZR8FFSY38) |
| Low | Branch, Container, location, and recovery failures remain but all declined | `4` missing branches, `2` Container capacity, `1` unsupported-location task, `3` agent-unresponsive tasks; all down `66.7%`–`86.7%` | Branch precheck is best-effort (`apps/api/src/durable-objects/task-runner/workspace-branch.ts:5-10,35-74`); Container cap is `3` with no admission lease (`apps/api/wrangler.toml:369-378`; `apps/api/src/services/vm-agent-container.ts:36-64`); 422 fallback/retry is bounded (`packages/providers/src/hetzner-metadata.ts:24-38,97-118`; `packages/providers/src/hetzner.ts:124-180,208-287`). | [`01KZ3KFWET8Q9X1K82KCTWD8NK`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZ3KFWET8Q9X1K82KCTWD8NK), [`01KYHDXR6689KFYR8S1WNXBNYP`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KYHDXR6689KFYR8S1WNXBNYP), [`01KY008HK0GK23YHKZHHSJ71WK`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KY008HK0GK23YHKZHHSJ71WK), [`01KZDDYEBSCNVTE1J1YPKADAH8`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZDDYEBSCNVTE1J1YPKADAH8) |

## Watched but healthy

- AI Gateway was fresh and had `162 / 162` successful requests, `0` auth errors, and `0` overload/rate-limit errors.
- Worker execution had `0` errors across `771,672` requests; `clientDisconnected:success` remained `0.00285:1`.
- Hetzner account quota, stuck-sweep pattern errors, active-session mismatch rejects, and OAuth refresh-token reuse each had `0` matching current rows.
- Inactive-workspace routing rejected `359` batches across `7` workspaces before persistence; the grouped count declined `42.8%` from `628`.
- ACP crash-recovery warnings declined `71.6%` to `50` and had no rows after `2026-08-13T06:30:34.741Z`. Exactly `1` of the `3` unresponsive tasks shared a workspace with a recovery warning, so recovery/check-in causality is a hypothesis, not a general conclusion.
- Both active tasks were younger than `1h46m` at cutoff, versus the shortest observed liveness terminalization threshold of `240` minutes.
