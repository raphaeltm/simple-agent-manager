# SAM weekly production health review — 2026-08-31

Review window: `2026-08-24T09:11:35Z` through `2026-08-31T09:11:35Z` (exact rolling 168 hours). Baseline: `/health-reports/health-report-2026-08-24.md`.

Freshness checks: `platform_errors` has rows through `2026-08-31T09:10:15.451Z`; AI Gateway has rows through `2026-08-31T09:08:48.066Z`, and pagination reached `2026-08-23`, before the window start; Workers analytics covers the full interval. Task statuses were snapshotted at `2026-08-31T09:40:57Z`. Supplemental ProjectData telemetry was measured at `2026-08-31T09:40:22Z`. HTTP status counts are Cloudflare adaptive estimates; Worker invocation totals, D1 counts, and AI Gateway row counts are exact query results.

## Executive diff

### New since last run

- ACP activity delivery is the dominant observed ProjectData overload surface: `638 / 709` (`90.0%`) exact overload errors came from activity callbacks, while adaptive HTTP telemetry estimated `329` gone-resource activity `410`s, including `44` for one session. The VM sender launches concurrent reports and uses fixed-delay retries without a shared terminal latch (`packages/vm-agent/internal/acp/session_host_reporting.go:231-241,317-348`). The activity path may amplify an incident, but production rows do not prove it initiated one. New idea: [`01M1BKG7BE6HD81QC1Y0HBQVSJ`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1BKG7BE6HD81QC1Y0HBQVSJ).
- A replacement TaskRunner mismatch warning fired `4` times for `4` tasks between `2026-08-27 05:15:24Z` and `2026-08-30 03:10:46Z`. D1 status events show each task had already changed `delegated -> in_progress` `1.944–28.802s` before its warning, and all `4 / 4` later completed. The sweep reuses a stale candidate snapshot (`apps/api/src/scheduled/stuck-tasks.ts:277-370,977-985,1281-1346`). Existing tracker: [`01KT90PKF6167SXZ9YZY0R26MM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90PKF6167SXZ9YZY0R26MM).
- Late execution-step callbacks erased current failure metadata: all `16` recent failed rows with blank `error_message` retained a nonblank `task_status_events.reason`, had `updated_at > completed_at`, and ended with `execution_step='awaiting_followup'`. The callback clears an omitted error and has no active-status predicate (`apps/api/src/routes/tasks/callback.ts:82-120`). Existing tracker: [`01KZNGJG1DCH8DBC835Y0272P4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4).

### Still open

- ProjectData is critical at `9,468,043,264 / 10,000,000,000` bytes (`94.680%`), `+1,200,869,376` bytes (`+14.53%`) from the prior report's `8,267,173,888`. Current telemetry estimates `176,003,087 B/day` growth and `3.022` days to the limit; the window contains `709` overload errors, `42` storage-timeout resets, and `22` exhausted session-detail loads. Storage/sharding tracker: [`01M0YZNBKSKQZ47NC0K7M8N5AX`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0YZNBKSKQZ47NC0K7M8N5AX).
- Reconciliation/check-in terminalizations remain current: `6` tasks failed as `Agent became unresponsive after SAM check-in`, up from `2`, and `5` failed as workspace unavailable (`4` stale-heartbeat, `1` node-not-running). One August 30 durable-wait parent is confirmed as a false kill; whether the other `5` check-in rows or `4` stale-heartbeat rows were live is unverified. Tracker: [`01M13WC07W88NKBGB262X7PCK4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M13WC07W88NKBGB262X7PCK4).
- Conversation age continues to trigger the `1440`-minute ceiling: `40` failures versus `23`, a `73.9%` increase. The sweep calculates age from `started_at` before full liveness probing (`apps/api/src/scheduled/stuck-tasks.ts:1120-1181`); sleeping-runtime impact remains unverified. Tracker: [`01M0SHQDH3FQQG7NMFKMFPSXWM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQDH3FQQG7NMFKMFPSXWM).
- Adaptive telemetry estimated `286` HTTP `503`s, down from `856`; `275 / 286` (`96.2%`) were message-persistence paths. The server performs one non-retried ProjectData batch RPC and maps an exception to `503` (`apps/api/src/services/project-data.ts:601-622`; `apps/api/src/routes/workspaces/runtime.ts:484-509,1597-1607`). Tracker: [`01M0SHQCNRBDVKHC9JMTQZPEQ2`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQCNRBDVKHC9JMTQZPEQ2).

### Resolved or currently quiet

- Supersession bookkeeping is converging: `112` predecessor rows were benignly cancelled, `60` carry `superseded_by_task_id`, and `0` marked rows remain `in_progress`. The `52` marker-null cancellations predate the deployment; the migration intentionally left already-terminal rows untouched (`apps/api/src/db/migrations/0130_task_supersession_marker.sql:32-35`). Completed tracker: [`01M0SG7ZEE1XARK4QDG7V6HDPN`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SG7ZEE1XARK4QDG7V6HDPN).
- The old expired-JWT orphan storm fell `10,078 -> 1,334` (`-86.8%`); `1,332` rows were one node heartbeat and the stream ended `2026-08-25 07:24:21Z`. Current code maps JWT failures to `401` and the VM latches `401/403/404/410` terminally (`apps/api/src/services/jwt.ts:239-257`; `packages/vm-agent/internal/server/callback_terminal.go:12-45`). Exact cessation cause is unverified because the stream ended before that hardening deployed. Tracker: [`01KZNGJF5ZQK48Z481WX5NSG8B`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJF5ZQK48Z481WX5NSG8B).
- Stopped-runtime snapshot errors fell `199 -> 86` and ended at `2026-08-26 05:56:17Z`, about `58` minutes before PR `#1924` merged; current code treats stopped-runtime capture as a teardown race (`packages/vm-agent/internal/server/session_snapshot_coordinator.go:90-125`). Tracker: [`01M0SHQC8V34S2P0JMZR53TEJN`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQC8V34S2P0JMZR53TEJN).
- Hetzner unsupported-location failures remained `0` task rows and `0` platform rows. June baseline tracker: [`01KT90MP0FPY15WTB8T67PFTGG`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90MP0FPY15WTB8T67PFTGG).
- AI Gateway returned `336 / 337` successes (`99.70%`), `0` auth errors, and one HTTP `429`, followed by `334 / 334` successful calls.

## 1. Workers analytics — `sam-api-prod`

Exact Worker totals were `1,436,894` requests, `36` Worker runtime errors, and `1,943,139` subrequests.

| Outcome | Requests | Errors | Subrequests | CPU P50 / P99 | Wall P50 / P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `success` | `1,428,184` | `0` | `1,935,884` | `2,699 / 64,281` | `171,264 / 3,646,003` |
| `clientDisconnected` | `7,408` | `0` | `5,223` | `2,200 / 161,513` | `9,997,047 / 4,363,797,000` |
| `responseStreamDisconnected` | `1,266` | `0` | `1,954` | `90,002 / 182,904` | `38,739,350 / 18,241,866,000` |
| `scriptThrewException` | `32` | `32` | `64` | `96,591 / 169,904` | `2,518,828,800 / 9,154,374,000` |
| `exceededMemory` | `4` | `4` | `14` | `19,905 / 4,705,612` | `5,799,460 / 16,951,546` |

Quantiles are in Cloudflare-reported units. Daily success and disconnect results were:

| UTC date | Success | Client disconnected | Ratio | Stream disconnected | Script / memory errors | Success CPU P50 / P99 | Success wall P50 / P99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `2026-08-24` partial | `159,352` | `775` | `0.004863:1` | `118` | `2 / 0` | `3,369 / 76,614` | `271,165 / 3,843,924` |
| `2026-08-25` | `209,439` | `454` | `0.002168:1` | `285` | `7 / 0` | `3,132 / 76,747` | `208,607 / 2,857,754` |
| `2026-08-26` | `269,135` | `3,468` | `0.012886:1` | `467` | `7 / 0` | `2,609 / 73,731` | `188,657 / 2,876,513` |
| `2026-08-27` | `181,392` | `368` | `0.002029:1` | `201` | `0 / 0` | `1,778 / 62,811` | `38,698 / 2,547,764` |
| `2026-08-28` | `226,266` | `1,075` | `0.004751:1` | `99` | `12 / 0` | `2,441 / 46,617` | `157,892 / 4,866,683` |
| `2026-08-29` | `221,880` | `403` | `0.001816:1` | `50` | `4 / 4` | `2,617 / 44,532` | `164,732 / 3,298,857` |
| `2026-08-30` | `131,635` | `794` | `0.006032:1` | `37` | `0 / 0` | `2,689 / 49,515` | `151,948 / 5,362,940` |
| `2026-08-31` partial | `29,085` | `71` | `0.002441:1` | `9` | `0 / 0` | `1,563 / 50,085` | `37,168 / 3,319,988` |

The Worker error rate was `36 / 1,436,894 = 0.002505%`, up from `2 / 767,415 = 0.000261%`; volume rose `87.2%`. The `4` memory errors occurred at `2026-08-29 15:49Z` (`3`) and `17:18Z` (`1`). No overload/reset platform row appeared within ±`3` minutes, and Worker analytics exposes no request or DO identity, so their cause is unverified.

The overall `clientDisconnected:success` ratio was `7,408 / 1,428,184 = 0.005187:1`, approximately one disconnect per `193` successes. It is `2.22x` the prior `0.00234:1`, but remains far below the original approximately `15:1` incident. The `5,959` estimated HTTP `499`s are a different metric and are not one-for-one with Worker invocation outcomes. Existing tracker: [`01KT90P8M8YZ0CKZPH5WRH16MS`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90P8M8YZ0CKZPH5WRH16MS).

Adaptive HTTP telemetry estimated `882,340` responses: `200: 507,412`, `204: 359,542`, `499: 5,959`, `101: 3,213`, `500: 2,132`, `410: 1,081`, `202: 968`, `404: 738`, `400: 462`, `503: 286`, `409: 166`, `201: 145`, `401: 119`, `405: 85`, `302: 23`, `502: 8`, and `403: 1`. The old orphan heartbeat accounts for `1,330 / 2,132` (`62.4%`) of estimated `500`s. Of the `1,081` designed `410`s, `633` were node heartbeats, `329` activity callbacks, and `119` other terminal callbacks.

## 2. Observability — `platform_errors`

The window contains `8,992` rows: `2,310` error, `1,102` warn, and `5,580` info. By level/source: API error `2,200`, vm-agent error `110`, API warn `1,081`, vm-agent warn `21`, vm-agent info `4,981`, and API info `599`.

| Error rank | Message | Source | Count and breadth | First / last UTC | Trend vs prior |
| ---: | --- | --- | --- | --- | --- |
| 1 | `"exp" claim timestamp check failed` | API | `1,334`; `1,332` on one node heartbeat | `2026-08-24 09:12:20` / `2026-08-25 07:24:21` | `10,078 -> 1,334` (`-86.8%`), quiet |
| 2 | `Durable Object is overloaded. Requests queued for too long.` | API | `709`; `54` session IDs | `2026-08-24 22:31:29` / `2026-08-30 13:39:54` | New top-five signature, current |
| 3 | `resolve snapshot devcontainer: ... status: stopped` | vm-agent | `86`; `86` workspaces, `50` tasks | `2026-08-24 09:51:56` / `2026-08-26 05:56:17` | `199 -> 86` (`-56.8%`), resolved after deploy |
| 4 | `Durable Object reset because its code was updated.` | API | `61`; `7` session IDs | `2026-08-24 10:19:12` / `2026-08-26 23:10:53` | `75 -> 61` (`-18.7%`), quiet |
| 5 | `Durable Object storage operation exceeded timeout which caused object to be reset.` | API | `42`; `14` session IDs | `2026-08-26 04:13:06` / `2026-08-29 07:37:15` | New, current window |

Total rows fell `46.3%` from `16,740`; errors fell `78.1%` from `10,549`, warnings fell `55.1%` from `2,457`, and info rows rose `49.4%` from `3,734`. The aggregate improvement is driven by the orphan stream ending, while ProjectData pressure became the dominant current error class.

ProjectData route evidence is concentrated: the `709` overload rows split into `638` ACP activity, `37` session WebSocket, `17` node ACP heartbeat, `14` session list, and `3` session state. The `42` storage resets split into `26` activity, `5` session list, `4` WebSocket, `2` comments, `2` node heartbeat, and one each state, task submit, and cached commands. All project calls map to one DO by `idFromName(projectId)` (`apps/api/src/services/project-data.ts:127-147`). Activity makes direct, non-retried calls (`apps/api/src/routes/projects/agent-activity-callback.ts:133-140,248-260`; `apps/api/src/services/project-data.ts:1193-1200,1281-1300`). **Hypothesis:** the single `9.468 GB` hot object plus synchronized fixed-delay sender retries amplifies queue pressure; the rows do not identify which operation initiated each episode.

Of `22` `chat.session_detail_load_failed` rows, `12` wrapped overload, `8` wrapped storage reset, and `2` carried opaque Cloudflare references; `20 / 22` (`90.9%`) therefore explicitly exhausted on the two pressure signatures. Session detail uses the shared retry (`apps/api/src/services/project-data.ts:687-710`) and records the diagnostic only after the call throws (`apps/api/src/routes/chat.ts:219-270`; `apps/api/src/routes/chat-load-diagnostics.ts:34-95`). Baseline tracker: [`01KT90KPP533AKPZVG047F5MVP`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90KPP533AKPZVG047F5MVP).

Legacy TaskRunner warnings numbered `586` in the fixed scan window and ended `2026-08-25 07:30:58Z`; the `4` replacement-signature TOCTOU rows are separate. TaskRunner commits D1 `in_progress/running` atomically (`apps/api/src/durable-objects/task-runner/state-machine.ts:162-212`) before marking the DO completed at handoff (`:323-338`), while the sweep can still classify its stale pre-handoff snapshot.

Supplemental storage history contains `5,408` samples from August 26 through the review end. It ranged from `8,547,602,432` to `9,518,317,568` bytes; daily maxima grew `8.834 GB -> 8.870 -> 9.049 -> 9.252 -> 9.518` on August 26–30. Latest telemetry reports `cleanup_health='running'`, a `25`-row purge at `09:38:28Z`, and `531,956,736` bytes of headroom. The storage firebreak is bounded rather than sharding (`apps/api/src/durable-objects/project-data/storage-safety.ts:1-9`), and one cleanup slice is run per alarm (`apps/api/src/durable-objects/project-data/storage-alarm.ts:207-253`).

The D1 session index is incomplete for this project: `session_count=3,808`, `indexed_rows=2,067`, `complete=0`. Code refuses incomplete coverage and falls back to the DO (`apps/api/src/services/session-summary-index.ts:181-199`); the over-cap sync path documents that fallback (`apps/api/src/durable-objects/project-data/session-summary-sync.ts:74-81`). The UI polls the list every `30s` when WebSocket-disconnected and every `10m` when connected (`apps/web/src/pages/project-chat/useProjectChatState.ts:417-440`). Only `14` observed overload rows were session-list calls, so its share of total DO pressure is unquantified. Existing index tracker: [`01KRQTNPZPFQ8JJ2JZ5C53FAKR`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KRQTNPZPFQ8JJ2JZ5C53FAKR).

## 3. Task reliability — `sam-prod.tasks`

Status snapshot for rows created in the window:

| Status | Count |
| --- | ---: |
| `failed` | `126` |
| `cancelled` | `126` |
| `completed` | `125` |
| `draft` | `43` |
| `in_progress` | `8` |
| `ready` | `1` |

The raw recent failed-row share is `126 / (125 + 126 + 8) = 48.65%`, down `13.65` percentage points from `62.3%`. It is not a clean user-work reliability rate: `95 / 126` (`75.4%`) failures carry explicit reconciliation or age-policy messages, and conversation tasks intentionally remain active between turns. Task-mode rows were `33 failed / 124 completed / 1 in_progress = 20.89%` failed; conversation-mode rows were `93 / (93 + 1 + 7) = 92.08%`, excluding `111` conversation cancellations.

All-time status counts were `3,842 completed`, `1,623 failed`, `148 cancelled`, and `8 in_progress`; the failed/cancelled share is `(1,623 + 148) / (3,842 + 1,623 + 148 + 8) = 31.51%`, versus `28.8%` in the prior report. Excluding cancellations, the all-time failed-row share is `1,623 / (3,842 + 1,623 + 8) = 29.66%`.

| Recent failed bucket | Count | Code-grounded interpretation |
| --- | ---: | --- |
| Absolute `1440m` ceiling | `40` | Policy based on `started_at`, not measured live-runtime age (`stuck-tasks.ts:1120-1181`) |
| Conclusively gone after grace | `21` | `6` missing, `5` deleted, `5` stopped, `4` task-ACP, `1` node-not-live |
| Runtime not live after `480m` | `16` | Workspace-missing soft/hard threshold path |
| Runtime not live after `240m` | `6` | Workspace-missing threshold path |
| Agent unresponsive after check-in | `6` | Destructive attention-expiry path remains current |
| Workspace unavailable in reconciliation | `5` | `4` stale heartbeat, `1` terminal node state |
| Blank failed error | `16` | All `16` were overwritten by a late execution-step callback |
| Container `max_instances` | `3` | Recurrence versus `1`; configured cap is `3` (`apps/api/wrangler.toml:441-446`) |
| Recovery authority revoked | `3` | Explicit recovery lifecycle |
| Other singleton failures | `10` | Human-input expiry, idle cleanup, node readiness, storage reset, strict restore, build/ready, git-token, git clone, no-result |

Current liveness code makes missing/stale ProjectData ACP state inconclusive (`apps/api/src/services/task-runtime-liveness.ts:525-551`), so the `4` task-ACP rows are historical code shape and ended by August 27. Missing/deleted/stopped outcomes also consult snapshot and supersession state (`:312-371`); the window's last such row occurred August 27, so next week is the first full post-supersession watch window.

The `6` check-in failures remain actionable because candidate selection has no active durable-wait exclusion (`apps/api/src/durable-objects/project-data/reconciliation.ts:116-170`), prompt delivery is best-effort (`:283-315`), and attention expiry can terminalize without delivery proof (`apps/api/src/durable-objects/project-data/attention-expiry.ts:176-227`). For the `4` stale-heartbeat workspace-unavailable rows, no direct health probe preceded failure (`reconciliation.ts:527-646`); false termination is a hypothesis except for the separately confirmed August 30 durable-wait incident.

State drift is current: `5` failed rows lack `completed_at`, `16` failed rows have blank errors, `0` completed rows retain errors, and `144` terminal rows retain `execution_step`. The five missing-completion rows are `3` Instant capacity failures, `1` session-creation storage reset, and `1` historical pre-fix check-in. Current direct writers omit completion cleanup in `apps/api/src/services/instant-session.ts:535-548`, `apps/api/src/routes/tasks/submit.ts:477-500`, and `apps/api/src/services/task-failure.ts:34-44`; MCP `complete_task` also does not clear the step (`apps/api/src/routes/mcp/task-tools.ts:410-430`).

## 4. AI Gateway — `sam`

AI Gateway returned `337` fresh rows: `336` successes and `1` HTTP `429` (`99.70%` success). There were `0` HTTP `401/403` auth errors and `1` overload/rate-limit error. The single error was a GLM platform-feedback-triage call at `2026-08-24T11:31:14.872Z`; all `334` later calls succeeded.

| Model | Total | Success / error | Duration P50 / P99 / max ms | Latency P50 / P99 ms |
| --- | ---: | ---: | ---: | ---: |
| `@cf/zai-org/glm-5.2` | `324` | `323 / 1` | `2,164.5 / 38,904.94 / 59,813` | `2,110.03 / 38,822.50` |
| `@cf/google/gemma-4-26b-a4b-it` | `13` | `13 / 0` | `7,975 / 9,600.08 / 9,710` | `7,941.63 / 9,484.59` |

Volume rose from `151 -> 337` (`+123.2%`), while success improved from `95.36% -> 99.70%`. The latest row is `2026-08-31T09:08:48.066Z`, so this is current rather than stale Gateway history.

## 5. Trends vs the 2026-08-24 report

- Worker requests: `767,415 -> 1,436,894` (`+87.2%`); errors: `2 -> 36`; error rate: `0.000261% -> 0.002505%`.
- Disconnect ratio: `0.00234:1 -> 0.005187:1` (`2.22x`), still approximately one per `193` successes and far below the original `15:1` incident.
- Platform rows: `16,740 -> 8,992` (`-46.3%`); errors `10,549 -> 2,310` (`-78.1%`). Expired JWT fell `86.8%`, legacy TaskRunner warning rows fell `71.7%`, and stopped-snapshot rows fell `56.8%`.
- ProjectData measured size: `8,267,173,888 -> 9,468,043,264` bytes (`+14.53%`); status is `critical`, with `3.022` estimated days to the configured limit.
- Raw recent failed-row share: `62.3% -> 48.65%`; task-mode failed-row share `17.9% -> 20.89%`; all-time failed/cancelled share `28.8% -> 31.51%`.
- Runaway ceiling `23 -> 40`; agent unresponsive `2 -> 6`; blank failed errors `4 -> 16`; Container capacity `1 -> 3`. Failed rows missing `completed_at` improved `11 -> 5`; missing branch `2 -> 0`; Hetzner server limit `1 -> 0`; unsupported location remained `0`.
- Message-path HTTP `503`s fell from `824 / 856` to `275 / 286`; the proportion stayed approximately `96%`.
- AI Gateway success: `144 / 151 -> 336 / 337`; auth errors remained `0`.

## Prioritized findings

| Severity | Finding | Evidence | Suspected root cause / code citation | Idea |
| --- | --- | --- | --- | --- |
| Critical | ProjectData capacity and queue pressure are not converging | `9.468 / 10 GB`, `3.022d` projection; `709` overload + `42` reset errors; daily max reached `9.518 GB` | One project maps to one DO (`project-data.ts:127-147`); current cleanup is a bounded firebreak (`storage-safety.ts:1-9`, `storage-alarm.ts:207-253`). Sharding/retention effectiveness must be measured, not assumed. | [`01M0YZNBKSKQZ47NC0K7M8N5AX`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0YZNBKSKQZ47NC0K7M8N5AX) |
| High | ACP activity delivery amplifies pressure and repeats terminal callbacks | `638 / 709` overload rows; estimated `329` activity `410`s, top session `44` | Direct activity RPCs plus per-report goroutines/fixed retries (`agent-activity-callback.ts:133-140,248-260`; `session_host_reporting.go:231-241,317-348`). Initiation of overload is a hypothesis. | [`01M1BKG7BE6HD81QC1Y0HBQVSJ`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1BKG7BE6HD81QC1Y0HBQVSJ) |
| High | Reconciliation can destructively fail durable waits or stale-heartbeat targets | `6` unresponsive + `5` workspace-unavailable failures; one durable-wait false kill confirmed | No active-wait exclusion; best-effort send and destructive expiry (`reconciliation.ts:116-170,283-315`; `attention-expiry.ts:176-227`). Other false-kill counts are unverified. | [`01M13WC07W88NKBGB262X7PCK4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M13WC07W88NKBGB262X7PCK4) |
| High | Late callbacks corrupt terminal task metadata | `16` blank failed errors, all overwritten after terminalization; `144` terminal rows retain a step | Callback has no active-status CAS and clears omitted errors (`tasks/callback.ts:82-120`); terminal writers bypass invariants. | [`01KZNGJG1DCH8DBC835Y0272P4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4) |
| Medium | Conversation age is treated as live runaway compute | `40` ceiling failures, up from `23` | `started_at` age precedes full liveness (`stuck-tasks.ts:1120-1181`). Sleeping/restorable share is unverified. | [`01M0SHQDH3FQQG7NMFKMFPSXWM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQDH3FQQG7NMFKMFPSXWM) |
| Medium | Message persistence continues concentrated retry waves | Estimated `286` `503`s; `275` message paths | Server performs non-retried DO persistence and maps failures to retryable `503` (`project-data.ts:601-622`; `runtime.ts:484-509`). | [`01M0SHQCNRBDVKHC9JMTQZPEQ2`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQCNRBDVKHC9JMTQZPEQ2) |
| Medium | Large-project session index remains permanently incomplete | `3,808` sessions, `2,067` indexed, `complete=0`; `14` list overload errors | Incomplete coverage forces DO fallback (`session-summary-index.ts:181-199`; `session-summary-sync.ts:74-81`). Contribution to total pressure is unquantified. | [`01KRQTNPZPFQ8JJ2JZ5C53FAKR`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KRQTNPZPFQ8JJ2JZ5C53FAKR) |
| Low | TaskRunner replacement mismatch is a stale-snapshot false positive | `4` warnings; `4 / 4` already in progress and later completed | Candidate is not reread before warning persistence (`stuck-tasks.ts:277-370,977-985,1281-1346`). | [`01KT90PKF6167SXZ9YZY0R26MM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90PKF6167SXZ9YZY0R26MM) |

## Watched but healthy

- Worker execution remained available at `36 / 1,436,894 = 0.002505%` runtime errors. The `4` memory outcomes have no evidenced route/root cause and are held for trend rather than filed vaguely.
- The old approximately `15:1` client-disconnect incident did not recur; the current ratio is `0.005187:1`.
- AI Gateway had `0` auth failures, one early `429`, and `334 / 334` later successes.
- Unsupported-location, missing-branch, and Hetzner server-limit task failures each matched `0` current rows.
- Individual `410`s are designed terminal lifecycle results, not availability failures: `633` node heartbeat and `329` activity callbacks were rejected without mutation. The repeated activity delivery pattern is tracked separately.
- Snapshot-stop errors had `0` rows after the PR `#1924` deployment boundary; all `86` window rows predate it.
- The original expired-JWT node stream had `0` rows after `2026-08-25 07:24:21Z`; current callback code terminates the same status class.
- ProjectData exact `Exceeded the maximum database size.` rows fell `102 -> 0`, but this does not mean capacity is healthy: current measured usage is `94.680%`.
