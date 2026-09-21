# SAM weekly production health review — 2026-09-21

**Review window:** 2026-09-14T09:07:15Z–2026-09-21T09:07:15Z. **Baseline:** `/health-reports/health-report-2026-09-14.md`. All production queries were read-only. The newest `platform_errors` row was 2026-09-21T09:06:29Z, 46 seconds before cutoff. The newest AI Gateway row was 2026-09-21T09:01:36.285Z, 5 minutes 39 seconds before cutoff. ProjectData storage is explicitly timestamp-qualified below because its newest telemetry row was 16 hours 44 minutes 46 seconds old at cutoff.

## Executive diff

### New since last run

- **Expected snapshot/sleep races are promoted to platform incidents.** Seven vm-agent errors across seven workspaces returned the exact terminal HTTP 410 `Workspace is sleeping; callback resource is gone`. The API deliberately returns 410 for sleeping workspaces, while the vm-agent's existing teardown-race suppression does not recognize this control-plane error shape. Tracked in [01M31M9FVCDWTGN3QCNAXWZ0K6](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M31M9FVCDWTGN3QCNAXWZ0K6).
- **Two user-cancel grace expiries reached the fatal task path.** Tasks `01M2RYEH…` and `01M2YQK1…` both transitioned `in_progress -> failed` with actor `workspace_callback`, reason `Agent prompt failed`, and exact error `Prompt cancel grace elapsed after 5s`. The code intends cancellation to return to `awaiting_followup`; the exact race remains a hypothesis. Tracked in [01M31M9G3T4SEWT9ZW1BM4QKZ3](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M31M9G3T4SEWT9ZW1BM4QKZ3).

### Still open

- **ProjectData reached 9,983,135,744/10,000,000,000 bytes (99.83135744%) at its last sample.** Only 16,864,256 bytes remained; the sample was 16h44m46s stale at cutoff, so current usage is unverified. The archive breaker was closed and 58 sessions published in-window, but measured size rose 230,260,736 bytes from the first to final sample. Updated: [01M0YZNBKSKQZ47NC0K7M8N5AX](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0YZNBKSKQZ47NC0K7M8N5AX).
- **ProjectData pressure resurfaced in user-facing paths.** Exact overload rows rose from 1 to 12; exact CPU resets fell from 8 to 4, but three activity callbacks and one chat/WebSocket read still bypassed the intended recovery path. `chat.session_detail_load_failed` recurred three times. Updated: [01M1BKG7BE6HD81QC1Y0HBQVSJ](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1BKG7BE6HD81QC1Y0HBQVSJ) and [01M1XKK208SJV9VJA4BXP2KBHT](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKK208SJV9VJA4BXP2KBHT).
- **Hetzner candidate placement errors grew.** Raw 412 rows rose from 31 to 122 and server-limit 403 rows rose from 4 to 7. No recent task error directly ended in 412 or 403; the rows omit task IDs, so recovered-task counts cannot be proved. Updated: [01KQXHKV6A34HJQR4YCACZR734](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KQXHKV6A34HJQR4YCACZR734).
- **Deletion-quarantine diagnostics remain incomplete.** Two rows, down from five, again had null context and stack; both workspaces later reached `deleted` with runtime-deletion proof. Updated: [01M2FKS8MMKTX5F4YD7RYSSYFE](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2FKS8MMKTX5F4YD7RYSSYFE).

### Resolved

- **Sleeping conversations are no longer swept into failure.** Ceiling/liveness failures fell from 57 to 2. All 37 in-progress conversations had deleted workspaces plus unexpired sleeping snapshots: 34 `available/none` and 3 `degraded/transcript-only`. Completed tracker: [01M2CKHT52MKAZ8DTH91N6J185](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2CKHT52MKAZ8DTH91N6J185).
- **Installation-token failures did not recur.** The prior 21-row HTTP 500 burst had zero rows in this window. Updated: [01M2FKRVFQJ7GQ1ZFHMD3M5Y2C](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2FKRVFQJ7GQ1ZFHMD3M5Y2C).
- **The exact provisioning-timeout regression did not recur.** There were zero exact node-provisioning timeout failures. One task hit generic stuck recovery after 1,417 seconds in `node_selection`, but retained evidence does not tie it to pool revision or provider errors. Updated: [01M236QPGGC6B150FG4QHT17MW](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M236QPGGC6B150FG4QHT17MW).
- **The original client-disconnect anomaly remains resolved.** Current ratio was 0.001872:1 (1,146 / 612,291), 83.0% above last week's 0.001023:1 but 99.988% below the original approximately 15:1 condition. Updated: [01KT90P8M8YZ0CKZPH5WRH16MS](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90P8M8YZ0CKZPH5WRH16MS).
- **Prior legacy signatures remained absent.** The window contained zero unsupported Hetzner-location 422 rows, zero strict max-lifetime deletion errors, and zero `TaskRunner DO completed but task still in_progress` warnings.

## 1. Workers analytics — `sam-api-prod`

| Invocation status | Requests | Errors | Subrequests | CPU P50/P99 | Wall P50/P99 |
|---|---:|---:|---:|---:|---:|
| success | 612,291 | 0 | 714,546 | 2.989 ms / 52.214 ms | 101.701 ms / 2.552 s |
| clientDisconnected | 1,146 | 0 | 1,335 | 7.138 ms / 127.566 ms | 9.996 s / 1,521.350 s |
| responseStreamDisconnected | 546 | 0 | 878 | 52.455 ms / 121.337 ms | 60.554 s / 21,274.153 s |
| scriptThrewException | 1 | 1 | 2 | 45.047 ms / 45.047 ms | 789.341 s / 789.341 s |
| **Total** | **613,984** | **1** | **716,761** | — | — |

The runtime-error rate was **1/613,984 = 0.0001629%**. Request volume fell **39.0%** from 1,005,896; runtime errors remained at one. `clientDisconnected` rose from 1,027 to 1,146 (**+11.6%**) while its ratio to success rose **83.0%** because success volume fell. `responseStreamDisconnected` fell from 1,239 to 546 (**-55.9%**). The only runtime exception was on 2026-09-20. On the six complete UTC dates Sep 15–20, successful invocations ranged from **54,332 to 105,639**; Sep 14 and Sep 21 were partial.

Workers Observability telemetry returned approximately sampled event counts by HTTP status: **status 0 1,902,808; 2xx 901,710; 3xx 20,358; 4xx 10,439; 5xx 198**. The 5xx split was **178 status 500 and 20 status 503**. Sample intervals ranged from **1.000 to 1.027**. These **2,835,513 telemetry events** include non-request events and status 0, so they are not used as the Worker request or error-rate denominator.

## 2. Observability — `platform_errors`

The window contained **3,535 rows**: **295 error, 125 warn, and 3,115 info**. By source, API contributed **285 error / 107 warn / 459 info** and VM agent contributed **10 error / 18 warn / 2,656 info**. The newest row was 46 seconds old, so this source was current. Versus the prior report, total rows fell **17.5%**, warnings fell **42.9%**, and info rows fell **18.8%**, while errors rose **28.3%**.

| Rank | Exact error message | Count | Trend and evidence-grounded interpretation |
|---:|---|---:|---|
| 1 | `Node provisioning failed: hetzner API error (412): error during placement` | 122 | Up from 31 (**+293.5%**). Each candidate failure is logged before fallback; rows omit `task_id`, and zero recent task errors directly ended in 412. **Growing raw provider signal; recovered-task count unverified.** |
| 2 | `Durable Object is overloaded. Requests queued for too long.` | 12 | Up from 1 (**+1,100%**). Path split: 6 session WebSockets, 4 node ACP heartbeats, 2 session comments. **Growing and user-facing.** |
| 3 | `Node provisioning failed: hetzner API error (403): server limit reached` | 7 | Up from 4 (**+75.0%**), all between 2026-09-20T02:06:19Z and 03:24:41Z. Zero recent task errors directly ended in 403. **Recovered/queued outcome count unverified.** |
| 4 | `snapshot control plane returned HTTP 410: … Workspace is sleeping…` | 7 | New exact pattern across seven workspaces, through 2026-09-21T07:36:52Z. **Expected race, incorrectly incident-level.** |
| 5 | `Durable Object exceeded its CPU time limit and was reset.` | 4 | Down from 8 (**-50.0%**): three activity callbacks and one session/WebSocket read. **Classifier gap still open.** |

Three `chat.session_detail_load_failed` rows were downstream of two overloads and one CPU reset. Three separate `Failed to get session` rows came from Better Auth on `/api/projects…`; their stored stack was only `APIError: Failed to get session`, so their underlying cause is unverified and they are not attributed to ProjectData.

Code correlation:

- A failed Hetzner candidate writes its platform error at `apps/api/src/services/node-provisioning.ts:630-675`; transient-capacity fallback clears the failed candidate and continues at `apps/api/src/durable-objects/task-runner/node-provisioning-step.ts:650-738`. The 412 classifier is at `packages/providers/src/hetzner-metadata.ts:189-245,283-319`.
- Bounded Durable Object retry is implemented at `apps/api/src/services/durable-object-retry.ts:3-14` and `apps/api/src/services/project-data.ts:361-403`. The overload string is classified transient, but the exact CPU-limit string is not. ACP session lookup directly calls the stub at `project-data.ts:1721-1728`; callback fallback depends on the classifier at `apps/api/src/services/acp-activity-callback-handler.ts:186-231,640-649`.
- The API rejects callbacks for sleeping workspaces at `apps/api/src/routes/workspaces/_helpers.ts:23-28,48-66`. The vm-agent suppression predicate at `packages/vm-agent/internal/server/session_snapshot_coordinator.go:118-153` misses the plain HTTP 410 constructed at `session_snapshot_control_plane.go:107-133`.
- Better Auth session lookup is uncaught at `apps/api/src/middleware/auth.ts:122-140`; the available three error rows do not retain the upstream cause.

## 3. Task reliability — `sam-prod.tasks`

### Seven-day window

| Mode | Completed | Failed | In progress | Cancelled | Draft | Ready | Raw failure share `(failed / completed+failed+in-progress)` |
|---|---:|---:|---:|---:|---:|---:|---:|
| task | 89 | 9 | 2 | 4 | 56 | 1 | 9.00% |
| conversation | 1 | 3 | 37 | 32 | 0 | 0 | 7.32% |
| **Total** | **90** | **12** | **39** | **36** | **56** | **1** | **8.51%** |

The comparable raw failure share fell from **48.62% to 8.51% (-40.11 percentage points)**. Among terminal completed+failed rows, failure share was **12/102 = 11.76%**. Conversation-mode raw failure share fell from 96.15% to 7.32% because 37 sleeping conversations now remain resumable and `in_progress` rather than being terminalized.

| Failed-task cause | Count | Share of 12 | Interpretation |
|---|---:|---:|---|
| Human input request expired | 4 | 33.33% | Intended bounded timeout after delivery/grace checks. |
| Prompt cancel grace elapsed after 5s | 2 | 16.67% | Actionable: both reached fatal callback path despite cancellation semantics. |
| Runtime/workspace liveness verdict | 3 | 25.00% | Down from 57 ceiling/liveness failures in the prior window. |
| Queued at node selection for 1,417s | 1 | 8.33% | Generic stuck-task safety net; provider cause unverified. |
| Git partial-clone checkout failure | 1 | 8.33% | One HTTP/2 `PROTOCOL_ERROR`; no recurrence in-window. |
| Workspace `chat_session_id` unique constraint | 1 | 8.33% | One D1 constraint failure; no recurrence in-window. |

The four human-input expiries implement the 2-hour initial timeout, 2-hour undelivered grace, and 24-hour hard maximum at `packages/shared/src/constants/notifications.ts:80-90` and deliberately terminalize at `apps/api/src/durable-objects/project-data/attention-expiry.ts:124-168,214-252`.

The two cancel-grace rows are code-grounded as a likely invariant violation. The exact reason originates in the user-cancel timer at `packages/vm-agent/internal/acp/session_host.go:33-36,781-813`. Cancellation should map to `awaiting_followup` at `packages/vm-agent/internal/server/server.go:1515-1524`, but both production status histories used the fatal `Agent prompt failed` branch at lines 1536-1544. **Hypothesis:** the cancel flag or prompt identity is lost before callback classification; the exact mechanism is unverified.

### All-time snapshot and state checks

All-time status counts were **4,146 completed, 1,847 failed, 281 cancelled, 655 draft, 73 ready, and 39 in progress**. Failed tasks were **30.62%** of completed + failed + in-progress rows, down from 31.14%; treating cancelled as unsuccessful produced **33.88%**, essentially flat versus 33.89%.

The 39 in-progress rows were **37 sleeping conversations** plus **2 running task-mode tasks**. All 37 sleeping conversations had deleted workspaces and unexpired snapshots: 34 `available/none`, 3 `degraded/transcript-only`. This is intended lifecycle behavior: sleep schedules workspace deletion at `apps/api/src/services/session-sleep.ts:535-619,656-667`, and the liveness predicate preserves resumable deleted-workspace snapshots at `apps/api/src/services/task-runtime-liveness.ts:492-516` and `apps/api/src/scheduled/stuck-tasks.ts:1492-1518`.

Zero of 12 failed rows lacked `completed_at`. Although **87/90 completed rows retained `execution_step`**, the dominant MCP completion writer currently retains it at `apps/api/src/routes/mcp/task-tools.ts:412-422`; this is current audit behavior rather than proven drift. The one `completed` row without `completed_at` was an Idea lifecycle row with no `started_at`; Idea completion updates status without runner timestamps at `apps/api/src/routes/mcp/idea-tools.ts:283-301,346-405`.

## 4. AI Gateway — `sam`

The paginated scan downloaded 250 rows and retained **213 fresh rows** from 2026-09-14T10:51:41.540Z through 2026-09-21T09:01:36.285Z. It discarded **37 stale rows**, the oldest from 2026-09-13T06:04:02.998Z. All **213/213 were HTTP 200 successes**: zero 401, 403, 429, or 5xx responses. Volume fell from 304 to 213 (**-29.9%**); success rose from 99.67% to 100%.

| Model | Calls | HTTP outcomes | Duration P50/P99/max | Provider latency P50/P99 |
|---|---:|---|---:|---:|
| `@cf/zai-org/glm-5.2` | 125 | 125×200 | 3,953 / 41,720.76 / 47,340 ms | 3,530.43 / 41,495.32 ms |
| `@cf/google/gemma-4-26b-a4b-it` | 88 | 88×200 | 1,154.5 / 3,246.33 / 3,543 ms | 965.94 / 2,737.57 ms |

Call sources were **126 task-title** and **87 platform-feedback-triage**. The prior single 429 and all prior authentication/5xx errors had zero recurrences.

## 5. Trends versus 2026-09-14

| Signal | Prior | Current | Change |
|---|---:|---:|---:|
| Worker requests | 1,005,896 | 613,984 | -39.0% |
| Worker runtime errors | 1 | 1 | flat |
| clientDisconnected : success | 0.001023:1 | 0.001872:1 | +83.0% |
| responseStreamDisconnected | 1,239 | 546 | -55.9% |
| platform error rows | 230 | 295 | +28.3% |
| exact DO overload rows | 1 | 12 | +1,100% |
| exact DO CPU-reset rows | 8 | 4 | -50.0% |
| task raw failure share | 48.62% | 8.51% | -40.11 pp |
| task-mode raw failure share | 12.62% | 9.00% | -3.62 pp |
| conversation-mode raw failure share | 96.15% | 7.32% | -88.83 pp |
| AI Gateway success | 99.67% | 100% | +0.33 pp |
| ProjectData latest recorded usage | 97.737% | 99.831% | +2.094 pp |
| Published archive journals | 175 | 233 | +58 |

ProjectData produced 120 storage-history samples in-window. The first was **9,752,875,008 bytes** at 2026-09-14T09:14:08Z; the last and maximum were **9,983,135,744 bytes** at 2026-09-20T16:22:29Z, a net rise of **230,260,736 bytes**. The final stored trend was **32,955,627 bytes/day** and **0.5117 days to the 10 GB limit**, but that estimate was already 16h44m46s old at cutoff and is not a current forecast.

The breaker was explicitly closed at 2026-09-18T10:34:23Z and 58 sessions published during the window, last at 2026-09-21T07:08:06Z. Published state deletes `chat_messages`, grouped/FTS rows, and tool archive payload rows while retaining the root `chat_sessions` anchor (`apps/api/src/durable-objects/project-data/archive-sharding.ts:2200-2321`). The coordinator discards the finalizer's exact before/after byte result at `apps/api/src/scheduled/project-data-archive-sharding.ts:2456-2470`, so the 58-publication count does not quantify reclaimed bytes. No SAM-project `telemetry_upsert_failed` or storage-safety alarm-failure event appeared in sampled Workers telemetry. **Hypothesis:** alarm scheduling, configuration, or another unlogged path caused the stale final sample; current evidence does not select a cause.

## Prioritized findings

| Severity | Finding | Concrete evidence | Suspected root cause or verified code behavior | Idea |
|---|---|---|---|---|
| Critical | ProjectData has almost no measured headroom and the measurement is stale | 9,983,135,744/10B (99.831%); 16,864,256 bytes left; final row 16h44m46s stale; +230,260,736 bytes first-to-last | Hourly measurement/upsert is at `storage-safety.ts:606-680`; no matching SAM upsert/alarm failure was observed, so staleness cause is **unverified** | [01M0YZNBKSKQZ47NC0K7M8N5AX](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0YZNBKSKQZ47NC0K7M8N5AX) |
| High | ProjectData overload is again reaching live API paths | 12 exact overload rows vs 1; 6 WS, 4 heartbeats, 2 comments; 3 chat detail failures | WS reads exhaust bounded retry; heartbeat uses direct non-retried DO call (`project-data.ts:361-403,1881-1888,2443-2456`) | [01M1BKG7BE6HD81QC1Y0HBQVSJ](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1BKG7BE6HD81QC1Y0HBQVSJ) |
| High | CPU reset string still bypasses retry/fallback | 4 exact rows: 3 activity POSTs, 1 WS read; 1 linked chat-detail failure | Exact string absent from `durable-object-retry.ts:7-14`; activity lookup is direct at `project-data.ts:1721-1728` | [01M1XKK208SJV9VJA4BXP2KBHT](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKK208SJV9VJA4BXP2KBHT) |
| High | Cancel-grace completion incorrectly fails tasks | 2/12 failures; both status histories say `Agent prompt failed` | Cancellation should map to awaiting-followup; exact identity/flag race is a **hypothesis** (`session_host.go:781-813`; `server.go:1515-1544`) | [01M31M9G3T4SEWT9ZW1BM4QKZ3](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M31M9G3T4SEWT9ZW1BM4QKZ3) |
| Medium | Hetzner placement errors grew sharply | 122 raw 412 rows vs 31; 7 raw 403 rows vs 4; 0 direct terminal 412/403 task errors | Candidate errors are logged before fallback; missing task correlation prevents recovery measurement (`node-provisioning.ts:630-675`; `node-provisioning-step.ts:650-738`) | [01KQXHKV6A34HJQR4YCACZR734](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KQXHKV6A34HJQR4YCACZR734) |
| Medium | Expected snapshot sleep race creates platform incidents | 7 rows, 7 workspaces, last 2026-09-21T07:36:52Z | Existing teardown classifier misses flattened control-plane HTTP 410 (`session_snapshot_coordinator.go:118-153`; `session_snapshot_control_plane.go:107-133`) | [01M31M9FVCDWTGN3QCNAXWZ0K6](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M31M9FVCDWTGN3QCNAXWZ0K6) |
| Low | Deletion quarantine lacks diagnostic payload | 2 rows with null context/stack; both later deleted with proof | Existing persisted error still omits reason/attempt evidence | [01M2FKS8MMKTX5F4YD7RYSSYFE](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2FKS8MMKTX5F4YD7RYSSYFE) |

## Watched but healthy

- **AI Gateway:** 213/213 fresh calls succeeded; 0 authentication, overload, rate-limit, or 5xx responses. Thirty-seven stale rows were discarded.
- **Sleeping conversation lifecycle:** 37/37 in-progress conversations had unexpired wakeable snapshots; the prior mass terminalization signature fell from 57 to 2 liveness failures.
- **Human-input timeout:** four expiries followed the configured 2h + 2h grace / 24h hard-bound policy; no code or row evidence indicates premature expiry.
- **Installation-token minting:** 0 recurrences versus 21 prior rows.
- **Legacy task/provider regressions:** 0 exact provisioning-timeout failures, 0 unsupported-location 422 failures, 0 strict max-lifetime deletion errors, and 0 TaskRunner/D1 mismatch warnings.
- **Terminal metadata:** 0/12 failed rows lacked `completed_at`. The 87 completed rows retaining `execution_step` follow the current MCP completion writer; the one completed row without `completed_at` was an Idea lifecycle record, not an executed task.
- **Archive drain:** circuit breaker was `closed`; 58 sessions published in-window. Thirteen frozen and one poisoned migration remain terminal by design and therefore do not establish a current breaker outage.
