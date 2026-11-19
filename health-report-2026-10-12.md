# SAM weekly production health review — 2026-10-12

**Window:** 2026-10-05T09:04:23Z–2026-10-12T09:04:23Z, contiguous with the October 5 report (not retained in this repository; its comparison baseline was not independently reverified during PR completion). Production APIs were queried with the debugging token; no code, configuration, resources, task lifecycle, branches or PRs were changed. Only report/library and idea artifacts were authored. Current deployment: CF `45d690b8-f5cc-43e9-bb8b-8d5def216c6f`, Worker `5d8df34c-7fb8-4f08-8b5b-2f0df4158f99` at 100% (Oct 12 08:33:32Z), matching successful Deploy Production [38223482812](https://github.com/raphaeltm/simple-agent-manager/actions/runs/38223482812) on `e82d14ec13745378e1a5008b95410b77e9a1d4e5`. Local code citations use that revision. The three remediation commits #2241, #2269 and #2279 are ancestors of this deployed revision (git ancestry exit0 for each).

**Freshness:** newest platform row at query time 2026-10-12T09:06:53.804Z; newest AI Gateway call 09:00:18.068Z; root storage measurement 09:01:12.650Z. Post-cutoff platform rows are excluded from seven-day totals. AI Gateway pagination discarded 36 older rows. Workers Observability clips its available start and returns sampled estimates; these are explicitly separated from GraphQL invocation counts. Counts below cite named query results; reproducible query definitions are in the evidence appendix.

## Executive diff

### New since last run

- **F1 — Sleep teardown can strand a stopping claim:** one task remains `in_progress`/D1 workspace `running`, despite snapshot `sleep_status=stopping`, three attempts and runtime-stop 409 “already stopped.” It has **179 repeated idle diagnostics**, latest reporting **17h58m** without prompt/tool work. Existing [01KZZ9Y0B4957R9KR40TNEE3KP](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZZ9Y0B4957R9KR40TNEE3KP) updated. This is a newly code-grounded case, not proof of 179 separate stranded sessions. [Q8,Q9]
- **F2 — Mission double-start:** **2 failed tasks, 2 session rows per task** on October 10. Existing [01M4KKNAZY6KSSCXR610T01E11](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M4KKNAZY6KSSCXR610T01E11) updated. [Q3,Q10]
- **F3 — Prompt-failure attribution:** **7 failed tasks** carry only `agent_prompt_failed`; **40 ACP failure rows** also retain only that category plus duration (prior 4). Existing recoverable-error idea [01KWKDYXNB97J4Z5Q9RGS8APPF](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KWKDYXNB97J4Z5Q9RGS8APPF) updated with the safe classification gap. Provider quota, authentication and overload remain unverified from these rows. [Q3,Q11]
- **F4 — KV 429 becomes application 500:** **5** errors (prior 2), split **3 MCP +2 boot-log** callbacks. New [01M4QNWEZG8KQQDF2R9VTK8TWM](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M4QNWEZG8KQQDF2R9VTK8TWM). [Q4,Q6]
- **F5 — Diagnostic dedupe query fails:** **179** same-task/same-key info rows; **10 sampled lookup-failure logs** explicitly say `LIKE or GLOB pattern too complex`. New [01M4QP1EX1YVKRVVPTBP2G0RD8](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M4QP1EX1YVKRVVPTBP2G0RD8). [Q8,Q12]

### Still open

- **Instant timestamp gap:** **3 executed/completed Instant tasks lack `started_at`**; each has a completion timestamp. [01KZNGJG1DCH8DBC835Y0272P4](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4) updated. Twelve other completed task-mode rows without execution timestamps are idea lifecycle records, not executed runs. [Q13]
- **Snapshot lifecycle error classification:** **9 vm-agent 410 error rows**, down from 135; last Oct 8 18:11:15Z. The VM still flattens terminal callbacks into generic errors, so zero recent recurrence does not close the code gap. [01M31M9FVCDWTGN3QCNAXWZ0K6](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M31M9FVCDWTGN3QCNAXWZ0K6) updated. [Q4]
- **Disconnect watch:** **2,528 client disconnects /665,342 successes =0.003800:1**, down 50.8% from 0.007730:1. The cause of the residual disconnects remains a hypothesis. [01KT90P8M8YZ0CKZPH5WRH16MS](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90P8M8YZ0CKZPH5WRH16MS) is cancelled and cannot accept updates; trend retained here. [Q1]
- **TaskRunner handoff mismatch:** **2 warnings** versus 3; the old exact `DO completed but task still in_progress` signature is 0. [01KT90PKF6167SXZ9YZY0R26MM](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90PKF6167SXZ9YZY0R26MM) updated. [Q4]
- **Historical resource telemetry repair is still unverified/unapproved:** new failed resource-chunk inserts stopped Oct 6 05:53Z (**20 this window vs 29 prior**), but this scan did not audit or repair historical damaged summaries/R2 payloads. [01M467A56CDK9B28TCWZZYBF23](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M467A56CDK9B28TCWZZYBF23) updated. [Q4; existing idea deployment/remediation ledger]

### Resolved / no recurrence after remediation

“Resolved” here means the specified production signature or diagnostic gap cleared; it does not imply all related idea scope is complete.

- **Snapshot prepare 500:** **145 API +145 VM errors** before Oct 8 20:02:14Z; **0 after**, through cutoff. #2279 supplies typed 409 and admission checks. [01M0SHQC8V34S2P0JMZR53TEJN](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0SHQC8V34S2P0JMZR53TEJN) updated. [Q4; deployed-code ancestry]
- **SQLite memory-error recurrence:** **17 callback 500s** (15 activity +2 heartbeat), last Oct 8 15:50Z; **0 after**. #2269 bounds cleanup and retries only safe idempotent calls. Its cause is not proved solely by temporal correlation. [01M1XKK208SJV9VJA4BXP2KBHT](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M1XKK208SJV9VJA4BXP2KBHT) is already completed; no mutation attempted. [Q4,Q6]
- **Deletion quarantine diagnostic gap:** **3/3** rows now contain reason and attemptCount 1 (prior 3/3 empty). All say “workspace identity or status changed before VM deletion.” [01M2FKS8MMKTX5F4YD7RYSSYFE](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M2FKS8MMKTX5F4YD7RYSSYFE) updated; guarded deletion itself is not classified as a defect. [Q6]
- **Legacy in-progress/deleted drift:** **0** now, versus 71; all 4 in-progress tasks have running workspaces. [01M43NCRFC9VF93RPM355FZAKJ](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M43NCRFC9VF93RPM355FZAKJ) already completed. [Q5]
- **Storage-full outage signature:** **0 storage-full rows** this window; latest root DO **8,751,788,032B /87.52%**, down 937,054,208B from the prior report’s 9,688,842,240B. Target below 9 GB met; status remains warning. [01M0YZNBKSKQZ47NC0K7M8N5AX](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M0YZNBKSKQZ47NC0K7M8N5AX) already records target met and is text-full; no append attempted. [Q4,Q7]
- **Other prior findings:** incident-dedup UNIQUE errors 20→0 ([01M467BG1QA560DSQBYGDZKS0V](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M467BG1QA560DSQBYGDZKS0V)); git-token terminal transport failures2→0 ([01M4677Q5M238BSZV86GH0SHCZ](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M4677Q5M238BSZV86GH0SHCZ)); capacity-pool node-limit failures6→0 ([01M4677451EBA2GZW0TENE0WEM](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M4677451EBA2GZW0TENE0WEM)); failed tasks missing completed_at 1→0/23; hard 15-minute scheduled runtime errors 2→0. These absences do not prove all code paths fixed. [Q1,Q3,Q4,Q13]
- **June baseline:** `chat.session_detail_load_failed`0, unsupported-location422 failed tasks 0 (both ideas already completed: [01KT90KPP533AKPZVG047F5MVP](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90KPP533AKPZVG047F5MVP), [01KT90MP0FPY15WTB8T67PFTGG](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KT90MP0FPY15WTB8T67PFTGG)). Disconnect and TaskRunner trends above cover the two other June ideas. [Q3,Q4]

## 1. Workers analytics — sam-api-prod

| Invocation outcome         |    Requests | Runtime errors | Subrequests | CPU P50/P99 (ms) |         Wall P50/P99 (ms) |
| -------------------------- | ----------: | -------------: | ----------: | ---------------: | ------------------------: |
| clientDisconnected         |       2,528 |              0 |       2,184 |    6.052/196.590 |   9,997.016/3,115,968.000 |
| responseStreamDisconnected |       1,625 |              0 |       2,570 |   75.793/235.840 | 136,632.670/8,877,213.000 |
| success                    |     665,342 |              0 |     756,867 |    5.459/121.960 |         265.118/2,726.640 |
| **Total**                  | **669,495** |          **0** | **761,621** |                — |                         — |

[Q1] Requests fell 16.9% from 806,067. Success CPU P50 fell 6.8% (5.859→5.459 ms), but P99 rose 73.0% (70.488→121.960 ms); wall P50 rose 6.5% (248.824→265.118 ms), P99 rose 8.1% (2,522→2,726.640 ms). Response-stream disconnects are flat (1,616→1,625,+0.6%). These outcome quantiles cannot attribute an endpoint or prove a user-visible regression.

| UTC day              | Success | clientDisconnected | Ratio to success |
| -------------------- | ------: | -----------------: | ---------------: |
| 2026-10-05 (partial) |  52,813 |                315 |       0.005964:1 |
| 2026-10-06           | 100,151 |                833 |       0.008317:1 |
| 2026-10-07           | 108,921 |                354 |       0.003250:1 |
| 2026-10-08           | 124,331 |                469 |       0.003772:1 |
| 2026-10-09           |  93,354 |                200 |       0.002142:1 |
| 2026-10-10           |  84,798 |                148 |       0.001745:1 |
| 2026-10-11           |  83,501 |                180 |       0.002156:1 |
| 2026-10-12 (partial) |  17,473 |                 29 |       0.001660:1 |

[Q1] Most disconnected invocations retain a ~10-second median (9,997.016 ms overall). **Hypothesis:** the shared VM transport response-header timeout participates (`packages/vm-agent/internal/config/helpers.go:202`); intentionally closed browser streams also exist. Endpoint-specific causal attribution was not established.

**HTTP response codes — sampled Workers Observability estimates [Q2].** These are weighted sampled fetch-event estimates, **not** the GraphQL invocation total. Status0 is not an HTTP error code. Available series startsOct 5 14:14:03Z (~5h10m later than requested), so comparisons are approximate.

| Code | Estimated events |
| ---- | ---------------: |
| 0    |          669,750 |
| 200  |          759,020 |
| 201  |              140 |
| 202  |              710 |
| 204  |          113,250 |
| 301  |            2,740 |
| 304  |            6,580 |
| 308  |              170 |
| 400  |              670 |
| 401  |               10 |
| 403  |              110 |
| 404  |           13,250 |
| 405  |               80 |
| 410  |               70 |
| 428  |               20 |
| 500  |              240 |
| 503  |               10 |

Estimated 5 xx **250** (500240,50310) versus 2,030 prior (−87.7%); 4 xx **14,210** versus 11,490 (+23.7%), dominated by 40413,250. The scan does not establish whether 404s are expected requests or broken links, and no vague 404 idea was filed. The lack of runtime errors does not imply zero application 500s: Q6 proves KV and callback 500s.

Other Workers [Q1b]: sam-tail-worker-prod **1,537,341 invocations/0 errors** (prior 1,829,458), website **3,126/0** (prior 2,816).

## 2. Observability — platform_errors

**8,866 rows: 530 error,160 warn,8,176 info.** Prior9,187:1,471 error,163 warn,7,553 info. Error rows fell 64.0%; warnings fell 1.8%. [Q4]

| Source   | Error | Warn | Info |
| -------- | ----: | ---: | ---: |
| api      |   373 |  107 |  973 |
| vm-agent |   157 |   53 | 7203 |

Top five **normalized incident categories** (pairing duplicate API/VM manifestations and combining numeric storage percentages; exact-message ranking follows):

| Rank | Category                      | Level/source count                     |             Prior | Trend / last occurrence                                                  |
| ---: | ----------------------------- | -------------------------------------- | ----------------: | ------------------------------------------------------------------------ |
|    1 | Snapshot prepare teardown 500 | API/error 145 +VM/error 145 =290       |             60+61 | Higher weekly count; last Oct 8 20:02:14Z before fix rollout; zero later |
|    2 | Storage threshold alerts      | API/error 56 degraded +22 critical =78 |       12 degraded | Higher pre-fix count; last Oct 8 17:42:50Z; nowwarning 87.52%            |
|    3 | Hetzner placement412          | API/error 76                           |                56 | +35.7%, stillOct 11 15:06Z; zero corresponding failed-task messages      |
|    4 | Resource-chunk failed inserts | API/error 20                           |                29 | −31.0%; last Oct 6 05:53Z, no later matching inserts                     |
|    5 | SQLITE_NOMEM                  | API/error 17                           | 1 (+1 prior tail) | Higher pre-fix count; last Oct 8 15:50Z, zero later                      |

[Q4] Exact message/source ordering is snapshot API 145, provider41276, SQLITE_NOMEM17, shared-core4036 and snapshot-sleeping4106 (tied). Dynamic VM500 requestIds each occur once; normalized145 is the useful comparison. Exact storage percentage messages split the78 rows across values and are not a single exact-message bucket.

Daily error rows [Q4d]: Oct 5 partial72, Oct 6 121, Oct 7 132, Oct 8 154, Oct 9 13, Oct 10 13, Oct 11 24, Oct 12 partial1. This shows the decline afterOct 8 without asserting that one fix caused every decrease.

Other signatures [Q4]: Failed query wrappers28 (20 chunk+8 other; prior 43), snapshot 4109 (prior 135), KV 4295 (prior 2), shared-core4036 (prior 6), quarantine3 (prior 3), TaskRunner mismatch2 (prior 3). `Network connection lost`1 is **D1_ERROR**, distinct from prior ProjectData transport storms; generic DO inactive-instance1. No storage-full, snapshot-body-too-large, expired-callback-token, generation-expired snapshot 409, explicit D1 overload or ProjectData CPU-reset signature was found in this grouped result. ACP Prompt failed is **warn 40** (prior 4), not an error-level count.

Three scheduled-sweep error rows persist [Q4,Q6]: capacity_pool_reconciliation1 (Oct 8 08:58Z; failed query cause unverified), diagnostic_incident_reconciliation1 Worker-memory-limit (Oct 9 04:01:48.832Z) and1 D1 internal error (Oct 12 08:35:57.228Z). These are watch items; zero GraphQL runtime errors does not erase caught sweep failures. VM incident persistence5001 (Oct 11 19:35Z) and Origin CA certificate issuance1 (Oct 5 14:33Z) also have insufficient recurrence/cause evidence for new discrete findings.

## 3. Task reliability — sam-prod.tasks

Tasks are grouped by **created_at in the window**, with status read after cutoff. This is a snapshot of a created cohort, not a count of all failures completed this week. Ideas and repaired legacy conversation records share this table; their counts bias raw percentages. [Q3,Q13,Q14]

| Mode         | Completed | Failed | In progress | Sleeping | Cancelled |  Draft | Ready |
| ------------ | --------: | -----: | ----------: | -------: | --------: | -----: | ----: |
| task         |       118 |     11 |           3 |       11 |         2 |     57 |     1 |
| conversation |        14 |     12 |           1 |       37 |         3 |      0 |     0 |
| **Total**    |   **132** | **23** |       **4** |   **48** |     **5** | **57** | **1** |

Raw failed share, matching the prior denominator, **23/(132+23+4)=14.47%** (prior 22.16%). Terminal share **23/(132+23)=14.84%** (prior 28.47%). Adding48 sleeping to the raw denominator gives **11.11%**. These are row shares; they are not a clean estimate of executed-agent success.

**Failed causes [Q3]:**

| Exact cause / category                                | Count | Interpretation                                                                                                                                                                                 |
| ----------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task runtime conclusively gone (workspace_missing)    |     9 | All nine describe legacy taskless-chat materialization and have workspace_id NULL; all terminalizedOct 8 20:45–20:47Z. Historical repair cohort, not proof of nine new runtime deletions [Q14] |
| agent_prompt_failed                                   |     7 | Generic safe category; attribution unresolved. Four of seven are original wave tasks failingOct 11 09:27–09:33Z                                                                                |
| Prompt timed out after 8h                             |     2 | Oct 7 18:11/18:12Z; bounded legacy behavior. Current managed-task deadlines disabled; fresh host rollout not verified                                                                          |
| Reserved submission authority revoked: task is queued |     2 | Mission double-start, proved two session rows each [Q10]                                                                                                                                       |
| Provisioned node disappeared during node_agent_ready  |     1 | Oct 5 14:46Z; not a provider422/412 terminal failure                                                                                                                                           |
| Session recovery authority was revoked                |     1 | Oct 9; known wake handoff issue, existing01M4JMYRY5909JYND1XRXMM9DC shipped#2299 according to its ledger; this scan did not run a wake soak                                                    |
| Absolute runaway-cost ceiling1440min                  |     1 | Explicit configured safety ceiling, not itself proof of malfunction                                                                                                                            |

No provider422, provider412, startup-model-apply failure, human-input expiry, git-token transport failure or prompt-cancel-grace failure appears among these23 rows.

**All-time snapshot [Q3a]:** completed4,508; failed 1,986; cancelled498; draft836; ready75; in_progress4; sleeping52. Raw failure share **1,986/(4,508+1,986+4)=30.56%**, prior 30.72%; terminal **30.58%**. All-time totals include idea lifecycle and historical task records.

**State drift [Q5,Q13]:** all 4 in-progress tasks join running workspaces; **0** join deleted/missing workspaces (prior 71 deleted). All52sleeping tasks join deleted workspaces, which is compatible with saved sleep. All23 failed tasks have completed_at. Three completed Instant runs (`standard-1`, IDs01M4KETY99JKZBCPW44H97JTHY,01M4KG0Q9SJ41KBD1CXDXKTSWR,01M4KHV3YF1HW4Q4VVCS63TNTQ) have NULLstarted_at, attributable to `instant-session.ts:518–527` omitting it. Twelve other completed task-mode rows without timestamps have no workspace/chat and are completed ideas (`operations/idea-core.ts:212,270,350`); fourteen completed conversation rows also lack execution timestamps and a workspace, so they were not treated as live executed runs.

**F1 exact lifecycle contradiction [Q8,Q9]:** task01M4NA86TV8PHK54JGKAYXPBJV /workspace01M4NM5SJXTKJ2VJF08V3R2SEV. Snapshot has available/nondegraded recovery point but sleep_status stopping, sleep_stopping_sinceOct 11 14:56:45.123Z, attempts 3, lastclaimedOct 11 15:26:18.354Z and `sleep_error=Node Agent request failed: 409 {"error":"invalid_transition","message":"Workspace cannot be stopped from current state: stopped"}`. D1 workspace/node still running. Latest in-window diagnosticOct 12 09:00:07.550Z says heartbeat 26 s, no prompt/tool, lastActivityAgeMs 64,715,714, sleepOutcome none; 179 repeated rows, not179 incidents. A post-cutoff09:05 row reported18h3m. **Runtime state itself was not probed**, so actual running-container cost/idle state is not claimed. The verified problem is a stale teardown state and excluded reconciliation path.

## 4. AI Gateway — sam

[Q15] Five pages /250 retained rows: **214 in-window**,36 older rows discarded,0 post-cutoff. In-window timestampsOct 5 10:30:38.472Z–Oct 12 09:00:18.068Z. **214/214HTTP 200**, zero401/403/429/5 xx; all workers-ai. This covers Gateway-recorded SAM calls, not direct Claude/Codex runtime subscription traffic, so it cannot refute the7 opaque task failures.

| Model                         | Calls | Outcomes | Duration P50/P99/max ms | Provider latency P50/P99 (ms) |      Cost |
| ----------------------------- | ----: | -------- | ----------------------: | ----------------------------: | --------: |
| @cf/google/gemma-4-26b-a4b-it |   162 | 162×200  |         913/4,534/8,663 |             797.621/4,483.660 | $0.015255 |
| @cf/zai-org/glm-5.2           |    52 | 52×200   |    11,127/55,883/55,883 |         10,919.766/55,819.795 | $0.843156 |

Nearest-rank sample quantiles. Volume270→214(−20.7%); Gemma P99 4,717→4,534 ms(−3.9%); GLM P99 67,545→55,883 ms(−17.3%). GLM has only 52 samples so P99 equalsmax; it is not a robust high-volume population quantile. No current auth/overload failure was found in this Gateway sample.

## 5. Trends and ProjectData storage

| Signal                          | October 5 report |             October 12 | Interpretation                                                         |
| ------------------------------- | ---------------: | ---------------------: | ---------------------------------------------------------------------- |
| API invocations                 |          806,067 |                669,495 | −16.9%                                                                 |
| Runtime errors                  |                2 |                      0 | No recurrence                                                          |
| Client-disconnect/success       |         0.007730 |               0.003800 | −50.8%                                                                 |
| Success CPU P99 ms              |           70.488 |                121.960 | +73.0%; cause unverified                                               |
| Sampled5xx                      |            2,030 |                    250 | −87.7%; clipped/sampled comparability                                  |
| Platform error rows             |            1,471 |                    530 | −64.0%                                                                 |
| Task terminal failure row share |           28.47% |                 14.84% | Lower, cohort biased by ideas/repairs                                  |
| ACP Prompt failed warnings      |                4 |                     40 | +900%; all opaque                                                      |
| AI Gateway HTTP 200             |          270/270 |                214/214 | 100% in both windows                                                   |
| Root ProjectData bytes          |    9,688,842,240 |          8,751,788,032 | −937,054,208B; warning 87.52%                                          |
| Root archive breaker            |     closed Oct 2 | closed Oct 6 20:24:50Z | Closure timestamp changed; reopening history not independently queried |

[Q7] Root storage history minimum/maximum by UTC date:

| Date       | Minimum bytes | Maximum bytes | Samples |
| ---------- | ------------: | ------------: | ------: |
| 2026-10-05 | 9,541,365,760 | 9,733,488,640 |      16 |
| 2026-10-06 | 9,552,822,272 | 9,664,290,816 |      24 |
| 2026-10-07 | 9,444,429,824 | 9,570,394,112 |      24 |
| 2026-10-08 | 9,281,208,320 | 9,416,060,928 |      18 |
| 2026-10-09 | 9,122,566,144 | 9,122,566,144 |       1 |
| 2026-10-10 | 8,923,267,072 | 8,976,478,208 |       9 |
| 2026-10-11 | 8,807,157,760 | 8,917,176,320 |      25 |
| 2026-10-12 | 8,746,332,160 | 8,807,477,248 |       9 |

Oct 9 has only 1 history sample; the series does not establish continuous hourly measurement that day. Latest sampleOct 12 09:01:12.650Z is warning, last_error NULL, cleanup_health running. Stored growth_rate 0 and estimated_days_to_limit NULL do not support a predictive “days remaining” claim. Global migrations at query time: **1,436 published/101 frozen/0 other states**; root-project-only **874 published/87 frozen/0 other states**. Global published_at in the review window 476. Root counts are separated from global counts; the prior report474published/49 frozen root snapshot was later Oct 5 and includes its own tail. No historical storage repair or R2 audit was performed.

## Prioritized findings

All causes below are code-grounded by local read-only sub-agent exploration and spot checks; uncertain causal attribution is labelled hypothesis. Paths refer to deployed revision e82d14ec1.

| Priority / severity               | Finding                   | Evidence                                                                    | Responsible code / suspected cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Idea                                                                                                                                    |
| --------------------------------- | ------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1 / High preservation/reliability | F1 stale sleep teardown   | 1 task; stopping claim; 3 attempts;409 already-stopped;179 idle rows;17h58m | `apps/api/src/` unless full path above: VM stop excludes already-stopped state (`packages/vm-agent/internal/server/workspaces.go:853–859`). API calls stop before D1 sleep convergence (`services/session-sleep-teardown.ts:189–207`); stale stopping excluded from candidates (`scheduled/session-sleep-candidates.ts:81–86`), repair requires workspace already sleeping (`session-sleep-lifecycle-repair.ts:100–109`), missing-intent scan rejects non-NULL stopping (`session-sleep-intent-reconciliation.ts:64`). Actual runtime state unverified. | [01KZZ9Y0B4957R9KR40TNEE3KP](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZZ9Y0B4957R9KR40TNEE3KP) |
| 2 / Medium                        | F2 mission double-start   | 2 failed tasks;2 session rows each                                          | `apps/api/src/` unless full path above: MCP creates S1 before binding task chat (`routes/mcp/dispatch-tool.ts:601,674,757`); orchestrator selects null chat identity (`durable-objects/project-orchestrator/scheduling.ts:278–284`), creates/binds S2 (`:447,468–482`); original allocation CAS rejects mismatch (`durable-objects/task-runner/workspace-reserved-allocation.ts:149–183`).                                                                                                                                                              | [01M4KKNAZY6KSSCXR610T01E11](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M4KKNAZY6KSSCXR610T01E11) |
| 3 / Medium                        | F3 opaque prompt failures | 7 failed tasks;40 warns vs 4                                                | `apps/api/src/` unless full path above: Intentional safe fallback (`packages/vm-agent/internal/server/server.go:1535–1551`); wrapper classification (`packages/vm-agent/internal/acp/auth_failure.go:14–43`). Quota/auth/overload attribution not verified; add safe categorical provenance rather than raw provider text.                                                                                                                                                                                                                              | [01KWKDYXNB97J4Z5Q9RGS8APPF](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KWKDYXNB97J4Z5Q9RGS8APPF) |
| 4 / Medium                        | F4 KV 429→500             | 5 callbacks:3MCP+2 bootlog                                                  | `apps/api/src/` unless full path above: Repeated task/window KV writes (`routes/mcp/_helpers.ts:358,363,373`, awaited `index.ts:268`); workspace log read/rewrite (`services/boot-log.ts:34–42`, awaited `runtime.ts:1827`). Repeated-key quota is hypothesis.                                                                                                                                                                                                                                                                                          | [01M4QNWEZG8KQQDF2R9VTK8TWM](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M4QNWEZG8KQQDF2R9VTK8TWM) |
| 5 / Low                           | F5 diagnostic dedupe      | 179 same-task/key rows;10 sampled driver lookup failures                    | `apps/api/src/` unless full path above: LIKE-based dedupe lookup fails with pattern-too-complex (`scheduled/stuck-task-live-runtime.ts:230–237`), catch returns false (`:238–244`), insert repeats (`:263–278`). Log explicitly says pattern too complex; 0 truncated contexts.                                                                                                                                                                                                                                                                         | [01M4QP1EX1YVKRVVPTBP2G0RD8](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M4QP1EX1YVKRVVPTBP2G0RD8) |
| 6 / Low                           | F6 Instant timestamps     | 3 completed Instant runs missing started_at                                 | `apps/api/src/` unless full path above: Instant task update omits startedAt (`services/instant-session.ts:518–527`).                                                                                                                                                                                                                                                                                                                                                                                                                                    | [01KZNGJG1DCH8DBC835Y0272P4](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01KZNGJG1DCH8DBC835Y0272P4) |
| 7 / Low / watch                   | F7 snapshot 410 noise     | 9 vs135;last Oct 8;0 later                                                  | `apps/api/src/` unless full path above: VM generic non-2xx error (`packages/vm-agent/internal/server/session_snapshot_control_plane.go:135–136`); background filter ignores HTTP 410 (`packages/vm-agent/internal/server/session_snapshot_coordinator.go:129–153`).                                                                                                                                                                                                                                                                                     | [01M31M9FVCDWTGN3QCNAXWZ0K6](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M31M9FVCDWTGN3QCNAXWZ0K6) |

Acceptance priorities: F1 must reconcile the exact already-stopped generation without touching a successor; F2 must prove one-session dispatch under an orchestrator interleaving; F3 must preserve redaction while producing safe source/category/attempt evidence; F4 must preserve correct limiter behavior and boot-log entries under KV 429; F5 must dedupe repeated sweeps on actual D1; F6 must set start timestamp only on real start.

## Watched but healthy

- **Gateway:**214 fresh calls,214HTTP 200,0 auth/rate/overload failures [Q15].
- **Worker runtime:**669,495API invocations/0 runtime errors; tail 1,537,341/0; website 3,126/0 [Q1,Q1b]. Application500/sweep failures remain separately recorded.
- **Provider fallback evidence:**76 placement412+6 shared-core403,0 matching terminal messages among23 failed tasks.403 here explicitly means shared-core quota, not authentication (`packages/providers/src/hetzner-account-limits.ts:38–47`) [Q3,Q4].
- **Storage drain:**87.52%warning,0 storage-full rows, root 874 published/87 frozen/0 failed or in-flight at query time [Q4,Q7].
- **Resolved signatures:** snapshot body-too-large0, expired callback token0, incident-dedup UNIQUE0, git-token terminal failures0, unsupported-location4220, legacy in_progress/deleted0 [Q3,Q4,Q5].
- **Improvement after October 8:** daily error totals154→13→13→24→1 partial; snapshot prepare 500 and NOMEM 0 after their last October 8 occurrence [Q4,Q4d]. This is recurrence evidence, not a blanket causal claim.

## Ideas touched by this review

Created: F4 `01M4QNWEZG8KQQDF2R9VTK8TWM`, F5 `01M4QP1EX1YVKRVVPTBP2G0RD8`.

Updated with occurrence/recurrence evidence and this report backlink: `01KZZ9Y0B4957R9KR40TNEE3KP`, `01M4KKNAZY6KSSCXR610T01E11`, `01KWKDYXNB97J4Z5Q9RGS8APPF`, `01KZNGJG1DCH8DBC835Y0272P4`, `01M31M9FVCDWTGN3QCNAXWZ0K6`, `01KT90PKF6167SXZ9YZY0R26MM`, `01M0SHQC8V34S2P0JMZR53TEJN`, `01M467A56CDK9B28TCWZZYBF23`, `01M2FKS8MMKTX5F4YD7RYSSYFE`. No idea was dispatched or marked completed by this review. Completed/text-full records were cited without attempting appends. Disconnect idea `01KT90P8M8YZ0CKZPH5WRH16MS` was found cancelled when its update was rejected; no duplicate idea was created for an improving trend. Nine idea appends were read back and verified.

## Evidence appendix — query definitions and scope

Account: `e2eb9a8d5b560cce006fdd03ad6f2e49`. Production D1: `a8923a52-b1d4-4e0d-9bd9-aa5406face5e`. Observability D1: `68b1c534-bba4-44fc-9de5-ff1bed9f70e0`. Window: **1791191063000 ≤ timestamp < 1791795863000**, equivalent to the ISO bounds at the top. Successful D1 reads returned `rows_written=0`. Task status snapshots can change after cutoff; these sources are not a transactional snapshot.

- **Q1:** Cloudflare GraphQL `workersInvocationsAdaptive`, scriptName `sam-api-prod`, exact ISO datetime bounds; dimensions `status`, then separately `date,status`; sums requests/errors/subrequests; CPU/wall P50/P99. Microseconds converted to milliseconds. **Q1b:** same bounds for `sam-tail-worker-prod` and `website`. The outcome aggregate is authoritative for headline totals; independently requested daily/quantile aggregates can differ slightly through adaptive sampling/ingest.
- **Q2:** Workers Observability telemetry query, `dry=true`, calculations count grouped by `$workers.event.response.status`, verified filters scriptName=sam-api-prod and eventType=fetch. Result `abr_level=10`; earliest series Oct 5 14:14:03Z. Weighted aggregate values are sampled estimates; sampleInterval was not multiplied again.
- **Q3:** `SELECT task_mode,status,COUNT(*) n FROM tasks WHERE created_at >= '2026-10-05T09:04:23Z' AND created_at < '2026-10-12T09:04:23Z' GROUP BY task_mode,status`. Failed-row query additionally selects id/error_message/execution_step/started_at/completed_at. **Q3a:** `SELECT status,COUNT(*) FROM tasks GROUP BY status`.
- **Q4:** `SELECT source,level,message,COUNT(*) n,MIN(timestamp) first,MAX(timestamp) last FROM platform_errors WHERE timestamp >= 1791191063000 AND timestamp < 1791795863000 GROUP BY source,level,message ORDER BY n DESC`. Dynamic requestIds normalized locally. **Q4d:** same bounds, grouping by UTC date, level and source. Freshness: independent MAX(timestamp) query.
- **Q5:** Tasks left-joined to workspaces on workspace_id; statuses in_progress/sleeping, grouped by task status/execution step/workspace status. Current result: 4 in-progress/running and 52 sleeping/deleted.
- **Q6:** Same platform window, selecting message/context/stack/timestamp for NOMEM, KV PUT, quarantine, scheduled sweeps, VM incident, Origin CA and resource-chunk signatures. Exact caller paths counted locally. No secret headers or raw provider bodies were copied into this report.
- **Q7:** Root storage telemetry/history/breaker by project_id `01KHRJGANBBWGDY1NZ0KVF0D4J`; history minimum/maximum/count by UTC date and window. Archive migrations grouped by state globally and root-only; published_at count in window globally. Only published/frozen returned. CF deployments GET and GitHub successful production-run/head evidence establish the current deployed revision.
- **Q8:** Platform window `message LIKE '%No sleep is scheduled or in flight%'`, select message/context/timestamp: 185 rows across 6 tasks, 179 for F1 and 6 for others; 0 truncated contexts. Repeated diagnostics are not distinct incidents.
- **Q9:** F1 task joined to workspace/node/snapshot via `session_snapshots.chat_session_id=tasks.chat_session_id`. Snapshot id `01M4NAHD4PSQB3KKGQZD88AGVB`. Snapshot status available is separate from task status in_progress; task status was independently verified because SELECT snapshot.* produced duplicate column names.
- **Q10:** Session summaries for failed task IDs `01M4K7CQPHMM31GS0R263JNNFN`, `01M4K7CYV774BHVRHC847Y5WES`: 4 rows. Task 1 session timestamps Oct 10 15:37:35.055Z/15:37:39.038Z; task 2 15:37:42.325Z/15:37:45.176Z. Existing idea separately documents the original assignment mismatch.
- **Q11:** Same platform window, exact message `ACP Prompt failed`, select context/timestamp: 40 rows, all context.error=agent_prompt_failed. Identical prior-window query returns 4.
- **Q12:** Dry Worker Observability events query, last 24 hours, needle `stuck_task.live_runtime_record_lookup_failed`, limit 10. Example Oct 12 08:40:08.031Z: `D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR`. All 10 retrieved samples show that error/task. This is not a complete log count.
- **Q13:** Q3 cohort grouped by timestamp NULL flags, plus terminal NULL rows joined to workspaces. Twelve completed task-mode records lack workspace/chat and have idea lifecycle titles; three executed completed records have chat/workspace and standard-1; 23/23 failed rows have completed_at.
- **Q14:** The nine workspace_missing failures: 9/9 description=`Conversation task materialized from a legacy taskless chat session.`; 9/9 workspace_id=NULL. Do not attribute them to OOM eviction without further evidence.
- **Q15:** Gateway GET logs with per_page=50, pages 1–5, stopping when the oldest page crossed the start. Filter exact created_at bounds; group model/status; nearest-rank duration/provider-latency quantiles. Thirty-six old rows excluded.

Supporting JSON query results were held in /tmp. This library report preserves numbers, timestamps, signatures and query definitions for the next review. R2 payload contents and live VM/container runtime probes were not obtained.
