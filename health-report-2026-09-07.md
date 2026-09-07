# SAM weekly production health review — 2026-09-07

Review window: `2026-08-31T09:05:17Z` through `2026-09-07T09:05:17Z` (exact rolling 168 hours). Baseline: `/health-reports/health-report-2026-08-31.md`.

Freshness checks: `platform_errors` has rows through `2026-09-07T09:03:40.168Z`; AI Gateway has rows through `2026-09-07T08:52:56.513Z`, and nine 50-row pages reached a row before the window start; Workers analytics covers the full interval. Task statuses for rows created in the window were snapshotted at `2026-09-07T09:27:31Z`. ProjectData storage telemetry was measured at `2026-09-07T08:14:05.117Z`, and the archive sweep state was current through `2026-09-07T09:02:10.807Z`. HTTP status counts are Cloudflare adaptive estimates; Worker invocation totals, D1 counts, and AI Gateway rows are exact query results.

## Executive diff

### New since last run

- One rollout-straddling node produced `40` strict-cleanup failures (`37` stopped-handoff plus `3` max-lifetime) from `2026-09-05T15:45:42Z` through `2026-09-07T08:16:26Z`. Its D1 row remains `status='destroying'`, has a provider instance ID, has `placement_credential_fingerprint=NULL`, and has no `runtime_termination_confirmed_at`. Strict deletion intentionally fails closed without the fingerprint (`apps/api/src/services/strict-node-deletion.ts:113-145`), while the scheduled cleanup has a fixed one-hour backoff and no attempt ceiling (`apps/api/src/scheduled/node-cleanup/shared.ts:442-459`; `packages/shared/src/constants/node-pooling.ts:67`). New tracker: [`01M1XKJMK2MQXKQ219TYN824H8`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKJMK2MQXKQ219TYN824H8).
- A shared Cloudflare authentication incident ran from `2026-09-03T00:30:59.001Z` through `2026-09-03T07:31:04.058Z`: AI Gateway recorded `39` HTTP `401`s, `7` tasks failed with `Backend DNS record creation failed: Authentication error`, `4` Origin CA calls produced generic failure rows, and `2` strict DNS cleanups returned `Authentication error`. DNS, Origin CA, and internal AI calls all use `CF_API_TOKEN` (`apps/api/src/services/dns.ts:394-420`; `origin-ca-certificates.ts:45-65`; `ai-proxy-shared.ts:315-343`). **Hypothesis:** the deployed token was invalid, expired, or under-scoped; the data does not identify which condition occurred. New tracker: [`01M1XKJV7Q4CJ35KPEAC4P5QXS`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKJV7Q4CJ35KPEAC4P5QXS).
- ProjectData emitted `25` exact `Durable Object exceeded its CPU time limit and was reset.` errors across `15` activity callbacks, `6` session-state reads, `2` session WebSockets, `1` node heartbeat, and `1` admin measurement. The shared transient classifier does not match this exact string (`apps/api/src/services/durable-object-retry.ts:7-14`). Whether a given CPU-heavy operation should retry is a design question; safe idempotent reads and heartbeats need an explicit decision. New tracker: [`01M1XKK208SJV9VJA4BXP2KBHT`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKK208SJV9VJA4BXP2KBHT).

### Still open

- ProjectData is `9,679,142,912 / 10,000,000,000` bytes (`96.791%`, degraded), `211,099,648` bytes (`2.23%`) above the prior report. It peaked at `10,255,826,944` bytes and has since fallen `576,684,032` bytes (`5.62%`). The window still contains `237` overload and `25` CPU-reset errors, while `98` published archive migrations now exactly match `98` archive-shard locations. Capacity tracker: [`01M0YZNBKSKQZ47NC0K7M8N5AX`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0YZNBKSKQZ47NC0K7M8N5AX).
- Activity delivery remains the largest ProjectData overload route: `202 / 237` (`85.2%`) exact overload rows. Adaptive HTTP telemetry estimated `3,950` activity `410`s and `261` activity `500`s. Worker-side admission/coalescing exists (`apps/api/src/services/acp-activity-admission.ts:230-312,416-480`), while the VM still launches independent sends and has no shared terminal latch (`packages/vm-agent/internal/acp/session_host_reporting.go:231-251,317-378`). Tracker: [`01M1BKG7BE6HD81QC1Y0HBQVSJ`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1BKG7BE6HD81QC1Y0HBQVSJ).
- `7` recent task rows now carry `Agent became unresponsive after SAM check-in`; the seventh task was created inside the window but terminalized after the analytics cutoff at `2026-09-07T09:17:26.758Z`. Attention expiry can still transition a task without a fresh shared runtime-liveness check (`apps/api/src/durable-objects/project-data/attention-expiry.ts:176-200`). Tracker: [`01M13WC07W88NKBGB262X7PCK4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M13WC07W88NKBGB262X7PCK4).
- Late callbacks still corrupt terminal metadata: `2` failed rows have blank errors, both retained a status-event reason `Agent prompt failed`, both have `updated_at > completed_at`, and both end at `execution_step='awaiting_followup'`. In total, `125` terminal rows retain an execution step and `1` completed row retains a prior model-version error. The callback permits step-only writes against a loaded terminal status and clears omitted errors (`apps/api/src/routes/tasks/callback.ts:95-110`; `apps/api/src/routes/tasks/_helpers.ts:190-213`). Tracker: [`01KZNGJG1DCH8DBC835Y0272P4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4).
- The absolute `1440`-minute ceiling produced `32` task failures, down from `40`. The sweep calculates age from `started_at` and intentionally skips full liveness after 24 hours (`apps/api/src/scheduled/stuck-tasks.ts:1116-1181`). Whether any of the `32` tasks held billable live compute is unverified. Tracker: [`01M0SHQDH3FQQG7NMFKMFPSXWM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQDH3FQQG7NMFKMFPSXWM).
- Adaptive message-persistence `503`s fell to `129`, and all `129 / 129` were `/api/workspaces/:id/messages` paths. The route still performs a non-retried ProjectData batch call and maps the exception to a retryable `503` (`apps/api/src/services/project-data.ts:601-622`; `apps/api/src/routes/workspaces/runtime.ts:484-509,1597-1607`). Tracker: [`01M0SHQCNRBDVKHC9JMTQZPEQ2`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQCNRBDVKHC9JMTQZPEQ2).
- Worker `clientDisconnected:success` worsened to `16,246 / 1,248,723 = 0.013010:1`, about one disconnect per `77` successes and `2.51x` the prior ratio. The September 7 partial day contributed `9,787` disconnect outcomes and `9,884` adaptive HTTP `499`s. Tracker: [`01KT90P8M8YZ0CKZPH5WRH16MS`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90P8M8YZ0CKZPH5WRH16MS).
- The replacement TaskRunner mismatch warning fired `2` times for `2` tasks. Both tasks had already transitioned `delegated -> in_progress` `3.3–5.7s` before the warning and both later completed. The sweep retains a stale candidate snapshot before classification (`apps/api/src/scheduled/stuck-tasks.ts:277-370,977-985,1281-1346`). Tracker: [`01KT90PKF6167SXZ9YZY0R26MM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90PKF6167SXZ9YZY0R26MM).

### Resolved or currently quiet

- The session summary index is now complete: `session_count=4,005`, `indexed_rows=4,005`, `complete=1`, versus `3,808 / 2,067 / complete=0` in the prior report. The list route uses the D1 index when coverage is complete and fresh (`apps/api/src/routes/chat-session-list.ts:74-107`). Tracker: [`01KRQTNPZPFQ8JJ2JZ5C53FAKR`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KRQTNPZPFQ8JJ2JZ5C53FAKR).
- The `18` workspace-unavailable reconciliation failures (`12` stale heartbeat, `5` node not running, `1` unhealthy) all terminalized before PR `#2015` deployed at `2026-09-04T23:13:32Z`; `0` matching task failures followed that deployment. Current code treats a stale heartbeat as weak evidence and requires a bounded health probe (`apps/api/src/services/task-runtime-liveness.ts:106-179,477-529`). The check-in-expiry path remains open separately.
- AI Gateway's `39` authentication failures ended at `2026-09-03T07:31:04.058Z`; all `224` later calls succeeded through `2026-09-07T08:52:56.513Z`. Current Gateway status is healthy, while credential validation/alerting remains actionable under [`01M1XKJV7Q4CJ35KPEAC4P5QXS`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKJV7Q4CJ35KPEAC4P5QXS).
- `chat.session_detail_load_failed` fell `22 -> 8`; `6 / 8` wrapped overload, `1` wrapped a DO startup reset, and `1` wrapped a CPU reset. The original code-update reset message fell `61 -> 1`. Completed tracker: [`01KT90KPP533AKPZVG047F5MVP`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90KPP533AKPZVG047F5MVP).
- Hetzner unsupported-location failures remained `0` task rows and `0` platform rows. Completed tracker: [`01KT90MP0FPY15WTB8T67PFTGG`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90MP0FPY15WTB8T67PFTGG).
- One D1 network interruption produced `41` error rows for `41` request IDs across `5` paths in `71ms` at `2026-09-02T23:23:48.747Z`; no later matching row occurred through `2026-09-07T09:03:40.168Z`. No idea was filed for this single recovered burst.

## 1. Workers analytics — `sam-api-prod`

Exact Worker totals were `1,265,819` requests, `13` Worker runtime errors, and `1,400,919` subrequests.

| Outcome | Requests | Errors | Subrequests | CPU P50 / P99 | Wall P50 / P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `success` | `1,248,723` | `0` | `1,394,816` | `1,992 / 59,154` | `102,157 / 3,658,989` |
| `clientDisconnected` | `16,246` | `0` | `4,589` | `1,069 / 134,256` | `9,997,669 / 2,143,633,000` |
| `responseStreamDisconnected` | `837` | `0` | `1,360` | `82,508 / 176,721` | `24,700,552 / 23,834,943,000` |
| `scriptThrewException` | `8` | `8` | `16` | `106,305 / 160,073` | `321,422,370 / 13,201,071,000` |
| `internalError` | `5` | `5` | `138` | `195,187 / 322,797` | `899,972,000 / 899,973,400` |

Quantiles are Cloudflare-reported units. Daily results were:

| UTC date | Success | Client disconnected | Ratio | Stream disconnected | Runtime errors | Success CPU P50 / P99 | Success wall P50 / P99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `2026-08-31` partial | `82,975` | `1,818` | `0.021910:1` | `85` | `0` | `3,067 / 59,576` | `159,884 / 8,677,742` |
| `2026-09-01` | `123,223` | `2,134` | `0.017318:1` | `82` | `2` | `2,685 / 58,425` | `129,631 / 7,329,103` |
| `2026-09-02` | `150,771` | `841` | `0.005578:1` | `138` | `5` | `1,860 / 67,816` | `45,544 / 4,389,045` |
| `2026-09-03` | `221,426` | `632` | `0.002854:1` | `95` | `2` | `1,357 / 59,341` | `31,847 / 3,011,692` |
| `2026-09-04` | `323,831` | `589` | `0.001819:1` | `148` | `2` | `2,194 / 54,396` | `109,503 / 3,040,735` |
| `2026-09-05` | `119,806` | `321` | `0.002679:1` | `176` | `1` | `1,682 / 54,787` | `28,574 / 3,104,521` |
| `2026-09-06` | `94,435` | `124` | `0.001313:1` | `93` | `1` | `1,698 / 65,311` | `29,237 / 3,764,370` |
| `2026-09-07` partial | `132,256` | `9,787` | `0.074000:1` | `20` | `0` | `5,480 / 47,838` | `501,852 / 3,953,428` |

The runtime error rate was `13 / 1,265,819 = 0.001027%`, down from `36 / 1,436,894 = 0.002505%`. The overall disconnect ratio rose `0.005187:1 -> 0.013010:1`; it remains far below the original approximately `15:1` incident, but the September 7 partial-day ratio is `0.074000:1`, about one disconnect per `13.5` successes.

Adaptive HTTP telemetry estimated `687,836` responses: `200: 393,934`, `204: 268,487`, `499: 15,243`, `410: 4,221`, `101: 2,344`, `202: 972`, `401: 767`, `400: 592`, `404: 511`, `500: 370`, `405: 129`, `503: 129`, `201: 53`, `502: 46`, `409: 20`, `302: 8`, `403: 7`, and `304: 3`. The `15,243` status `499`s split into `10,023` activity, `3,568` workspace-message, `1,127` node-heartbeat, `90` session-WebSocket, and `435` other paths. No repository code emits `499`; causality is unverified, and HTTP status estimates are not one-for-one with Worker invocation outcomes.

## 2. Observability — `platform_errors`

The window contains `6,461` rows: `518` error, `290` warn, and `5,653` info. By level/source: API error `480`, vm-agent error `37`, client error `1`, API warn `230`, vm-agent warn `60`, API info `907`, and vm-agent info `4,746`.

| Error rank | Exact message | Source | Count and breadth | First / last UTC | Trend vs prior |
| ---: | --- | --- | --- | --- | --- |
| 1 | `Durable Object is overloaded. Requests queued for too long.` | API | `237`; `24` session IDs | `2026-08-31 10:02:17` / `2026-09-07 04:56:19` | `709 -> 237` (`-66.6%`), still current |
| 2 | `D1_ERROR: Network connection lost.` | API | `41`; `41` request IDs, `5` paths, one `71ms` burst | `2026-09-02 23:23:48.747` / `23:23:48.818` | new, recovered |
| 3 | `Failed to destroy stopped handoff node: ... exact provider credential binding is missing` | API | `37`; one node | `2026-09-05 16:50:41` / `2026-09-07 06:15:54` | new, recurring; `40` including max-lifetime variant |
| 4 | `Durable Object exceeded its CPU time limit and was reset.` | API | `25`; `12` session IDs | `2026-09-02 14:24:34` / `2026-09-05 23:15:21` | new, no rows after Sep 5 |
| 5 | `chat.session_detail_load_failed` | API | `8`; `4` session IDs | `2026-08-31 12:10:47` / `2026-09-04 21:38:56` | `22 -> 8` (`-63.6%`) |

Rows fell `8,992 -> 6,461` (`-28.1%`); errors fell `2,310 -> 518` (`-77.6%`); warnings fell `1,102 -> 290` (`-73.7%`); info rows rose `5,580 -> 5,653` (`+1.3%`). Storage-timeout resets fell `42 -> 4` (`-90.5%`), and exact code-update resets fell `61 -> 1` (`-98.4%`).

The `237` overload rows split into `202` activity callbacks, `17` session WebSockets, `16` node ACP heartbeats, `1` session detail, and `1` session list. Activity lookup/persistence and node heartbeat remain direct calls (`apps/api/src/services/project-data.ts:1561-1669,1721-1738`); session list, detail, and WebSocket use the bounded wrapper (`apps/api/src/services/project-data.ts:337-389,800-879,2287-2316`).

Storage history has `3,207` samples in the window and ranged from `9,466,048,512` to `10,255,826,944` bytes. Daily maxima were `9,613,344,768`, `9,745,899,520`, `9,794,232,320`, `9,908,338,688`, `10,202,959,872`, `10,255,826,944`, `10,211,606,528`, and `9,679,142,912` bytes for the eight partial/full UTC dates. Latest telemetry reports `status='degraded'`, `growth_rate_bytes_per_day=30,242,544.61`, `estimated_days_to_limit=10.609`, and a last `97`-row purge at `2026-09-04T09:14:01.746Z`. These are telemetry fields, not independent forecasts.

Archive-sharding state is consistent at the snapshot: `98` published migrations, `98` archive-shard locations, `8` root locations, `0` migrating locations, a closed breaker, and a successful latest sweep. Five published rows retain a stale pre-fix `error_code='Error'`; current state is still `published`. There are `5` frozen `precopy_refused` and `4` frozen `operator_abandoned` migrations. The migration deletes archived message/grouped/FTS data only after manifest and terminal-version proofs while retaining the root session anchor (`apps/api/src/durable-objects/project-data/archive-sharding.ts:2065-2150`). Root-only ACP state/activity/WebSocket data remains on the root object.

## 3. Task reliability — `sam-prod.tasks`

Status snapshot for the `405` rows created in the window:

| Status | Count |
| --- | ---: |
| `completed` | `117` |
| `failed` | `108` |
| `draft` | `95` |
| `cancelled` | `71` |
| `in_progress` | `14` |

The raw recent failed-row share is `108 / (117 + 108 + 14) = 45.19%`, down `3.46` percentage points from `48.65%`. It is not a clean user-work success rate: `57 / 108` failures are explicit age, reconciliation, or liveness policy outcomes, and conversation tasks intentionally remain active between turns. Task-mode rows were `59 failed / 115 completed / 6 in_progress = 32.78%` failed, up `11.89` points; conversation-mode rows were `49 / (49 + 2 + 8) = 83.05%`, excluding `66` conversation cancellations.

All-time status counts were `3,959 completed`, `1,736 failed`, `221 cancelled`, and `14 in_progress`; the failed/cancelled share is `(1,736 + 221) / (3,959 + 1,736 + 221 + 14) = 33.00%`, up `1.49` points from `31.51%`. Excluding cancellations, the all-time failed-row share is `1,736 / (3,959 + 1,736 + 14) = 30.41%`.

| Recent failed bucket | Count | Evidence-grounded interpretation |
| --- | ---: | --- |
| Absolute `1440m` ceiling | `32` | Policy terminalization from `started_at`; full liveness skipped after 24h (`stuck-tasks.ts:1116-1181`) |
| Reconciliation workspace unavailable | `18` | `12` stale heartbeat, `5` node not running, `1` unhealthy; all ended before PR `#2015` production deploy |
| Human input expired | `8` | Exact `Human input request expired after timeout` rows |
| Backend DNS authentication | `7` | Exact failures from `2026-09-03T02:01:36Z` to `06:44:46Z`; VM allocation precedes DNS (`nodes.ts:372-453`) |
| Agent unresponsive after check-in | `7` | Six terminalized inside the analytics window; one in-window task terminalized at `09:17:26Z` after cutoff |
| Provider usage/session limits | `7` | `5` Codex usage-limit and `2` Claude session-limit rows |
| Container `max_instances` | `4` | Exact platform-capacity failures, up from `3` |
| Runtime no longer live / conclusively gone | `8` | `6` workspace-missing, `1` node-not-live, `1` workspace-deleted |
| Stuck queued selection | `4` | Four exact `queued` threshold failures between `1,296s` and `1,500s` |
| Blank failed error | `2` | Both overwritten after terminalization by late `awaiting_followup` callbacks |
| Agent-start error | `2` | Exact `Agent failed to start for task-driven session` rows |
| Devcontainer setup | `2` | One no-space failure and one missing-image-manifest failure |
| Other singletons | `7` | Model-version incompatibility, workspace-ready timeout, TaskRunner deploy reset, provisioning timeout, prompt timeout, cancel grace, and D1 session-link failure |

All-time exact-message leaders were `369` legacy 240-minute running ceilings, `93` conclusive workspace-deleted failures, `70` legacy 480-minute awaiting-followup timeouts, `56` Hetzner server-limit failures, `56` current 1440-minute awaiting-followup ceilings, and `54` current 1440-minute running ceilings. Current unsupported-location count is `0`, despite `87` all-time exact unsupported-location rows (`46 + 41`).

State drift at the snapshot is `5` failed rows missing `completed_at`, `2` failed rows with blank errors, `1` completed row retaining an error, and `125` terminal rows retaining `execution_step`. Canonical terminal transition clears step and completed-task errors (`apps/api/src/services/task-terminal-transition.ts:72-75,160-217`); direct writers bypass that invariant, including MCP completion (`apps/api/src/routes/mcp/task-tools.ts:410-430`), Instant launch failure (`apps/api/src/services/instant-session.ts:535-548`), and queued-task failure (`apps/api/src/services/task-failure.ts:34-44`).

## 4. AI Gateway — `sam`

AI Gateway returned `430` fresh rows: `391` successes and `39` HTTP `401` errors (`90.93%` success). There were `0` HTTP `429` and `0` HTTP `5xx` rows.

| Model | Total | Success / error | Statuses | Duration P50 / P99 / max ms | Latency P50 / P99 ms |
| --- | ---: | ---: | --- | ---: | ---: |
| `@cf/zai-org/glm-5.2` | `428` | `390 / 38` | `390×200`, `38×401` | `2,376.5 / 34,722.88 / 69,688` | `2,118.70 / 34,502.98` |
| `@cf/google/gemma-4-26b-a4b-it` | `2` | `1 / 1` | `1×200`, `1×401` | `4,735 / 9,266.52 / 9,359` | `4,666.32 / 9,206.27` |

The `39` errors split into `27` platform-feedback-triage, `11` task-title, and `1` session-summarize calls. The common credential path is code-proven: title/summary use `Authorization: Bearer ${env.CF_API_TOKEN}` (`apps/api/src/services/ai-proxy-shared.ts:315-343`), and debug/triage uses the same secret (`apps/api/src/services/debug-agent.ts:393-427`). The reason that secret failed for seven hours is unverified. Task-title treats `401` as non-retryable (`apps/api/src/services/task-title.ts:188-201,346-375`), session summary falls back heuristically (`apps/api/src/services/session-summarize.ts:317-350`), and diagnosis policy retries only `429`, `5xx`, timeout, or network failures (`apps/api/src/services/diagnosis-runner-policy.ts:17-26`).

## 5. Trends vs the 2026-08-31 report

- Worker requests: `1,436,894 -> 1,265,819` (`-11.9%`); errors: `36 -> 13` (`-63.9%`); error rate: `0.002505% -> 0.001027%`.
- Disconnect ratio: `0.005187:1 -> 0.013010:1` (`2.51x`); adaptive HTTP `499`s: `5,959 -> 15,243` (`2.56x`).
- Platform rows: `8,992 -> 6,461` (`-28.1%`); errors `2,310 -> 518` (`-77.6%`); warnings `1,102 -> 290` (`-73.7%`).
- ProjectData latest size: `9,468,043,264 -> 9,679,142,912` bytes (`+2.23%`), after a window peak of `10,255,826,944`; archive-shard locations reached `98`.
- Overload errors: `709 -> 237` (`-66.6%`); activity overload rows `638 -> 202` (`-68.3%`); storage-timeout resets `42 -> 4` (`-90.5%`); chat detail failures `22 -> 8` (`-63.6%`).
- Message-path HTTP `503`s: `275 -> 129` (`-53.1%`); all current `503`s were message paths.
- Raw recent failed share: `48.65% -> 45.19%`; task-mode failed share `20.89% -> 32.78%`; all-time failed/cancelled share `31.51% -> 33.00%`.
- Absolute ceiling `40 -> 32`; agent unresponsive `6 -> 7`; blank failed errors `16 -> 2`; Container capacity `3 -> 4`; failed rows missing `completed_at` remained `5`.
- AI Gateway volume `337 -> 430` (`+27.6%`); success `99.70% -> 90.93%` due to the `39`-row 401 cluster; `224 / 224` later calls succeeded.
- Session index coverage improved from `2,067 / 3,808, complete=0` to `4,005 / 4,005, complete=1`.

## Prioritized findings

| Severity | Finding | Evidence | Suspected root cause / code citation | Idea |
| --- | --- | --- | --- | --- |
| Critical | ProjectData remains above its configured degraded threshold while root-object failures persist | Latest `9.679 / 10.000 GB`; peak `10.256 GB`; `237` overload + `25` CPU reset | Archive sharding has removed transcript rows for `98` sessions, but root ACP/session state remains; routing/deletion proof at `project-data-archive-routing.ts:222-276` and `archive-sharding.ts:2065-2150` | [`01M0YZNBKSKQZ47NC0K7M8N5AX`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0YZNBKSKQZ47NC0K7M8N5AX) |
| High | Legacy node cleanup repeats forever without exact credential proof | `40` failures for one node; row remains destroying with NULL fingerprint and no termination proof | Fail-closed fence plus unbounded hourly retry (`strict-node-deletion.ts:113-145`; `node-cleanup/shared.ts:298-313,442-459`) | [`01M1XKJMK2MQXKQ219TYN824H8`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKJMK2MQXKQ219TYN824H8) |
| High | One shared Cloudflare credential incident affected AI, DNS creation, and cleanup | `39` AI 401s, `7` failed tasks, `4` cert failures, `2` cleanup auth errors | All three use `CF_API_TOKEN`; precise token defect is a hypothesis (`dns.ts:394-420`; `origin-ca-certificates.ts:45-65`; `ai-proxy-shared.ts:315-343`) | [`01M1XKJV7Q4CJ35KPEAC4P5QXS`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKJV7Q4CJ35KPEAC4P5QXS) |
| High | Reconciliation check-in expiry can still fail a task without fresh shared liveness | `7` recent failed rows; latest at `2026-09-07T09:17:26Z` | Direct terminal transition in `attention-expiry.ts:176-200`; current prompt-work evidence only at `:280-425` | [`01M13WC07W88NKBGB262X7PCK4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M13WC07W88NKBGB262X7PCK4) |
| High | VM activity sender still repeats terminal and transient callback traffic | `202 / 237` overloads, `3,950` activity 410s, `261` activity 500s | Independent goroutines, per-send 4xx stop, fixed retry (`session_host_reporting.go:231-251,317-378`) | [`01M1BKG7BE6HD81QC1Y0HBQVSJ`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1BKG7BE6HD81QC1Y0HBQVSJ) |
| High | Direct writers and late callbacks violate terminal task metadata invariants | `2` blank failed errors, `1` completed-with-error, `125` terminal steps, `5` failed without completion | Step-only callback accepts terminal status and nulls omitted error; raw terminal updates bypass canonical helper (`tasks/callback.ts:95-110`; `task-tools.ts:410-430`) | [`01KZNGJG1DCH8DBC835Y0272P4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4) |
| Medium | Exact DO CPU reset is absent from transient classification | `25` exact CPU resets; `1` surfaced as session-detail failure | Classifier and tests omit exact string (`durable-object-retry.ts:7-14`; `durable-object-retry.test.ts:13-72`) | [`01M1XKK208SJV9VJA4BXP2KBHT`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKK208SJV9VJA4BXP2KBHT) |
| Medium | Conversation age remains a task terminalization policy | `32` failures, down from `40` | `started_at` age and 24h no-liveness branch (`stuck-tasks.ts:1116-1181`) | [`01M0SHQDH3FQQG7NMFKMFPSXWM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQDH3FQQG7NMFKMFPSXWM) |
| Medium | Client disconnect outcomes spiked on the final partial day | Overall `16,246 / 1,248,723`; Sep 7 `9,787 / 132,256`; HTTP `499` `15,243` | No code emits `499`; route counts show `10,023` activity and `3,568` message paths, but cause is unverified | [`01KT90P8M8YZ0CKZPH5WRH16MS`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90P8M8YZ0CKZPH5WRH16MS) |
| Medium | Message persistence continues to expose retry waves | `129` adaptive HTTP 503s, all message paths | Non-retried ProjectData batch plus generic 503 mapping (`project-data.ts:601-622`; `runtime.ts:484-509`) | [`01M0SHQCNRBDVKHC9JMTQZPEQ2`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQCNRBDVKHC9JMTQZPEQ2) |
| Low | TaskRunner replacement mismatch remains a stale-snapshot false positive | `2` warnings; both already in progress and later completed | Candidate is not reread immediately before diagnostic (`stuck-tasks.ts:277-370,1281-1346`) | [`01KT90PKF6167SXZ9YZY0R26MM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90PKF6167SXZ9YZY0R26MM) |

## Watched but healthy

- Worker execution remained available at `13 / 1,265,819 = 0.001027%` runtime errors; no runtime error occurred on the September 7 partial day.
- AI Gateway had `224 / 224` successful calls after its last 401 and `0` `429`/`5xx` rows for the full window.
- Archive sharding ended with a closed breaker, a successful sweep, `98` published migrations, `98` archive-shard locations, and `0` migrating locations.
- Session index coverage is exact at `4,005 / 4,005` with `complete=1`.
- The old stale-node reconciliation terminalization signatures produced `0` task failures after PR `#2015` deployed.
- Unsupported Hetzner location failures, expired-JWT platform errors, and exact database-size-limit platform errors each had `0` current rows.
- Message `503`s fell `53.1%`, overload errors fell `66.6%`, storage-timeout resets fell `90.5%`, and chat session-detail failures fell `63.6%`.
- Individual HTTP `410`s are designed terminal-resource results. The actionable signal is repetition: `3,950 / 4,221` (`93.6%`) were activity callbacks, which the VM can resend after a per-request terminal response.
