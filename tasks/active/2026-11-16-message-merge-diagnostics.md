# Explain production message-merging write rates

The first 30 minutes of production ON coverage showed 27.38 writes/call versus24.65 OFF. Current row_usage telemetry cannot distinguish merger precondition failures from a low assistant-text share. A stale project WebSocket can disable merging for all sessions.

Authorized by parent task01M7CVZNSP0EHV9BJ72HCFQJSC eventc25c632b-edbd-4c95-8d3d-8b59bad3c098 as a counter-only followup to PR2760.

Research: ProjectData.index persistMessageBatch combines admin setting with relevant socket capabilities; MessageStreamBatch evaluates source/sequence/receipt/open-row boundaries; messages.persistMessageBatch applies transaction writes; RowUsage aggregates in memory and flushes existing log windows. ACP thinking/tool rows are excluded from assistant merging. Existing reporter fixture has no thinking.

- [x] Add bounded content-free counters to existing row_usage windows: received/accepted/inserted by fixed role, eligible accepted chunks, coalesced chunks, append SQL statements, refused batches and run breaks by fixed enums.
- [x] Sample legacy session/project socket counts as window maxima. Preserve all storage, wire and configuration behavior, add no SQL writes or schema.
- [x] Record committed synchronous persistence outcomes even if later side effects fail; no outcomes from rollback.
- [x] Real-workerd tests drive persistence, retries, refusal gates, legacy sockets, role mix, same-batch and cross-batch merges, flush/reset and no extra SQL writes; negative-control discrimination.
- [ ] Relevant build/lint/typecheck/tests and required quality checks; local domain/completion review, CodeRabbit best effort.
- [ ] Coordinate per-installation staging lease, deploy, real Claude thinking/tool-heavy ON/OFF comparison and legacy socket gate; record counts/hash only and clean all owned resources/auth/settings.
- [ ] PR green, merge, first successful production deploy containing commit; read-only counters report and H1/H2 conclusion if supported.

Acceptance: fixed-cardinality logs explain effective gates and physical outcomes without content/IDs or new storage writes. ON/OFF transcript/storage behavior stays identical to approved PR2760. Representative live run reports role mix, eligibility, append/insert counts and writes/call. Explain stale-client mitigation and thinking/tool followups without changing them in this PR.


## Continuation handoff — 2026-11-16 01:02 UTC

Owner task `01M7E19YHSJ73896Q84ASSGFDN`, parent `01M7CVZNSP0EHV9BJ72HCFQJSC`, project `01KHRJGANBBWGDY1NZ0KVF0D4J`. PR2773 is the counter-only followup; original storage PR2760 already merged as `7bea824b926009e5fbec5a1aed456a8f8663124c` and first successful whole production deploy43744172794 completed18:17:48UTC Nov15. Do not redo its closed staging work. This task is NOT complete. Use `/do`, call SAM get_instructions first, read current task/output branch, report session credential_limits scope=session. Work in primary checkout on `sam/store-streamed-agent-replies-ssgfdn`, no outside worktrees. Never inspect/stage the unrelated credential-bearing `.codex/config.toml` modification. No production mutations/auth/provisioning. No message content, tokens or raw logs in reports.

Parent's verified peer event `9bf8e991-26c0-423e-89ab-4aa8c4354451` requests this handoff, then only PR2773 CI/staging/merge and the01:40 production read on this credential. Do NOT start the separately authorized socket-scope PR on this credential. Stop routine coordinator status messages; send only results, blockers and handoff pointers. Codex allowance was94% at00:57 (parent observed95% at00:58), reset2026-11-18T07:01:07Z. A Claude task may take over.

### Counter PR gates and implementation

Production implementation `df8bef973`; test-only duplication cleanup `d9dbfc6e35d211d80726f757e0c11f4ea9ceb49a`. A subsequent handoff-only commit may be current: ALWAYS query PR current full SHA/checks. Fixed diagnostic schema in `packages/project-data/src/do/message-ingest-metrics.ts`; index samples effective configuration/socket gates, messages/stream ingest count transaction outcomes, persistence hook publishes AFTER transactionSync returns BEFORE awaited side effects, RowUsage aggregates in memory and resets with EXISTING log window. No schema, SQL, settings, timer, extra log-line or wire behavior changes. README defines semantics. New workerd file `apps/api/tests/workers/project-data-message-ingest-metrics.test.ts`.

Counters: received/accepted/inserted fixed roles(user/assistant/thinking/tool/plan/system/other), eligible accepted assistant with null stored metadata even if disabled, coalesced logical chunks, successful append UPDATE statements, duplicates, mergeReadyBatches, primary refusal(setting_disabled/legacy_client/missing_incarnation/invalid_sequence/retired_source/receipt_cap), bounded run breaks(including size_cap/out_of_order), relevant legacy project/session socket window maxima. Same-batch coalesces need not produce UPDATE. Rollback contributes no counters; postcommit broadcast failure retains committed counts. Never turn identities/content/arbitrary metadata into labels.

Phase1 research,2 checkout,3 implementation COMPLETE. Phase4 full `pnpm lint && pnpm typecheck && pnpm test && pnpm build` PASS; API15542tests passed/4skipped,1031files passed/3skipped. Base real-workerd43PASS, focused metrics13PASS; after d9 test-only dedup13PASS again(session46643). Billed reporter fixture unchanged6615OFF/1596ON, no additional SQLwrites. Negative control nooped publication only in first positive test: intended assertion RED(exit1), exact original restored. AST/file-size/DOmigration/runtime-boundaries/observability-noise PASS; latter live telemetry404skipped. Gitleaks pinned8.30.1 checksumverified, committed-content snapshot43reviewed/0new PASS; snapshot deleted. Local qualityscript failures were root-owned temp/generated dependency traversal/loadedCPU; quiet timeout rerun65PASS; current d9 CI Code Quality Checks SUCCESS reconciles clean environment. Do not weaken gates or alter protected runtime files.

Phase5 COMPLETE: local counter_review Cloudflare/test findings(initial-row size/order reasons and commit-then-broadcastfailure test) ADDRESSED/rereviewPASS; doc-sync/constitutionPASS; completion implementation readinessPASS, overall live/release still pending. Incremental d9 test-only review PASS, no scenarios/assertions weakened. No pending reviewers. Mandatory completion validation again before eventual archive.

Phase6 PENDING, merge-blocking: new counter PR has NO live staging evidence, NO owned resources/auth/settings/lease. Phase7 PR2773 OPEN/ready, full CI pending. At00:59 d9: no failures; Code Quality, lint, build/typecheck, other packages, Secret Scan, PR Evidence, mock/worker smoke SUCCESS; API3shards/DO7shards/CLI pending. Sonar result not yet available on d9. Old641 Sonar10.4% duplicationFAILED entirely in test setup; d9 parameterized equivalent socket cases/shared error-transport helper, no production change. ALL checks including Sonar and aggregate Durable Object Workers must pass current fullhead.

CodeRabbit BEST-EFFORT COMPLETE: label00:39:48; trusted request run43781697388SUCCESS/comment6904142750 at00:40:43; bot rate-limit6904144077 at00:40:48; no submitted reviews/findings. Updated auto summary6904125671 at00:53:40 says auto reviews disabled/skipped. No manual retrigger for handoff/test cleanup; later actual review remains binding. PR evidence contains receipt links.

### Durable waits and exact reconciliation

Session `c2dad030-146f-4876-956a-88e2d35b98b9`. Current CI subscription527e128f-2ab3-49fd-9bc7-9da12dc7cde3 tracks d9 ONLY, expires04:54:28UTC/minwake10m; cancel/replace if handoff commit advances head. PR review subscription559eb28b-5fad-450a-999d-cebc8af0c15b active until04:40. Accepted CI fallback742cdc5a-3319-4d8d-bde4-f1e294c22b20 due01:15/expires01:45. Its prompt says reconcile actual current head, so remains usable after documentation commit. Inspect state:any on resume; read/ACK event IDs. Query GitHub immediately before/after subscription. Save new SHA/subscription in PR/task/localstate. After fallback if still pending report exact check URLs/delivery status; no blind renewal. Old641subscriptionc636 and01:00fallbackd2da CANCELLED. Staging queue checkpoint3950a0fc-dd9a-4c4e-b86a-24b790e92cb3 due01:31:14.143/expires02:01:14.143. Production01:40 schedule below independent.

### Staging queue, plan and cleanup

Explicit parent order: L5a → reads-fix PR2765/task01M7GB4125DFTECRYYCAHXAWTS → security PR2755/task01M7FPX2RR5JSJ1CYG6QPXY9VG → us. Coordination channel `feature.selfhost-spike`; follow subscriptione5bd33d4-f979-4820-9a31-cca864ab92c0 active until08:40, watermark215 when created. Check latest channel cleanup/release receipts and both environment leases before action. Last audit00:33: staging2 held by L5a task01M7FCZD2APNNX1T08Z6ZJGMC7 branchsam/task-l5-landing-slice-zjgmc7 deployment7812255949 expiry01:31:14.143; primary held by01M7C1SRMAWR3PYFWKF03XJ273 branchsam/implement-phase-3-run-3xj273 deployment7812411212 expiry02:38:46.609. Expiry does NOT override queued peers. Primary reportedly has unmerged PR2721 DOv23 migration mismatch; not independently verified, don't fallback there without confirming. No chat polling/lease negotiation.

Read `.agent-instructions/reference/rules/13-staging-verification-full.md`. Acquire/deploy only via `gh workflow run deploy-staging.yml --ref sam/store-streamed-agent-replies-ssgfdn -f environment=staging2 -f sam_task_id=01M7E19YHSJ73896Q84ASSGFDN -f lease_hold_minutes=<bounded>`. No Cloudflare Worker settings PATCH. Staging settings via admin API/UI or deploy-staging. Workload identity audience `https://api.sammy2.party/api/auth/workload-identity-login`, targets staging2-agent-admin/user, cookie `.sammy2.party`. Bootstrap provides effective platform compute and Claude Code proxy key; no personal credential needed. Use Artifacts-backed project(no GitHubApp), Claude Code `providerMode:sam` (installation default has no agent key), explicitly thinking-enabled session. Effective Hetzner/pool exists, cap2nodes. Missing local Claude key is NOT blocker. Keep routine verification bounded, estimate incremental bill before unusually costly/repeated tests.

Live plan: create one owned project/session/workspace using normal app/API; record all owned IDs without content. Run a real thinking-enabled Claude tool-heavy turn with long streamed assistant text ON and OFF (save original staging settings and restore). Watch incremental reply in browser, reload/hash exact content, capture bounded existing row_usage windows with new messageIngest fields. Compare raw-role counts/accepted eligibility/coalesces/actual UPDATE/physical inserts/writes percall, normalize traffic; thinking/tools intentionally remain unmerged. Reproduce legacy-projectsocket admission with actual `/sessions/ws` lacking message-append-v1 while settingON, then run turn: legacyProjectSocketsMax>0 and refused.legacy_client>0; close socket and rerun capable session, confirm mergeReady/coalesces/appends if eligible. Current counter PR must preserve existing global legacy gate; do not implement next fix here. Sessionlegacy gate also real-workerd covered. Never claim noappend from lack of existing success logs. Use hashes/counts/sizes only. If eligible density or equivalence fails, report rather than approximating. No web code changed in counterPR; future UIchanges require375/1280visualaudit.

Clean every owned workspace/node/project/auth/settings promptly, verify provider resource absence using current strict cleanup workflow, then release only own lease through same deployment workflow `-f lease_action=release`; confirm newest leasepayloadreleased. Preserve unrelated resources/leases. No staging helper/kit has yet been built for this counter PR. Original PR2760 staging kit/auth authority is CLOSED and must NOT be replayed. Build fresh bounded helper from current API reference if needed.

### Production read at01:40 UTC — read-only only

Human Raphaël enabled `chat.messageMergingEnabled` at `2026-11-15T23:07:03.647Z` (D1true, auditsetrevision5). Leave ON. No human reload timestamp supplied; don't invent one. Accepted pending schedule `8bd6717a-c446-41e6-8368-8e4a0f28fe51` due01:40/expires02:10. Helper Library `01M7GR3V4QB8FK4ZWXPBJRFCWH`(5741bytes), restore via download_library_file targetPath RELATIVE DIRECTORY `.tmp`. Local `.tmp/chunk-production-on-observe.mjs`. Invoke exec_with_secrets literal command argv `["node","/workspaces/simple-agent-manager/.tmp/chunk-production-on-observe.mjs","2026-11-15T23:07:03.647Z"]`, cwdabsolute, secretNames EXACTLY `["CF_PRODUCTION_DEBUGGING_TOKEN","CF_PRODUCTION_ACCOUNT_ID"]`, timeout180000; poll terminal. Outputs counts-only `.tmp/chunk-production-on-observation.json`, upload unique filename. Helper reads D1setting/audit, fleet, Worker versions, existing logusage and3knownfailureevents. It does NOT parse new counters; counterPR not deployed yet. If upgrading helper later, never paste rawlogs or content.

Require >=2h ACTUAL union covered fully postactivation windows, exclude straddlers/gaps; requested duration is not coverage. rowsWritten ALREADY INCLUDES alarmWrites. OFFbaseline:3145calls/77524writes(including2747alarms),2.0018577778coveredhours,24.6499205087writes/call,38726.027823writes/coveredhour. Library `01M7GJWF4PY69V8HAPQZV0YGK2`. Historical26.4writes/call. IntermediateON00:07: 2windows23:23:08.802–23:53:09.098,0.500082222h,978calls/26775writes(including765alarms)/17544644rowsRead;27.3773006writes/call(+11.0645%vsOFF),53541.1954/hour. NO savings demonstrated; uncontrolled traffic, cannot attribute. Perwindow droppedLabels37/40 though persistlabelpresent. All3bounded knownfailurequeries0hits, not universalabsence. Fleet2nodes/13workspacesall7bea onlycapabilityinventory; Worker96be100%. ArtifactLibrary `01M7GTXHZN74YC89TCVPS8KYES`, idea note01M7GTY167VT1N7HRCPM07VTGN. Finalcounts post note to idea `01M7CX61WVX72T7CFQNRTX0DVM` and send parent results. Ifcoverageinsufficient report exact gap, no timerloop. Existing sessions_read returns grouped rows; cannot prove rawrole density. Future deployed counters are needed for H1(refusal)vsH2(loweligibletraffic).

### Release and next PR findings

Before merge recheck all CI/review/staging gates and current-main production deploy waiting on CI; do not supersede its queued deployment blindly. Merge2773 only after staging. Receipt = FIRSTsuccessful whole DeployProduction whose head contains countercommit. Trusted-main-tip mismatch is supersession: reconcile latestmainCI/deploy, dispatch currenttipdeploy if needed only after exactCIgreen. Basic productionhealth/version smokeonly; no fullauthenticatedtests. Then read new counters honestly whenavailable. Overall task stays active until requiredresults/handoff.

Next socket-scope PR is authorized by parent evente6e46d8f but MUST be separate AFTER2773merge, and MUST NOT start on near-exhaustedcredential. Audit findings: repo productconsumers `/sessions/ws` are useProjectWebSocket(unscoped) and useChatWebSocket(session-scoped); pre2760/current projecthook only consumes lifecycle/attention/comments/access and ignores transcripts. APIroute `apps/api/src/routes/chat.ts:105` forwards rawrequest via project-data client about3338. Actual `packages/project-data/src/do/index.ts:4043` broadcastEvent currently sends session transcriptframes to taggedsession AND allunscopedproject sockets. Public `apps/www/src/content/docs/docs/reference/api.md:19` and routecomment promise that, so change docs with narrowed contract; no claim externalclientsaudited. Removeproject/unscoped sockets from transcriptcapabilitygate AND filter their message.new/messages.batch/message.append sends. Retain relevantlegacysessiongate. Critical race: a legacysessionsocket may connect AFTER per-batchgate during awaitedsideeffects, so ALSO filter message.append per-socketcapability AT SEND. Realpath tests: projectlegacy no longerdisablesmerge; sessionscopelegacy onlydisablesownsession; legacychat NEVER gets unsupportedappend, includingcontrolledlateconnectrace. Don't merely callprivatehandlerdirectly. Ifweb/acp-clientchanges runmandatory375/1280visualaudit. Thinking future needs openrowrole/checksamekind; toolupdates requirepresence-awaresametoolCallIdmetadata semantics, neverJSONconcat. Recommendations only until realdensity supports them.


### Sonar complexity followup — 2026-11-16 01:11UTC

After the handoff, Sonar reported Quality Gate PASS with0.0% duplication, but also CRITICAL typescript:S3776 on stage cognitivecomplexity26>15. Extracted only the newly added diagnostic reason chains into recordContinuationBreak and recordOpeningBreak, preserving eligibility, calltiming, precedence and all merge/SQL conditions. Incremental specialist review PASS. ESLint/Prettier/project-data build PASS; direct real-workerd four affected suites48/48PASS(75.22s), including13counter cases and existingmerge/upgrade/rowusagecoverage. Two earlier wrapper runs were deliberately terminated143 without results and are not claimed as PASS. Current code changes require fresh exacthead CI/Sonar before merge. No new scope/behavior or stagingresources.


### Final Sonar refactor followup — 2026-11-16 01:19UTC

The first helper extraction reduced stage complexity to17 but did not clear S3776, and its boolean diagnostic parameter triggered S2301. Extracted existing append accumulation into stageContentAppend(id,content,offset), and opening diagnostics now derive their predicate from the message before latestPosition mutates. Specialist review PASS: insert/update choice, content, offsets, revisions and reason precedence preserved. ESLint/project-data build PASS; final four-suite real-workerd rerun48/48PASS. Fresh exacthead CI/Sonar must still pass before merge.


## FINAL TRANSFER — 2026-11-16 01:49UTC (supersedes earlier ownership and waits)

Coordinator decision event e720a35f-6d5b-4978-958b-bd33fb91404e transfers remaining PR2773 staging, merge, production deploy and first counter read to Claude task 01M7GY0BKP1WESE5Y82PZNN42S (PR2774), which holds staging2. This Codex task MUST NOT take a lease, deploy or merge, and starts no new work. It remains reachable for questions. Counter source candidate 2a86d7f55a9f5d587d73b5ad2297f82ebbaa2852 has ALL CI PASS/SKIP, including aggregate Test/Workers and Sonar zero issues. The final transfer commit changes only the task document; deploy the tested exact source head if requested by coordinator, then reconcile CI on the current documentation head before merge. PR2774 must verify independently; do not silently treat its modified socket behavior as counter-only proof.

Production observation remains 1.750881667 actual covered hours, 4054 calls /112301 writes INCLUDING3190 alarms, 27.7013 writes/call versus24.6499 OFF. No demonstrated saving. Coordinator event517a43ef requested cancellation of top-up; 01:50 schedule0f3302f3 CANCELLEDv2. No >=2h completion claimed. No production changes. Next useful observation is after counters AND gate fix are deployed.

Exact staging counter read, without raw log disclosure:

1. Helper Library01M7H0F82Y6T0XASP58Z1T46ZZ, filename message-ingest-staging-counts.mjs,4530bytes. Restore with download_library_file(fileId=01M7H0F82Y6T0XASP58Z1T46ZZ,targetPath=".tmp") — targetPath is a relative DIRECTORY. The helper is syntax-checked only; live execution belongs to the lease holder. It queries sam2-api-staging2 in the staging Cloudflare account, fixed numeric fields only. It never prints message content, source/session/message IDs or arbitrary metadata.
2. Record isolated test project ID and phase start/end UTC timestamps in the holder's local state. Use separate OFF/ON/legacy phases, one owned session per phase or non-overlapping complete log windows. A project usage window includes every session in that project; it is not a per-session counter. Let the initial window settle before measuring.
3. Under exec_with_secrets use EXACT staging secretNames ["CF_TOKEN","CF_ACCOUNT_ID"], cwd "/workspaces/simple-agent-manager", timeoutMs180000 and literal argv:

       ["node","/workspaces/simple-agent-manager/.tmp/message-ingest-staging-counts.mjs","<OWNED_PROJECT_ID>","<PHASE_FROM_ISO>","<PHASE_TO_ISO>"]

   Replace angle placeholders with actual IDs/timestamps, not shell expansions. Poll exec_with_secrets_status until terminal. The helper writes .tmp/message-ingest-staging-counts.json and prints only numeric counter JSON. Upload a distinct phase-named copy. No production secrets for staging. Do not use wrangler tail or publish raw telemetry.
4. Flush interval is runtime admin setting operations.projectDataRowUsageIntervalMs, default15min, min60000. In leased staging only, save original value and temporarily select60000 through the admin settings API/UI if bounded live testing needs it. GET https://api.sammy2.party/api/admin/settings returns {revision,settings,history}; PATCH same URL with authenticated admin browser credentials and JSON {expectedRevision:<fresh revision>,changes:[{name:"operations.projectDataRowUsageIntervalMs",value:60000}]}. The same PATCH shape changes chat.messageMergingEnabled between false/true. Fetch a fresh revision each mutation; restore original values afterward through API/UI. NO Cloudflare Worker settings PATCH.
5. RowUsage emits at an operation boundary after interval elapsed, not on a timer. Existing DOs refresh interval after a flush, so do not assume setting change instantly affects a previously active object. Prefer a fresh test project after setting changes and trigger an ordinary session-list read after each interval to cause flush. Exclude a boundary-straddling window. Missing logs or missing messageIngest is a coverage gap, never zero merges. The helper excludes straddlers and reports union coveredMs. AlarmWrites is a subset of rowsWritten, never add it twice.

Expected emitted event and numeric schema:

    event: "project_data.row_usage"
    projectId: owned test project ID (existing top-level attribution)
    windowStart, windowEnd: epoch milliseconds
    labels: {rank0:{label:"persistMessageBatch",calls,rowsRead,rowsWritten,alarmWrites}, ...}
    droppedLabelCount, totalLabelCount: integers
    messageIngest: {
      batches: integer,
      received: {user,assistant,thinking,tool,plan,system,other},
      accepted: {user,assistant,thinking,tool,plan,system,other},
      inserted: {user,assistant,thinking,tool,plan,system,other},
      eligible: integer,
      coalesced: integer,
      appendStatements: integer,
      duplicates: integer,
      mergeReadyBatches: integer,
      refused: {setting_disabled?,legacy_client?,missing_incarnation?,invalid_sequence?,retired_source?,receipt_cap?},
      breaks: {no_open?,source?,turn?,intervening_writer?,materialized?,role?,metadata?,origin?,sequence_gap?,timestamp?,out_of_order?,size_cap?},
      legacyProjectSocketsMax: integer,
      legacySessionSocketsMax: integer
    }

Every role key exists; sparse refused/break keys absent means0. Unknown roles count as other. Received includes retries; accepted excludes duplicates; inserted is physical canonical inserts. Eligible counts accepted assistant/null-metadata chunks even OFF. Coalesced is logical chunk merges, including within a batch; appendStatements counts actual UPDATE statements only, so these differ. Refused is one primary reason per batch (setting_disabled takes precedence over legacy_client). Socket counts are MAXIMA sampled per batch, not window sums. Counters publish only after synchronous persistence commits; rollback contributes none; postcommit broadcast failure retains counts. Instance eviction loses unflushed diagnostics. Existing label cap can drop persist label even while messageIngest exists; require persistLabelPresent=true for writes/call comparisons.

Live expected checks on exact counter source candidate:

- OFF: accepted assistant eligibility still visible; refused.setting_disabled >0; coalesced=0 and appendStatements=0.
- ON with merge-capable reporter/incarnation, sequential assistant chunks and no legacy relevant socket: mergeReadyBatches>0, coalesced>0; cross-batch continuation normally yields appendStatements>0. inserted.assistant below accepted.assistant establishes fewer physical assistant rows. Other run boundaries/metadata may legitimately prevent a particular chunk from merging; inspect reason counts instead of assuming.
- Thinking/tool-heavy real Claude turn: received/accepted/inserted role mix makes density visible. Thinking/tool rows remain unmerged in this PR. Typed cards and transcript content must remain intact; watch incremental app reply, reload and compare content hash. Never paste text into evidence.
- ON with actual unscoped legacy socket: legacyProjectSocketsMax>=1, refused.legacy_client>0, coalesced=0 for affected batches on COUNTER-ONLY source. After closing socket, subsequent clean phases should merge eligible assistant runs. Mixed normal traffic in the same window makes simple zero assertions invalid; isolate phases.
- A legacy session socket only affects that session; unrelated session socket not counted as relevant. PR2774 changes unscoped semantics, so its expected result differs: unscoped must not block merging or receive transcript frames. Do not mix these two expected behaviors.

Exact legacy/capable browser WebSocket reproduction (authenticated staging2 Playwright page/context, cookie .sammy2.party):

    await page.evaluate(async ({projectId,sessionId,scoped,capable}) => {
      const u = new URL("wss://api.sammy2.party/api/projects/" + projectId + "/sessions/ws");
      if (scoped) u.searchParams.set("sessionId",sessionId);
      if (capable) u.searchParams.set("messageAppend","message-append-v1");
      const ws = new WebSocket(u.href);
      window.__mergeProbe = ws;
      window.__mergeProbeTypes = {};
      ws.onmessage = event => {
        try {
          const type = JSON.parse(event.data).type;
          if (typeof type === "string") window.__mergeProbeTypes[type] = (window.__mergeProbeTypes[type] || 0) + 1;
        } catch {}
      };
      await new Promise((resolve,reject) => {
        ws.onopen=resolve;
        ws.onerror=() => reject(new Error("Probe websocket failed"));
      });
      return {readyState:ws.readyState};
    }, {projectId:"<OWNED_PROJECT_ID>",sessionId:"<OWNED_SESSION_ID>",scoped:false,capable:false});

Use scoped:false,capable:false for the old project client; scoped:true,capable:false for an old session client; scoped:true,capable:true for a compatible session reader. Query parameter absence is what makes it legacy: do NOT send messageAppend on the legacy probe. Normal browser cookies authenticate the upgrade; never put tokens in the URL. Keep the socket open DURING real agent ingestion. Record only readyState and event-type counts, never frames/content. Close and delete probe state in finally:

    await page.evaluate(() => {
      window.__mergeProbe?.close(1000);
      delete window.__mergeProbe;
      delete window.__mergeProbeTypes;
    });

The real workerd regression file apps/api/tests/workers/project-data-message-ingest-metrics.test.ts drives the same actual socket admission via stub.fetch Upgrade. It is a reference for expected counter outcomes, not a substitute for leased staging proof.

Cleanup and release remain holder-owned: restore staging settings, close probes/browser auth, delete EVERY owned workspace/node/project, verify provider absence, then release lease through deploy-staging and confirm released payload. No old PR2760 auth/helper authority may be reused. This Codex task has no resources/auth/settings/lease to clean.

Library01M7GXXV4YN93Z9J13S3TARGFA is replaced with the complete original handoff plus this addendum. PR body and task document carry the same transfer instructions. The counter helper is separately durable in Library01M7H0F82Y6T0XASP58Z1T46ZZ. Coordinator/Claude task owns all remaining release actions; previous Codex queue timer will be cancelled so it cannot accidentally resume deployment.
