# SAM weekly production health review — 2026-09-14

**Review window:** 2026-09-07T09:08:04Z–2026-09-14T09:08:04Z. **Baseline:** `/health-reports/health-report-2026-09-07.md`. All production queries were read-only. Counts below use the exact window unless a row is explicitly labeled all-time or snapshot. The newest `platform_errors` row was 2026-09-14T09:06:29.725Z, 95 seconds before cutoff; the newest AI Gateway row was 2026-09-14T09:01:23.906Z, so both sources were current.

## Executive diff

### New since last run

- **One post-fix provisioning timeout exposed a pool-revision invalidation path.** Task `01M2CN8H…` carried revision 7 while a concurrent successful node carried revision 8; the rejected task then reached the original 15-minute provisioning ceiling. This is tracked in [01M236QPGGC6B150FG4QHT17MW](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M236QPGGC6B150FG4QHT17MW).
- **GitHub installation-token minting produced 21 HTTP 500 errors across two workspaces in 72.379 seconds, with zero later recurrences.** Retry, request coalescing, and diagnostic retention are tracked in new Idea [01M2FKRVFQJ7GQ1ZFHMD3M5Y2C](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2FKRVFQJ7GQ1ZFHMD3M5Y2C).
- **Five workspace-deletion quarantines converged, but all five persisted error rows omitted the reason and attempt count.** Zero of the five affected workspaces remained active or stopping at review time. The observability gap is tracked in new Idea [01M2FKS8MMKTX5F4YD7RYSSYFE](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2FKS8MMKTX5F4YD7RYSSYFE).

### Still open

- **ProjectData remains degraded at 9,773,703,168/10,000,000,000 bytes (97.737%).** The window gained 367,534,080 bytes even as published archive journals increased from 98 to 175. Tracked in [01M0YZNBKSKQZ47NC0K7M8N5AX](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0YZNBKSKQZ47NC0K7M8N5AX).
- **Policy/liveness terminalization dominates task failures:** 57/88 failures (64.77%) were absolute-ceiling or runtime-liveness decisions, and 52/57 had a sleeping session snapshot. The sleeping-session behavior is tracked in [01M2CKHT52MKAZ8DTH91N6J185](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2CKHT52MKAZ8DTH91N6J185).
- **Terminal task metadata still drifts:** 4 failed rows lacked `completed_at`, while 92/199 recent terminal rows retained `execution_step`. Tracked in [01KZNGJG1DCH8DBC835Y0272P4](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4).
- **The CPU-reset retry gap remains:** eight CPU-limit reset rows arrived within 20 ms; seven of their request paths bypass the existing Durable Object retry wrapper. Tracked in [01M1XKK208SJV9VJA4BXP2KBHT](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKK208SJV9VJA4BXP2KBHT).

### Resolved

- **Hetzner placement fallback recovered in production.** Of 31 raw 412 platform rows, 7 were pre-fix terminal failures and 24 were post-fix candidate failures across 14 tasks; all 14/14 post-fix tasks found a later successful offering. The broader resiliency plan remains in [01KQXHKV6A34HJQR4YCACZR734](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KQXHKV6A34HJQR4YCACZR734).
- **The legacy strict-delete incident ended.** Thirty-five errors concerned one node and stopped on 2026-09-08; that node now has `status='deleted'` and `runtime_termination_confirmed_at='2026-09-08T22:05:23.604Z'`. The bounded cleanup tracker was updated: [01M1XKJMK2MQXKQ219TYN824H8](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKJMK2MQXKQ219TYN824H8).
- **The client-disconnect anomaly fell 92.1%.** The ratio moved from 0.013010:1 to 0.001023:1 (1,027 disconnects / 1,003,629 successful invocations). Updated: [01KT90P8M8YZ0CKZPH5WRH16MS](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90P8M8YZ0CKZPH5WRH16MS).
- **Prior authentication and overload bursts did not recur.** Fresh AI Gateway logs contained 0 HTTP 401/403 responses, recent tasks contained 0 DNS authorization failures, ACP activity callbacks contained 0 overload rows, `chat.session_detail_load_failed` occurred 0 times, and the TaskRunner mismatch warning occurred 0 times. Related trackers: [01M1XKJV7Q4CJ35KPEAC4P5QXS](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKJV7Q4CJ35KPEAC4P5QXS), [01M1BKG7BE6HD81QC1Y0HBQVSJ](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1BKG7BE6HD81QC1Y0HBQVSJ), [01KT90KPP533AKPZVG047F5MVP](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90KPP533AKPZVG047F5MVP), and [01KT90PKF6167SXZ9YZY0R26MM](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90PKF6167SXZ9YZY0R26MM).

## 1. Workers analytics — `sam-api-prod`

| Invocation status | Requests | Errors | Subrequests | CPU P50/P99 | Wall P50/P99 |
|---|---:|---:|---:|---:|---:|
| success | 1,003,629 | 0 | 1,050,577 | 2.678 ms / 70.730 ms | 105.400 ms / 3.309 s |
| clientDisconnected | 1,027 | 0 | 1,619 | 57.113 ms / 274.577 ms | 21.914 s / 14,896.998 s |
| responseStreamDisconnected | 1,239 | 0 | 1,999 | 80.677 ms / 200.627 ms | 120.974 s / 19,502.973 s |
| scriptThrewException | 1 | 1 | 1 | 22.031 ms / 22.031 ms | 145.471 s / 145.471 s |
| **Total** | **1,005,896** | **1** | **1,054,196** | — | — |

The runtime-error rate was **1/1,005,896 = 0.0000994%**. Request volume fell **20.5%** from 1,265,819 and runtime errors fell **92.3%** from 13. `clientDisconnected` fell from 16,246 to 1,027; `responseStreamDisconnected` rose from 837 to 1,239 (**+48.0%**) and remains watched.

The only `scriptThrewException` was on 2026-09-13. Daily successful invocation volume ranged from **108,443 to 191,613** on the six complete UTC dates (Sep 8–13); the Sep 7 and Sep 14 rows were partial.

Cloudflare's zone HTTP analytics query returned the concrete authorization result `actor token lacks com.cloudflare.api.account.zone.analytics.read`, so a directly comparable request status-code series was unavailable. Workers Observability telemetry covered 2026-09-07T09:18:35.138Z through cutoff at an approximately 10× sampling interval and estimated these leading event counts: **200 1,159,700; status 0 846,710; 204 208,270; 304 13,920; 404 11,860; 301 9,020**. Estimated 5xx events totaled **180** (500 130, 503 20, 522/524/525 10 each). These are sampling-adjusted telemetry-event estimates, can exceed invocation totals, and are not used as request or error-rate denominators.

## 2. Observability — `platform_errors`

The window contained **4,286 rows**: **230 error, 219 warn, and 3,837 info**. By source, API contributed **223 error / 180 warn / 827 info** and VM agent contributed **7 error / 39 warn / 3,010 info**. Versus the prior report, total rows fell **33.7%**, errors **55.6%**, warnings **24.5%**, and info rows **32.1%**.

| Rank | Exact error message | Count | Trend and verified interpretation |
|---:|---|---:|---|
| 1 | `Failed to destroy max-lifetime node… exact provider credential binding is missing` | 35 | Down from 40 related strict-cleanup errors; all 35 concern one node, the last was Sep 8, and the node is now deleted with runtime termination proof. **Resolved.** |
| 2 | `Node provisioning failed: hetzner API error (412): error during placement` | 31 | New raw pattern. Seven pre-fix attempts became terminal task failures; 24 post-fix attempts across 14 tasks all found a later successful candidate. **Resolved regression; current fallback verified 14/14.** |
| 3 | `Failed to get installation token: 500` | 21 | New. Two workspaces, one 72.379-second Sep 13 burst, zero later occurrences. **Current upstream cause unverified; retry/diagnostic gap open.** |
| 4 | `Durable Object exceeded its CPU time limit and was reset.` | 8 | Down from 25 (**-68.0%**); all eight occurred within 20 ms on Sep 9, with zero later recurrence. **Retry/classification gap open.** |
| 5 | `Workspace deletion entered durable operator quarantine` | 5 | New. All five affected workspaces converged and zero remain active/stopping. **Diagnostic gap open because reason and attempts were not persisted.** |

The exact Durable Object overload message occurred **once**, down from 237; it was a session WebSocket request rather than an ACP activity callback. Four provider `403 server_limit` rows occurred on Sep 12; current `vm_provider_capacity_state` is `ok`, with `last_success_at='2026-09-14T09:02:02.251Z'`, so this is a recovered capacity constraint rather than a current outage.

Code correlation for the material rows:

- The fixed 412 classifier maps structured placement errors and production-shaped 412 text to transient capacity at `packages/providers/src/hetzner-metadata.ts:203-243,288-318`; TaskRunner continues to later candidates at `apps/api/src/durable-objects/task-runner/node-provisioning-step.ts:669-717`.
- Installation-token minting makes one upstream request, throws on non-2xx, and caches only success at `apps/api/src/services/github-app.ts:337-380`; the route lets it escape at `apps/api/src/routes/workspaces/runtime.ts:1785-1800`.
- The transient Durable Object classifier omits the exact CPU-limit form at `apps/api/src/services/durable-object-retry.ts:7-14`; five activity calls and two heartbeat calls bypass the wrapper at `apps/api/src/services/project-data.ts:1803-1821,1874-1880`.
- Deletion quarantine can result from identity/incarnation checks or a fenced classifier at `apps/api/src/durable-objects/node-lifecycle-workspace-deletion.ts:358-423,464-570`, but `deadLetterExact` omits reason and attempt data from its persisted error at lines 676-716. All five events were below the configured/default 24-hour residence limit, excluding maximum residence as their branch.

## 3. Task reliability — `sam-prod.tasks`

### Seven-day window

| Mode | Completed | Failed | In progress | Cancelled | Draft | Failure share among completed + failed + in progress |
|---|---:|---:|---:|---:|---:|---:|
| task | 89 | 13 | 1 | 5 | 102 | 12.62% |
| conversation | 1 | 75 | 2 | 16 | 0 | 96.15% |
| **Total** | **90** | **88** | **3** | **21** | **102** | **48.62%** |

The comparable raw failure share rose from **45.19% to 48.62% (+3.43 percentage points)**. Task-mode reliability improved from **32.78% failure to 12.62%**, while conversation-mode failure rose from **83.05% to 96.15%**. The mode split is essential: only one conversation completed in-window, while 75 were terminalized as failed.

| Failed-task cause | Count | Share of 88 |
|---|---:|---:|
| 1,440-minute absolute ceiling (`awaiting_followup` 35; `running` 10) | 45 | 51.14% |
| Runtime liveness/workspace-state verdicts | 12 | 13.64% |
| Node provisioning timeout | 8 | 9.09% |
| Hetzner placement 412 | 7 | 7.95% |
| Node agent not ready after 900,000 ms | 5 | 5.68% |
| Instant safe-checkpoint restore | 3 | 3.41% |
| Claude session limit | 3 | 3.41% |
| Other singletons | 5 | 5.68% |

The ceiling and liveness groups total **57/88 (64.77%)**. Snapshot correlation found **45/45** ceiling failures and **7/12** liveness failures in `sleeping`, for **52/57** combined. The 24-hour default is defined at `packages/shared/src/constants/task-execution.ts:22-34`; the sweep skips full liveness probing after the ceiling and terminalizes after a supersession check at `apps/api/src/scheduled/stuck-tasks.ts:1122-1181`. Whether each of the ten `running` rows still represented active billable compute at terminalization is unverified.

The eight provisioning timeouts split into **six** pre-#2049 startup deadlock cases, **one** older unexplained case, and **one** Sep 13 pool-revision recurrence. Exact revision equality is required at `apps/api/src/services/placement-authority.ts:164-180,207-220`; workspace loss returns to node selection without resetting the original timer at `apps/api/src/durable-objects/task-runner/workspace-steps.ts:251-265`. The observed revision 7→8 relationship supports the **hypothesis** that a concurrent pool revision invalidated the new node, but the initiating edit is not retained.

All five agent-ready timeouts are consistent with the already documented deployment version-skew period. Readiness requires exact agent version at `apps/api/src/durable-objects/task-runner/readiness.ts:19-27`, while the failure log labels every healthy-heartbeat rejection `stale_heartbeat` at `apps/api/src/durable-objects/task-runner/node-agent-ready-step.ts:88-97`; the remaining problem is reason-specific diagnosis and faster rejection.

### All-time snapshot and state drift

All-time status counts were **4,051 completed, 1,833 failed, 245 cancelled, 603 draft, 72 ready, and 3 in progress**. Failed tasks were **31.14%** of completed + failed + in-progress rows; treating cancelled as unsuccessful produced **33.89%**, up from **33.00%** in the prior snapshot.

Four recent failed rows lacked `completed_at`: three Instant restore writers at `apps/api/src/durable-objects/vm-agent-container-recovery.ts:514-527` and one TaskRunner startup catch at `apps/api/src/routes/tasks/submit.ts:731-742`. Of 199 recent terminal rows, **92 retained `execution_step`**: 88/90 completed, 3/21 cancelled, and 1/88 failed. The dominant completed writer omits the clear at `apps/api/src/routes/mcp/task-tools.ts:412-422`; other direct writers appear at `apps/api/src/routes/tasks/crud.ts:747-751`, `apps/api/src/routes/mcp/orchestration-comms.ts:550-565`, and `apps/api/src/durable-objects/sam-session/tools/stop-subtask.ts:121-131`.

## 4. AI Gateway — `sam`

The paginated scan returned **304/304 fresh rows** in the window, from 2026-09-07T09:31:06.301Z to 2026-09-14T09:01:23.906Z; **zero stale rows** were included. There were **303 successes and 1 error (99.671% success)**, with **0 HTTP 401, 403, or 5xx** responses. Volume fell from 430 to 304 (**-29.3%**), while success rose from 90.93% to 99.67%.

| Model | Calls | HTTP outcomes | Duration P50/P99/max | Provider latency P50/P99 |
|---|---:|---|---:|---:|
| `glm-5.2` | 300 | 299×200, 1×429 | 2,889 / 29,720 / 66,878 ms | 2,713.572 / 29,495.330 ms |
| `gemma` | 4 | 4×200 | 8,457.5 / 9,297.61 / 9,322 ms | 8,325.405 / 9,207.215 ms |

The only error was a `glm-5.2` HTTP 429 at 2026-09-08T12:31:56.517Z on `platform-feedback-triage`, with 5,927 ms duration and 5,650.449 ms provider latency. It had zero later recurrences. Call sources were **154 task-title, 146 platform-feedback-triage, and 4 session-summarize**.

## 5. Trends versus 2026-09-07

| Signal | Prior | Current | Change |
|---|---:|---:|---:|
| Worker requests | 1,265,819 | 1,005,896 | -20.5% |
| Worker runtime errors | 13 | 1 | -92.3% |
| clientDisconnected : success | 0.013010:1 | 0.001023:1 | -92.1% |
| responseStreamDisconnected | 837 | 1,239 | +48.0% |
| platform error rows | 518 | 230 | -55.6% |
| task raw failure share | 45.19% | 48.62% | +3.43 pp |
| task-mode failure share | 32.78% | 12.62% | -20.16 pp |
| conversation-mode failure share | 83.05% | 96.15% | +13.10 pp |
| AI Gateway success | 90.93% | 99.67% | +8.74 pp |
| ProjectData latest usage | 96.791% | 97.737% | +0.946 pp |
| Published archive journals | 98 | 175 | +77 |

ProjectData's 168 hourly samples ranged from **9,406,169,088 to 9,775,878,144 bytes**, ending at **9,773,703,168 bytes** on 2026-09-14T08:14:08.839Z. Telemetry estimated **9,468,919 bytes/day** and **23.90 days** to the configured 10 GB threshold. The latest archive sweep succeeded with `run_count=275`, **0 budget stalls**, and no last error; archive publication therefore progressed, but the measured net growth was still **367,534,080 bytes**. The archive selector covers stopped/failed sessions past seven days at `apps/api/src/scheduled/project-data-archive-sharding.ts:1316-1348`, and publication retains the root `chat_sessions` anchor while deleting three payload tables at `apps/api/src/durable-objects/project-data/archive-sharding.ts:2244-2286`. **Hypothesis:** active, recent, ineligible, or root-retained data dominates the remaining growth; current per-category byte telemetry is insufficient to identify which category.

## Prioritized findings

| Severity | Finding | Concrete evidence | Suspected root cause or verified code behavior | Idea |
|---|---|---|---|---|
| Critical | ProjectData capacity remains degraded | 9,773,703,168/10B bytes (97.737%); +367,534,080 bytes in-window; 23.90-day telemetry estimate | Selector/revalidation exclude live and ineligible sessions (`project-data-archive-sharding.ts:1316-1348`; `archive-sharding.ts:676-803`); category driving growth is an unverified hypothesis | [01M0YZNBKSKQZ47NC0K7M8N5AX](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0YZNBKSKQZ47NC0K7M8N5AX) |
| High | Sleeping conversations are terminalized as failures | 57/88 failures were ceiling/liveness; 52/57 had sleeping snapshots | Over-ceiling path performs only supersession check before failure (`stuck-tasks.ts:1122-1181`) | [01M2CKHT52MKAZ8DTH91N6J185](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2CKHT52MKAZ8DTH91N6J185) |
| High | Pool revision invalidated one provisioned candidate and retained the old timer | 1 post-fix Sep 13 timeout; task revision 7 versus concurrent success revision 8 | Exact revision joins (`placement-authority.ts:164-180,207-220`) plus timer preservation on workspace loss (`workspace-steps.ts:251-265`) | [01M236QPGGC6B150FG4QHT17MW](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M236QPGGC6B150FG4QHT17MW) |
| Medium | Terminal writers violate metadata invariants | 4 failed rows missing `completed_at`; 92/199 terminal rows retain `execution_step` | Direct writers bypass `transitionTaskToTerminal`; cited above | [01KZNGJG1DCH8DBC835Y0272P4](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4) |
| Medium | CPU-limit reset is not retried on observed paths | 8 rows in 20 ms: 5 activity, 2 heartbeat, 1 WebSocket | Exact string absent from classifier; 7/8 calls bypass wrapper (`durable-object-retry.ts:7-14`; `project-data.ts:1803-1821,1874-1880`) | [01M1XKK208SJV9VJA4BXP2KBHT](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKK208SJV9VJA4BXP2KBHT) |
| Medium | Installation-token mint failures multiply across concurrent callers | 21 HTTP 500 rows, 2 workspaces, 72.379-second burst | One upstream request with no retry/coalescing and success-only cache (`github-app.ts:337-380`) | [01M2FKRVFQJ7GQ1ZFHMD3M5Y2C](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2FKRVFQJ7GQ1ZFHMD3M5Y2C) |
| Low | Deletion quarantine cannot be classified from telemetry | 5 rows, all with null context/stack; 0/5 remain active/stopping | `deadLetterExact` omits retained reason/attempt data (`node-lifecycle-workspace-deletion.ts:676-716`) | [01M2FKS8MMKTX5F4YD7RYSSYFE](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2FKS8MMKTX5F4YD7RYSSYFE) |

## Watched but healthy

- **Hetzner fallback:** 24/24 post-fix 412 candidate failures were followed by a successful offering, covering 14/14 affected tasks.
- **Provider-account capacity:** four Sep 12 `server_limit` rows recovered; state was `ok` with a successful allocation at 2026-09-14T09:02:02.251Z.
- **AI authentication:** 0/304 fresh Gateway logs returned 401 or 403; 0 recent tasks had DNS-provider authorization failures.
- **Durable Object overload:** one exact overload row versus 237 previously; ACP activity callbacks had zero overload rows.
- **Prior task regressions:** 0 unsupported Hetzner location 422 failures, 0 check-in-unresponsive failures, 0 `chat.session_detail_load_failed` rows, and 0 TaskRunner-completed/task-still-in-progress warnings.
- **Instant recovery:** three checkpoint-restore failures occurred on Sep 7 or Sep 10, with zero later recurrences; tracked in [01M13WC07W88NKBGB262X7PCK4](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M13WC07W88NKBGB262X7PCK4).
- **AI overload:** one HTTP 429 among 304 Gateway calls (0.329%), with zero later recurrences and zero 5xx responses.
