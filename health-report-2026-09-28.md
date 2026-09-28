# SAM weekly production health review — 2026-09-28

**Review window:** 2026-09-21T09:04:23Z–2026-09-28T09:04:23Z. **Baseline:** `/health-reports/health-report-2026-09-21.md`. All production queries were read-only. The newest `platform_errors` row was 2026-09-28T09:04:10.636Z, 12.364 seconds before cutoff. The newest AI Gateway row was 2026-09-28T09:03:51.904Z, 31.096 seconds before cutoff. The ProjectData point-in-time sample at 2026-09-28T09:09:08.764Z is explicitly marked because it is 4m45.764s after the fixed cutoff.

## Executive diff

### New since last run

- **ProjectData archive drain is stopped by an open circuit breaker.** Three 10-second R2 PUT deadlines poisoned one migration; the breaker opened 2026-09-27T16:47:58.886Z. The latest point-in-time sample was 9,928,892,416/10,000,000,000 bytes (99.2889%), leaving 71,107,584 bytes. Updated: [01M0YZNBKSKQZ47NC0K7M8N5AX](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0YZNBKSKQZ47NC0K7M8N5AX).
- **One management-auth-broken node terminalized six conversations.** Six tasks failed in 7m33s with the exact 401 `invalid management token`, all on node `01M34MAQ…` and all at `workspace_dispatch` with zero retries. The retained response masks the exact JWT validator failure. New: [01M3KMQENDAQCCZR06Z2HX53EB](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M3KMQENDAQCCZR06Z2HX53EB).
- **Snapshot manifests exceeded the control-plane body limit.** Ten HTTP 400 incidents affected 7 workspaces/5 nodes. All seven slept with `degraded/transcript-only`, so filesystem/harness preservation was lost while transcript recovery remained. New: [01M3KMQW7PWMR31PWWTJTPE51J](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M3KMQW7PWMR31PWWTJTPE51J).
- **A broad D1 service interval produced opaque wrapper errors.** There were 316 `Failed query:` rows, including 280 on Sep 25, plus 11 explicit D1 overload errors. Two hundred fifty wrapper rows overlapped the explicit overload interval, but the persisted wrapper discards the nested cause, so one-to-one attribution is unverified. New: [01M3KMR77154WXABJBDZ22S4BB](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M3KMR77154WXABJBDZ22S4BB).

### Still open

- **Expected snapshot lifecycle races remain incident-level noise.** Exact 410s grew from 7 sleeping rows to 146 total: 70 sleeping, 44 deleted, and 32 stopping. Updated: [01M31M9FVCDWTGN3QCNAXWZ0K6](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M31M9FVCDWTGN3QCNAXWZ0K6).
- **Task reliability regressed.** The comparable seven-day raw failure share rose from 8.51% to 22.67% (+14.16 percentage points): 39 failed, 95 completed, and 38 in progress at the initial cutoff snapshot. Eleven failures were LLM usage/session limits, 6 were human-input expiry, 6 were the management-token incident, and 5 were pre-fix Hetzner shared-core quota failures.
- **Hetzner placement scarcity remains visible but fallback worked.** Raw 412 rows fell 122→96; two tasks terminalized only after trying all permitted `cx53`, `cx43`, and `cx33` offerings. Updated: [01KQXHKV6A34HJQR4YCACZR734](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KQXHKV6A34HJQR4YCACZR734).
- **Client disconnects increased at a low absolute rate.** `clientDisconnected:success` rose from 0.001872:1 to 0.004510:1 (2.409×); Sep 23/25/26 contained 91.24% of disconnects. No route-level cause is verified. Updated: [01KT90P8M8YZ0CKZPH5WRH16MS](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90P8M8YZ0CKZPH5WRH16MS).
- **Deletion-quarantine diagnostics still omit their reason.** One row, down from two, again had null context and stack. Updated: [01M2FKS8MMKTX5F4YD7RYSSYFE](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2FKS8MMKTX5F4YD7RYSSYFE).

### Resolved

- **The 556-row ProjectData connection-loss episode stopped after the incident.** All rows were confined to 2026-09-24T16:01:43.953Z–16:34:36.958Z; current code includes merged bounded retry/coalescing, and no later exact row occurred. The underlying Cloudflare cause is unverified. Updated: [01M1BKG7BE6HD81QC1Y0HBQVSJ](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1BKG7BE6HD81QC1Y0HBQVSJ).
- **Five providerless nodes now have strict deletion proof.** The window retains 256 historical max-lifetime deletion errors across five nodes, but all five are now `deleted` with `runtime_termination_confirmed_at` after PR #2163 deployed. No new idea was filed.
- **ProjectData CPU resets and cancel-grace failures did not recur.** Exact CPU resets fell 4→0 and cancel-grace task failures fell 2→0. Updated: [01M1XKK208SJV9VJA4BXP2KBHT](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKK208SJV9VJA4BXP2KBHT) and [01M31M9G3T4SEWT9ZW1BM4QKZ3](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M31M9G3T4SEWT9ZW1BM4QKZ3).
- **Prior legacy signatures remained absent.** The window contained 0 unsupported-location 422 rows, 0 installation-token rows, and 0 `TaskRunner DO completed but task still in_progress` warnings. Updated TaskRunner tracker: [01KT90PKF6167SXZ9YZY0R26MM](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90PKF6167SXZ9YZY0R26MM).

## 1. Workers analytics — `sam-api-prod`

| Invocation status | Requests | Errors | Subrequests | CPU P50/P99 | Wall P50/P99 |
|---|---:|---:|---:|---:|---:|
| success | 635,441 | 0 | 792,769 | 3.303 / 60.322 ms | 106.827 ms / 2.638 s |
| clientDisconnected | 2,866 | 0 | 1,381 | 3.367 / 69.698 ms | 9.996 / 333.649 s |
| responseStreamDisconnected | 459 | 0 | 727 | 53.651 / 100.364 ms | 93.762 / 5,875.928 s |
| **Total** | **638,766** | **0** | **794,877** | — | — |

Request volume rose 4.0% from 613,984; the prior single runtime exception fell to 0. Successful requests rose 3.8%. `clientDisconnected` rose 1,146→2,866 (+150.1%), and its ratio to success rose 141.0% to 0.004510:1. `responseStreamDisconnected` fell 546→459 (-15.9%).

| UTC date | Success | Client disconnected | Ratio |
|---|---:|---:|---:|
| Sep 21 partial | 42,811 | 42 | 0.000981:1 |
| Sep 22 | 82,690 | 79 | 0.000955:1 |
| Sep 23 | 101,817 | 1,620 | 0.015911:1 |
| Sep 24 | 60,370 | 40 | 0.000663:1 |
| Sep 25 | 106,244 | 531 | 0.004998:1 |
| Sep 26 | 81,180 | 464 | 0.005716:1 |
| Sep 27 | 130,729 | 80 | 0.000612:1 |
| Sep 28 partial | 29,600 | 10 | 0.000338:1 |

Sep 23/25/26 contributed 2,615/2,866 disconnects (91.24%) but 289,241/635,441 successes (45.52%). The aggregate does not identify a route. Browser WebSockets intentionally close/reconnect at `apps/web/src/hooks/useProjectWebSocket.ts:115-128,222-234` and `useChatWebSocket.ts:340-367`; streaming surfaces exist at `apps/api/src/routes/sam.ts:46-57`, `project-agent.ts:55-65`, and `ai-proxy-upstream.ts:108-118,179-199,251-262,312-322`. These are possible surfaces, not verified causes. Workspace/page proxy responses return before standard request logging at `apps/api/src/index.ts:180-224,545-554,664-682`, limiting correlation.

Workers Observability returned sampled/estimated status counts over 2026-09-21T09:06:41.750Z–2026-09-28T09:04:23Z, 2m18.750s shorter than the fixed window because of retention: **status 0 1,651,200; 2xx 926,810; 3xx 9,450; 4xx 6,510; 5xx 910**. All 5xx estimates were status 500. Sample intervals were 10.000–10.027, and the 2,594,880 events include non-request/status-0 telemetry, so they are not the Worker invocation denominator. Estimated 5xx rose 198→910 (+359.6%), consistent with the separately observed ProjectData/D1 500 intervals but not a one-to-one correlation.

## 2. Observability — `platform_errors`

The window contained **4,877 rows**: **1,442 error, 197 warn, and 3,238 info**. By source, API contributed 1,280 error / 168 warn / 277 info; vm-agent contributed 162 error / 29 warn / 2,961 info. The newest row was 12.364 seconds old, so this source was current. Versus the prior report, total rows rose 38.0%, errors rose 388.8%, warnings rose 57.6%, and info rose 3.9%.

### Top five exact error-message values

| Rank | Exact value | Count | Trend / interpretation |
|---:|---|---:|---|
| 1 | `Network connection lost.` | 556 | New, confined to a 32m53s ProjectData RPC incident; no later exact row. |
| 2 | `Node provisioning failed: hetzner API error (412): error during placement` | 96 | Down from 122 (-21.3%); two terminal tasks exhausted all permitted offerings. |
| 3 | `Failed query: select "status" … node 01M3CHSC…` | 79 | New exact value; part of 316 `Failed query:` wrappers. |
| 4 | `Failed query: select "status" … node 01M3CW6K…` | 79 | New exact value; part of the same broad D1 interval. |
| 5 | `snapshot control plane returned HTTP 410 … Workspace is sleeping` | 70 | Up from 7 (+900%); expected lifecycle race still reported as error. |

Dynamic IDs fragment several categories. Category rollup: **316 `Failed query:` wrappers; 256 strict max-lifetime deletion errors across five nodes; 146 snapshot HTTP 410s; 11 explicit D1 overloads; 10 snapshot-body-too-large errors; 5 Hetzner shared-core 403s; 3 exact ProjectData overloads; 0 CPU resets; 7 `chat.session_detail_load_failed` rows**.

The 556 connection-loss stacks run through ProjectData `getStubForOwner`, whose initial RPC is at `apps/api/src/services/project-data.ts:219-229`; 486 rows were ACP activity endpoints, 33 node ACP heartbeat, 24 session WebSocket, and 13 other routes. Current retry classification is at `apps/api/src/services/durable-object-retry.ts:32-37,83-94` and bounded RPC retry at `project-data-rpc-retry.ts:57-137`.

The D1 pattern was broad: 3 wrapper rows on Sep 22, 2 on Sep 24, 280 on Sep 25, 30 on Sep 26, and 1 on Sep 28. Eleven explicit overload rows ran from 2026-09-25T18:43:28Z through 22:08:39Z; 250/316 wrappers overlapped that interval. `apps/api/src/middleware/app-error-handler.ts:50-89` persists the top-level wrapper, while `apps/api/src/lib/logger.ts:87-99` does not retain a bounded nested cause. **Hypothesis:** many overlapping wrappers were caused by the D1 overload; the retained evidence cannot prove each one.

Snapshot 410 behavior is deliberate at `apps/api/src/routes/workspaces/_helpers.ts:23-28,48-67`, but the vm-agent flattens non-2xx responses at `packages/vm-agent/internal/server/session_snapshot_control_plane.go:107-133` and misses the terminal 410 shape in `session_snapshot_coordinator.go:84-153`. The 400 body failures have a verified size mismatch: API cap 256 KiB (`apps/api/src/services/session-snapshot-artifacts.ts:13-18,175-193`), while the vm-agent embeds an uncapped skipped-entry list (`session_snapshot_control_plane.go:29-49`; `session_snapshot_container_support.go:180-230`; `session_snapshot_archive.go:389-431`).

Warnings were led by 54 superseded-session transitions, 27 stopped-node cleanup completions, 19 `ACP Prompt failed`, 19 480-minute `workspace_deleted/awaiting_followup` liveness verdicts, and 15 480-minute `workspace_deleted/running` verdicts.

## 3. Task reliability — `sam-prod.tasks`

### Seven-day window at the initial cutoff snapshot

| Mode | Completed | Failed | In progress | Queued | Cancelled | Draft | Ready | Delegated | Raw failure share `(failed / completed+failed+in-progress)` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| task | 95 | 24 | 3 | 1 | 3 | 67 | 1 | 1 | 19.67% |
| conversation | 0 | 15 | 35 | 0 | 50 | 0 | 0 | 0 | 30.00% |
| **Total** | **95** | **39** | **38** | **1** | **53** | **67** | **1** | **1** | **22.67%** |

The comparable raw failure share rose from 8.51% to 22.67% (+14.16 percentage points). Among terminal completed+failed rows, failure share was **39/134 = 29.10%**.

| Failed-task cause | Count | Share of 39 | Interpretation |
|---|---:|---:|---|
| LLM usage/session limits | 11 | 28.21% | 8 Codex usage-limit and 3 session-limit responses; external/user quota signal. |
| Human input request expired | 6 | 15.38% | Intended bounded expiry path. |
| Node-agent management JWT rejected | 6 | 15.38% | Actionable; one heartbeating node, zero retries. |
| Hetzner shared-core 403 | 5 | 12.82% | All before the Sep 25 quota-descent fix merged. |
| Runtime/workspace liveness verdict | 4 | 10.26% | Three workspace-deleted time bounds plus one terminal ACP-session reconciliation. |
| Agent unresponsive after check-in | 3 | 7.69% | Three task-mode failures. |
| Exhausted Hetzner 412 placement chain | 2 | 5.13% | All three permitted offerings were tried. |
| Node agent readiness timeout | 1 | 2.56% | Exact 900,000 ms readiness deadline. |
| Prompt hard timeout | 1 | 2.56% | Exact 8-hour timeout. |

The six 401s are code-grounded: JWT mint/send at `apps/api/src/services/jwt.ts:168-190` and `node-agent.ts:171-218`; validator at `packages/vm-agent/internal/auth/jwt.go:124-167,239-261`; generic 401 at `packages/vm-agent/internal/server/workspaces.go:138-153`; permanent-error classification at `apps/api/src/durable-objects/task-runner/helpers.ts:45-92`; no-retry rethrow at `workspace-steps.ts:578-586`. Node reuse only checks D1 heartbeat/readiness/version at `apps/api/src/services/node-agent-health.ts:4-39`, explaining how an auth-broken but heartbeating node remained eligible. The exact validator rejection remains unverified.

All-time snapshot: **4,246 completed, 1,920 failed, 335 cancelled, 718 draft, 74 ready, 42 in progress, and 1 delegated**. Failed tasks were **30.93%** of completed+failed+in-progress, up 0.31 percentage points from 30.62%.

State checks found **0/39 failed rows missing `completed_at`**. Two of 95 completed rows lacked both `started_at` and `completed_at`; both were Idea lifecycle rows, not executed tasks. Ninety-three completed rows retained `execution_step`, matching current completion-writer behavior. This scan found no new terminal timestamp drift in executed failures.

## 4. AI Gateway — `sam`

The paginated scan downloaded 1,000 rows and retained **225 fresh rows** from 2026-09-21T12:01:46.880Z through 2026-09-28T09:03:51.904Z; 775 downloaded rows were stale and discarded. All **225/225 were HTTP 200 successes**: zero 401, 403, 429, or 5xx. Volume rose 213→225 (+5.6%).

| Model | Calls | HTTP outcomes | Duration P50/P99/max | Provider latency P50/P99 |
|---|---:|---|---:|---:|
| `@cf/google/gemma-4-26b-a4b-it` | 151 | 151×200 | 914 / 3,540.5 / 7,289 ms | 764.73 / 3,308.89 ms |
| `@cf/zai-org/glm-5.2` | 74 | 74×200 | 11,270.5 / 50,061.09 / 53,979 ms | 10,793.67 / 49,831.56 ms |

Call sources were **150 task-title, 74 platform-feedback-triage, and 1 session-summarize**. The newest row was 31.096 seconds old; this is current evidence, not a stale-gateway finding.

## 5. Trends versus 2026-09-21

| Signal | Prior | Current | Change |
|---|---:|---:|---:|
| Worker requests | 613,984 | 638,766 | +4.0% |
| Worker runtime errors | 1 | 0 | -1 |
| clientDisconnected : success | 0.001872:1 | 0.004510:1 | +141.0% |
| responseStreamDisconnected | 546 | 459 | -15.9% |
| platform error rows | 295 | 1,442 | +388.8% |
| exact DO overload rows | 12 | 3 | -75.0% |
| exact DO CPU-reset rows | 4 | 0 | resolved in-window |
| task raw failure share | 8.51% | 22.67% | +14.16 pp |
| task-mode raw failure share | 9.00% | 19.67% | +10.67 pp |
| conversation-mode raw failure share | 7.32% | 30.00% | +22.68 pp |
| AI Gateway success | 100% | 100% | flat |
| ProjectData latest point sample | 9,983,135,744 B | 9,928,892,416 B | -54,243,328 B |
| Published archive journals | 58 | 89 | +31 |
| Archive breaker | closed | open | regressed |

ProjectData history crossed the configured threshold: **10,019,016,704 bytes (100.1902%) on Sep 22** and a window peak of **10,089,926,656 bytes (100.8993%) on Sep 23**. The latest point sample at 2026-09-28T09:09:08.764Z was 161,034,240 bytes below that peak but remained `degraded` at 99.2889%.

The breaker chain is verified. Compact R2 work races the deployed 10,000 ms deadline at `apps/api/src/project-data-archive/compact-r2.ts:17-50,324-352`; failed copy records timeout evidence at `apps/api/src/scheduled/project-data-archive-sharding.ts:2503-2532`; the third failure poisons and opens the breaker at `:3119-3152,3226-3271`; candidate/reclaim and lease paths require `closed` at `:1182-1206,1347-1388,1635-1665`. **Why the R2 PUT exceeded 10 seconds is unverified.**

## Prioritized findings

| Severity | Finding | Concrete evidence | Suspected root cause or verified code behavior | Idea |
|---|---|---|---|---|
| Critical | Archive drain blocked near configured ProjectData limit | Breaker open; 3×10s PUT deadlines; 99.2889%; 71,107,584 B headroom; peak 100.8993% | Verified timeout→poison→breaker chain; provider latency cause unverified (`compact-r2.ts:17-50,324-352`; `project-data-archive-sharding.ts:3119-3271`) | [01M0YZNBKSKQZ47NC0K7M8N5AX](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0YZNBKSKQZ47NC0K7M8N5AX) |
| High | D1 interval caused broad user/API 500s, but wrapper causes are lost | 316 wrappers; 280 on Sep 25; 11 explicit overloads; 250 wrappers overlap exact interval | Persistence keeps wrapper and drops bounded nested cause (`app-error-handler.ts:50-89`; `logger.ts:87-99`) | [01M3KMR77154WXABJBDZ22S4BB](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M3KMR77154WXABJBDZ22S4BB) |
| High | Auth-broken node failed six conversations | 6 tasks/7m33s; one node; 0 retries; all `workspace_dispatch` | Generic validator response + permanent classifier + heartbeat-only reuse (`jwt.go:124-167,239-261`; `workspaces.go:138-153`; `helpers.ts:45-92`; `node-agent-health.ts:4-39`) | [01M3KMQENDAQCCZR06Z2HX53EB](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M3KMQENDAQCCZR06Z2HX53EB) |
| High | Snapshot manifests exceed API contract | 10 errors; 7 workspaces; 5 nodes; all 7 degraded to transcript-only | 256 KiB API cap vs uncapped skipped-entry list (`session-snapshot-artifacts.ts:13-18,175-193`; `session_snapshot_*:29-49,180-230,389-431`) | [01M3KMQW7PWMR31PWWTJTPE51J](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M3KMQW7PWMR31PWWTJTPE51J) |
| Medium | Expected snapshot lifecycle 410s remain errors | 146 rows: 70 sleeping, 44 deleted, 32 stopping | Untyped HTTP error misses teardown classifier (`_helpers.ts:23-28,48-67`; `session_snapshot_control_plane.go:107-133`; `session_snapshot_coordinator.go:84-153`) | [01M31M9FVCDWTGN3QCNAXWZ0K6](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M31M9FVCDWTGN3QCNAXWZ0K6) |
| Medium | Task reliability worsened | 39 failed; raw share 22.67% vs 8.51%; terminal share 29.10% | Mixed causes: 11 user/provider usage limits, 6 auth-node defect, 6 intended expiries, 5 pre-fix provider quota, 11 other | Discrete defects linked above |
| Medium | Client disconnect ratio rose | 2,866/635,441 = 0.004510:1; +141.0%; 91.24% on three days | Route attribution unavailable; streaming/WebSocket surfaces are hypotheses | [01KT90P8M8YZ0CKZPH5WRH16MS](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90P8M8YZ0CKZPH5WRH16MS) |
| Low | Deletion quarantine still omits diagnostics | 1 row; null context; null stack | Existing persistence omits reason/attempt | [01M2FKS8MMKTX5F4YD7RYSSYFE](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2FKS8MMKTX5F4YD7RYSSYFE) |

## Watched but healthy

- **AI Gateway:** 225/225 fresh calls succeeded; 0 auth, overload, rate-limit, or 5xx responses. The latest row was 31.096 seconds old.
- **Worker runtime:** 638,766 invocations produced 0 runtime errors. Response-stream disconnects fell 15.9%.
- **ProjectData CPU classifier:** 0 exact CPU-reset rows, down from 4; exact DO overload rows fell 12→3.
- **Provider fallback:** raw Hetzner 412s fell 21.3%, and both terminal tasks prove all three permitted offerings were attempted. Five shared-core 403 failures all preceded the deployed quota-descent fix.
- **Strict deletion repair:** all five nodes behind 256 historical missing-identity errors are now deleted with termination proof; the final error preceded the terminal repairs.
- **Legacy regressions:** 0 unsupported-location 422, installation-token, cancel-grace, or TaskRunner/D1 mismatch signatures.
- **Terminal metadata:** 0/39 failed rows lacked `completed_at`; the two completed rows without runner timestamps were Idea lifecycle rows.
