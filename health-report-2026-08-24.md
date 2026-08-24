# SAM weekly production health review — 2026-08-24

Review window: `2026-08-17T09:06:53Z` through `2026-08-24T09:06:53Z` (exact rolling 168 hours). The latest available library baseline is `/health-reports/health-report-2026-08-10.md`; no `2026-08-17` report was present in `/health-reports/`.

Freshness checks: `platform_errors` has rows through `2026-08-24 09:09:20Z`; AI Gateway has rows through `2026-08-24T09:01:40.751Z`; Workers data covers the full requested interval. Task statuses were snapshotted at `2026-08-24T09:25:17Z`. HTTP status counts come from Cloudflare adaptive telemetry and are estimates; Worker invocation totals, D1 counts, and AI Gateway row counts are exact query results.

## Executive diff

### New since last run

- ProjectData storage exhaustion emitted `102` exact `Exceeded the maximum database size.` errors across `5` sessions on `2026-08-18`; `83` were ACP activity writes. Fresh supplemental telemetry at `2026-08-24T09:12:43.105Z` measured the project at `8,267,173,888 / 10,000,000,000` bytes (`82.67%`). The current lower measurement does not establish the incident-time high-water mark. Existing plan: [`01M0B8HBA4YRJFF8STQ8PMJ1D8`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0B8HBA4YRJFF8STQ8PMJ1D8).
- Snapshot capture failed with `resolve snapshot devcontainer: workspace is not running/recovery (status: stopped)` `199` times across `199` workspaces, `126` tasks, and `55` nodes; the last row was `2026-08-24 09:05:50Z`. The exact user wake impact is unverified, but code converts the failed HOME/WIP capture to a transcript-only degraded snapshot. New idea: [`01M0SHQC8V34S2P0JMZR53TEJN`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQC8V34S2P0JMZR53TEJN).
- Adaptive HTTP telemetry estimated `856` HTTP `503`s, including `824 / 856` (`96.3%`) on four `/api/workspaces/:id/messages` paths. The VM agent retries, so `856` is not a unique-message or proven-loss count; the exact upstream exception is unverified. New idea: [`01M0SHQCNRBDVKHC9JMTQZPEQ2`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQCNRBDVKHC9JMTQZPEQ2).
- GitHub returned `No server is currently available to service your request` in `22` exact API errors (`13` installations-page `500`s, `6` task-submit `502`s, `1` session-start `502`, and `2` git-token `502`s); one recent task terminalized after a git-token `502`. The last occurrence was `2026-08-20 09:22:03Z`. New idea: [`01M0SHQD30WXD6AF924R67KCJK`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQD30WXD6AF924R67KCJK).
- `23` conversation rows were failed by the `1440`-minute absolute runaway-cost ceiling. The sweep applies the task-age ceiling before probing runtime liveness, so current code cannot prove that those rows represented `23` live, billable runtimes. New idea: [`01M0SHQDH3FQQG7NMFKMFPSXWM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQDH3FQQG7NMFKMFPSXWM).

### Still open

- The deleted node `01KYXGTSF4B0WK4Y1DGJGY6VAV` produced `10,078` expired-JWT errors and an estimated `10,069` heartbeat HTTP `500`s. The exact error count is `3.42x` the prior `2,950`; first/last rows are `2026-08-17 09:07:20Z` and `2026-08-24 09:06:20Z`. Provider-orphan recovery remains tracked in [`01KZNGJEPBFEVFVVN5K9ZXCYGR`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJEPBFEVFVVN5K9ZXCYGR), and callback auth/status behavior in [`01KZNGJF5ZQK48Z481WX5NSG8B`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJF5ZQK48Z481WX5NSG8B).
- TaskRunner mismatch telemetry grew from `665` to `2,069` warnings and from `74` to `195` task IDs. `2,060 / 2,069` (`99.6%`) had a live or resumable liveness verdict, so these are not `2,069` proven D1 failures. Tracked in [`01KT90PKF6167SXZ9YZY0R26MM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90PKF6167SXZ9YZY0R26MM).
- Recovery/task lifecycle distortion remains current: `70` recent rows were failed as runtime conclusively gone, including `48` session-recovery rows; `55 / 70` occurred after the `2026-08-19 13:50:01Z` deployment of PR `#1862`. The exact superseded-predecessor case is tracked in [`01M0SG7ZEE1XARK4QDG7V6HDPN`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SG7ZEE1XARK4QDG7V6HDPN).
- Recent terminal metadata drift improved but persists: `11` failed rows lack `completed_at`, `4` failed rows have blank errors, and `0` completed rows retain errors, versus `75`, `2`, and `2` in the prior report. Tracked in [`01KZNGJG1DCH8DBC835Y0272P4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4).
- `chat.session_detail_load_failed` recurred `4` times: `3` wrapped the storage-ceiling error on August 18, and `1` occurred inside a cluster of code-update DO resets on August 19. The original reset symptom therefore recurred once, not four times. Tracked in [`01KT90KPP533AKPZVG047F5MVP`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90KPP533AKPZVG047F5MVP).

### Resolved or currently quiet

- Hetzner unsupported-location failures fell from `3` tasks / `3` platform errors to `0 / 0`: current tracker [`01KY008HK0GK23YHKZHHSJ71WK`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KY008HK0GK23YHKZHHSJ71WK); completed June baseline [`01KT90MP0FPY15WTB8T67PFTGG`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90MP0FPY15WTB8T67PFTGG). Missing-branch failures fell `20 -> 2` ([`01KZ3KFWET8Q9X1K82KCTWD8NK`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZ3KFWET8Q9X1K82KCTWD8NK)); Container capacity `15 -> 1` ([`01KYHDXR6689KFYR8S1WNXBNYP`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KYHDXR6689KFYR8S1WNXBNYP)); Hetzner server-limit tasks `14 -> 1` ([`01KTK8FR00448N1GRJR9W4MC9H`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KTK8FR00448N1GRJR9W4MC9H)); and agent-unresponsive tasks `9 -> 2`, while ACP crash-recovery warnings fell `176 -> 0` ([`01KZDDYEBSCNVTE1J1YPKADAH8`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZDDYEBSCNVTE1J1YPKADAH8)).
- Active-session mismatch callbacks, the prior stuck-sweep pattern error, and OAuth refresh-token reuse each matched `0` current rows. The message-rebind guard remains tracked in [`01KZNGJFKACG5C2ZR2E9ZJK2DP`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJFKACG5C2ZR2E9ZJK2DP).
- AI Gateway had `7` HTTP `429`s in two task-title bursts on August 19–20, then `105 / 105` subsequent calls succeeded. The path has bounded retry and deterministic fallback; there were `0` auth errors.
- Worker `clientDisconnected:success` remained low at `1,789 / 764,460 = 0.00234:1`, down `5.6%` from `0.00248:1` and far below the original approximately `15:1` incident. Tracked in [`01KT90P8M8YZ0CKZPH5WRH16MS`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90P8M8YZ0CKZPH5WRH16MS).

## 1. Workers analytics — `sam-api-prod`

Exact Worker invocation totals were `767,415` requests, `2` Worker errors, and `944,368` subrequests.

| Outcome | Requests | Errors | Subrequests | CPU P50 / P99 | Wall P50 / P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `success` | `764,460` | `0` | `939,946` | `2,096 / 97,072` | `49,005 / 5,104,145` |
| `clientDisconnected` | `1,789` | `0` | `2,406` | `74,924 / 196,869` | `20,575,276 / 15,205,675,000` |
| `responseStreamDisconnected` | `1,164` | `0` | `1,984` | `114,273 / 245,255` | `12,897,991 / 21,761,745,000` |
| `scriptThrewException` | `1` | `1` | `2` | `75,261 / 75,261` | `20,319,982,000 / 20,319,982,000` |
| `internalError` | `1` | `1` | `30` | `194,414 / 194,414` | `899,985,000 / 899,985,000` |

Quantiles are in Cloudflare's reported units. Success-only daily quantiles and outcomes were:

| UTC date | Success | Client disconnected | Stream disconnected | Script / internal error | Success CPU P50 / P99 | Success wall P50 / P99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `2026-08-17` partial | `52,255` | `148` | `90` | `0 / 0` | `1,639 / 151,694` | `40,107 / 5,605,535` |
| `2026-08-18` | `90,022` | `173` | `488` | `0 / 0` | `2,005 / 133,932` | `88,088 / 6,226,703` |
| `2026-08-19` | `117,638` | `248` | `100` | `0 / 0` | `1,845 / 92,919` | `70,225 / 4,983,563` |
| `2026-08-20` | `98,836` | `279` | `114` | `1 / 0` | `1,700 / 76,336` | `36,330 / 2,608,076` |
| `2026-08-21` | `164,007` | `263` | `153` | `0 / 1` | `2,091 / 66,607` | `40,162 / 2,462,653` |
| `2026-08-22` | `127,838` | `252` | `132` | `0 / 0` | `2,091 / 70,628` | `38,722 / 2,774,638` |
| `2026-08-23` | `84,862` | `323` | `67` | `0 / 0` | `2,703 / 88,961` | `185,253 / 2,882,515` |
| `2026-08-24` partial | `28,999` | `101` | `19` | `0 / 0` | `2,351 / 78,712` | `102,452 / 3,055,633` |

Versus the prior report, request volume fell `21.5%` from `977,951`, Worker errors fell `99.7%` from `726`, and the Worker error rate fell from `0.074%` to `0.000261%`.

Fresh adaptive HTTP telemetry estimated these status totals across `425,914` sampled/extrapolated responses: `200: 267,803`, `204: 141,400`, `500: 10,288`, `101: 2,556`, `503: 856`, `404: 684`, `499: 620`, `202: 579`, `409: 363`, `400: 336`, `201: 257`, `405: 125`, `401: 25`, `502: 14`, and `302: 8`. Of the estimated `10,288` HTTP `500`s, `10,069` (`97.9%`) were the deleted node's heartbeat path. These adaptive values are estimates, not exact request counts.

## 2. Observability — `platform_errors`

The window contains `16,740` rows: `10,549` error, `2,457` warn, and `3,734` info. By level/source: API error `10,334`, vm-agent error `215`, API warn `2,433`, vm-agent warn `24`, vm-agent info `3,470`, and API info `264`. Total rows rose `30.4%` from `12,837`; error rows rose `198.3%`, warn rows rose `37.9%`, and info rows fell `50.3%`.

| Rank | Message | Level / source | Count and breadth | First / last UTC | Trend vs prior |
| ---: | --- | --- | --- | --- | --- |
| 1 | `"exp" claim timestamp check failed` | error / API | `10,078`; `1` node | `2026-08-17 09:07:20` / `2026-08-24 09:06:20` | `2,950 -> 10,078` (`3.42x`), current |
| 2 | `TaskRunner DO completed but task still in 'in_progress'` | warn / API | `2,069`; `195` task IDs | `2026-08-17 09:10:22` / `2026-08-24 09:06:17` | `665 -> 2,069` (`3.11x`), current |
| 3 | `resolve snapshot devcontainer: workspace is not running/recovery (status: stopped)` | error / vm-agent | `199`; `199` workspaces, `126` tasks | window through `2026-08-24 09:05:50` | New, current |
| 4 | `Exceeded the maximum database size.` | error / API | `102`; `5` sessions | `2026-08-18 12:10:07` / `15:02:51` | New, bounded to August 18 |
| 5 | `Durable Object reset because its code was updated.` | error / API | `75`; `6` sessions | `2026-08-17 10:37:22` / `2026-08-24 08:53:44` | `17 -> 75`, current |

The expired-JWT signature accounts for `10,078 / 10,549 = 95.5%` of all error rows. Snapshot-stop errors account for `199 / 215 = 92.6%` of vm-agent error rows. TaskRunner mismatch accounts for `2,069 / 2,457 = 84.2%` of warning rows. The top three patterns therefore explain the large aggregate rise.

Code-grounded interpretation:

- Heartbeat JWT verification occurs before D1 node-state handling (`apps/api/src/routes/node-lifecycle.ts:302-320`), raw expiry is rethrown (`apps/api/src/services/jwt.ts:213-224`), and the global handler maps it to `500` (`apps/api/src/middleware/app-error-handler.ts:84-110`). The orphan row has `provider_instance_id = NULL`, and orphan reconciliation explicitly skips a terminal null claim (`apps/api/src/scheduled/provider-orphan-reconciliation-core.ts:304-323`).
- TaskRunner intentionally leaves a conversation task `in_progress` at agent handoff (`apps/api/src/durable-objects/task-runner/state-machine.ts:177-179`) and marks the DO completed/running (`:321-323`); the sweep warns on that combination every `30` minutes (`apps/api/src/scheduled/stuck-tasks.ts:1089-1119`). The phrase `possible D1 update failure` is therefore not supported for `2,060 / 2,069` live/resumable observations.
- The idle activity route and snapshot prepare do not require an active workspace status (`apps/api/src/routes/projects/agent-activity-callback.ts:252-285`; `apps/api/src/routes/workspaces/session-snapshots.ts:155-207`). The exact stopped error occurs later when the VM agent resolves the runtime (`packages/vm-agent/internal/server/git.go:355-364`). **Hypothesis:** late idle activity after stop is the dominant path; production rows do not distinguish it from a concurrent stop.
- The literal Cloudflare database-size message is not recognized by the storage classifier (`apps/api/src/services/durable-object-retry.ts:14-19,40-44`), so the intended typed `507` mapping (`apps/api/src/services/project-data-storage-errors.ts:3-16`) is bypassed and chat detail can surface a generic `500` (`apps/api/src/routes/chat-load-diagnostics.ts:80-95`).

## 3. Task reliability — `sam-prod.tasks`

Status snapshot for rows created in the review window:

| Status | Count |
| --- | ---: |
| `failed` | `144` |
| `completed` | `74` |
| `draft` | `43` |
| `in_progress` | `13` |
| `cancelled` | `12` |

The raw recent failed-row share is `144 / (74 + 144 + 13) = 62.3%`, up `25.3` percentage points from `37.0%`. This is not a clean user-work reliability rate: conversation tasks intentionally remain `in_progress` between turns, and `118 / 144` (`81.9%`) failed rows are control-loop terminalizations. By mode, task-mode rows were `15 failed / 66 completed / 3 in_progress = 17.9%` failed, while conversation-mode rows were `129 / (129 + 8 + 10) = 87.8%` failed-row share. The all-time failed/cancelled share is `(1,490 + 20) / (3,717 + 1,490 + 20 + 13) = 28.8%`, versus `26.9%` previously.

| Recent failed/cancelled bucket | Count | Interpretation |
| --- | ---: | --- |
| Runtime conclusively gone after grace | `70` | Reconciliation terminalization; `48` were session-recovery rows |
| Absolute runaway-cost ceiling (`1440m`) | `23` | Policy terminalization before liveness probe; all conversation mode |
| Runtime not live after `480m` | `17` | Reconciliation terminalization |
| Runtime not live after `240m` | `8` | Reconciliation terminalization |
| Cancelled: `stopped_by_parent` | `7` | Explicit cancellation |
| Cancelled: archived | `4` | Explicit cancellation |
| Other failed | `4` | Mixed |
| Failed with blank error | `4` | Metadata drift |
| Maximum database size | `3` | ProjectData storage exhaustion |
| Provider session/rate limit | `3` | Provider/model transient |
| Recovery authority revoked | `3` | Recovery lifecycle |
| Session already exists | `3` | Session-start conflict |
| Agent unresponsive | `2` | Agent health |
| Missing branch | `2` | Clone/preflight |
| Container `max_instances` | `1` | Capacity |
| Hetzner server limit | `1` | Provider quota |
| Cancelled with blank error | `1` | Metadata drift |
| Hetzner unsupported location | `0` | Quiet |

Recovery creates a new conversation task and clears ownership links on old rows without terminalizing them (`apps/api/src/services/session-recovery.ts:201-281`); old active generations can later be marked failed when their workspace disappears. The current exact idea covers predecessor/successor terminal state.

The runaway ceiling derives age from `tasks.started_at` and fails before a liveness probe (`apps/api/src/scheduled/stuck-tasks.ts:1005-1017`); its candidate projection omits `task_mode` (`:247-248`). **Hypothesis:** some of the `23` rows were sleeping/restorable conversations rather than live runaway compute; the production query does not prove how many.

Metadata drift remains distributed across direct writers. The canonical helper sets `completed_at` and clears `execution_step` (`apps/api/src/routes/tasks/_helpers.ts:177-217`), while current bypasses include `apps/api/src/services/task-failure.ts:23-32`, `apps/api/src/routes/tasks/submit.ts:499`, and `apps/api/src/durable-objects/project-data/reconciliation-dead-target.ts:89`.

## 4. AI Gateway — `sam`

AI Gateway returned `151` fresh rows: `144` successes and `7` HTTP `429` errors (`95.36%` success). There were `0` HTTP `401/403` auth errors and `7` overload/rate-limit errors. All `7` failures were GLM task-title calls in bursts on August 19 (`4`) and August 20 (`3`); the following `105 / 105` calls succeeded.

| Model | Total | Success / error | Duration P50 / P99 / max ms | Latency P50 / P99 ms |
| --- | ---: | ---: | ---: | ---: |
| `@cf/zai-org/glm-5.2` | `150` | `143 / 7` | `1,522 / 35,542 / 36,893` | `1,465.08 / 35,510.83` |
| `@cf/google/gemma-4-26b-a4b-it` | `1` | `1 / 0` | `5,996 / 5,996 / 5,996` | `5,930.02 / 5,930.02` |

Volume fell `52.2%` from `316`; success rate fell from `99.68%` to `95.36%`. The task-title path retries `429/5xx` with configured backoff, then returns a deterministic fallback (`apps/api/src/services/task-title.ts:188-225,289-387`); task submission persists a fallback title before asynchronous refinement (`apps/api/src/routes/tasks/submit.ts:408-446,521-529`). The raw `7` Gateway errors therefore do not prove `7` failed submissions or even `7` user-visible fallback titles.

## 5. Trends vs the 2026-08-10 report

- Worker requests: `977,951 -> 767,415` (`-21.5%`); errors: `726 -> 2` (`-99.7%`); error rate: `0.074% -> 0.000261%`.
- Disconnect ratio: `0.00248:1 -> 0.00234:1` (`-5.6%`).
- Platform rows: `12,837 -> 16,740` (`+30.4%`), driven by expired JWT `2,950 -> 10,078` and TaskRunner warnings `665 -> 2,069`.
- Raw recent failed-row share: `37.0% -> 62.3%`; task-mode failed-row share is `17.9%`, and `118 / 144` recent failures are reconciliation/policy terminalizations.
- Missing branch `20 -> 2`; Container capacity `15 -> 1`; Hetzner server limit `14 -> 1`; agent unresponsive `9 -> 2`; unsupported location `3 -> 0`; ACP crash-recovery warning `176 -> 0`.
- Terminal rows missing `completed_at`: `75 -> 11`; failed rows with blank error: `2 -> 4`; completed rows retaining errors: `2 -> 0`.
- AI Gateway: `315 / 316 -> 144 / 151` success; overload/rate-limit errors `0 -> 7`, followed by `105 / 105` success.

## Prioritized findings

| Severity | Finding | Evidence | Suspected root cause / code citation | Idea |
| --- | --- | --- | --- | --- |
| High | ProjectData reached a write ceiling and errors bypass typed storage handling | `102` exact errors / `5` sessions; `83` ACP activity writes; current measured size `8.267 GB / 10 GB` | Exact phrase absent from classifier (`apps/api/src/services/durable-object-retry.ts:14-19,40-44`); read wrappers can rethrow raw errors (`apps/api/src/services/project-data.ts:95-163`). Incident high-water explanation is unverified. | [`01M0B8HBA4YRJFF8STQ8PMJ1D8`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0B8HBA4YRJFF8STQ8PMJ1D8) |
| High | Deleted provider orphan floods heartbeat auth/error telemetry | `10,078` exact expiry errors; estimated `10,069` heartbeat `500`s; one node | `30s` provider fetch default and no create idempotency/adoption (`packages/providers/src/provider-fetch.ts:43-64,209-225`; `packages/providers/src/hetzner.ts:239-288`); null provider ID is skipped by orphan reconciliation (`apps/api/src/scheduled/provider-orphan-reconciliation-core.ts:304-323`). | [`01KZNGJEPBFEVFVVN5K9ZXCYGR`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJEPBFEVFVVN5K9ZXCYGR), [`01KZNGJF5ZQK48Z481WX5NSG8B`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJF5ZQK48Z481WX5NSG8B) |
| High | Stopped-runtime snapshots fail HOME/WIP capture | `199` errors / `199` workspaces / `126` tasks; current through `09:05:50Z` | Missing active-state guards accept idle/prepare (`apps/api/src/routes/projects/agent-activity-callback.ts:252-285`; `apps/api/src/routes/workspaces/session-snapshots.ts:155-207`); late-idle dominance is a hypothesis. | [`01M0SHQC8V34S2P0JMZR53TEJN`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQC8V34S2P0JMZR53TEJN) |
| High | Recovery generations inflate failures and lose explicit supersession state | `70` runtime-gone failures; `48` recovery-triggered; `55` occurred after PR `#1862` deployed | Recovery reassigns links without terminalizing predecessors (`apps/api/src/services/session-recovery.ts:201-281`). | [`01M0SG7ZEE1XARK4QDG7V6HDPN`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SG7ZEE1XARK4QDG7V6HDPN) |
| Medium | Message persistence has concentrated `503` retry waves with no durable error class | Estimated `856` HTTP `503`s; `824` on four message paths; data loss unverified | Route catch-all maps unclassified ProjectData failures to `503` (`apps/api/src/routes/workspaces/runtime.ts:438-463`); ProjectData call has no server retry (`apps/api/src/services/project-data.ts:122-135,286-323`). | [`01M0SHQCNRBDVKHC9JMTQZPEQ2`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQCNRBDVKHC9JMTQZPEQ2) |
| Medium | Long-lived conversation age is treated as live runaway compute | `23` conversation failures at `1440m` | Ceiling runs before liveness and candidates omit mode (`apps/api/src/scheduled/stuck-tasks.ts:247-248,1005-1017`). Sleeping-runtime impact is a hypothesis. | [`01M0SHQDH3FQQG7NMFKMFPSXWM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQDH3FQQG7NMFKMFPSXWM) |
| Medium | GitHub transient outage terminalized one task and blocked API operations | `22` exact errors; one task failed after git-token `502`; last occurrence August 20 | Direct GitHub calls have no retry (`apps/api/src/services/github-app.ts:315-364,524-631`); VM git-token fetch is one-shot (`packages/vm-agent/internal/server/git_credential.go:215-266`). | [`01M0SHQD30WXD6AF924R67KCJK`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQD30WXD6AF924R67KCJK) |
| Medium | Terminal metadata invariants remain unenforced | `11` failed without completion; `4` failed blank errors; all-time drift includes `224` failed without completion and `15` blank errors | Multiple direct writers bypass the canonical transition helper (`apps/api/src/routes/tasks/_helpers.ts:177-217`; `apps/api/src/services/task-failure.ts:23-32`). | [`01KZNGJG1DCH8DBC835Y0272P4`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4) |
| Low | TaskRunner mismatch telemetry alleges D1 failure for normal handoff | `2,069` warnings; `195` tasks; `99.6%` live/resumable | DO completed/running plus D1 in-progress is intentional handoff (`apps/api/src/durable-objects/task-runner/state-machine.ts:177-179,321-323`); sweep interpretation is wrong (`apps/api/src/scheduled/stuck-tasks.ts:1089-1119`). | [`01KT90PKF6167SXZ9YZY0R26MM`](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90PKF6167SXZ9YZY0R26MM) |

## Watched but healthy

- Worker execution was healthy at the platform layer: `2 / 767,415 = 0.000261%` exact Worker errors, down from `726 / 977,951 = 0.074%`.
- Disconnect ratio stayed at `0.00234:1`; the original approximately `15:1` incident did not recur.
- AI Gateway had `0` auth failures, and all `105` calls after the final `429` succeeded. The title path has tested retry/fallback behavior.
- GitHub's upstream burst had `0` matching rows after `2026-08-20 09:22:03Z`; the code-level resilience gap remains separately actionable.
- Active-session mismatch, OAuth refresh-token reuse, stuck-sweep pattern errors, ACP crash recovery, and unsupported-location errors each matched `0` current rows.
- Prior task-failure buckets materially improved: missing branch `2`, Container capacity `1`, Hetzner server limit `1`, and agent unresponsive `2`.
- The stopped-snapshot path is terminal after one sweep attempt, and its `199` errors covered `199` workspaces, so there was no observed per-workspace retry accumulation. Total chat loss is unverified because the API persists transcript-only degraded snapshots.
- The `856` estimated message-path `503`s are retry attempts, not `856` proven lost messages; the VM keeps the outbox after an exhausted retry wave. Eventual persistence is unverified.
