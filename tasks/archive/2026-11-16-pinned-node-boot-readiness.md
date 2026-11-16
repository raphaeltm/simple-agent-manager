# D3: Wait for a pinned node to finish booting

## Problem and evidence

Idea `01M7EPADE2F97EHG504BD33F9H`, including its self-host update, records pinned tasks failing permanently before workspace creation while the agent is booting. Staging: node created 03:58:43Z, task submitted 04:00:34Z, /ready at 04:01:30Z, later required version matches. Self-host: null version at 18:03:05, matching heartbeat 18:03:15, missing /ready at 18:03:37, /ready 18:04:46.

## Research and preflight

Classification: business-logic-change. No external API, schema, credential or VM-agent changes.

`TaskRunner.start` persists node_selection, alarm calls `handleNodeSelection` (apps/api/src/durable-objects/task-runner). Preferred selection rejects non-running status, then calls `isNodeAgentVersionCompatible`; with configured required version null/undefined/empty do not match, so it throws permanent incompatible build. After matching version, `verifyNodeAgentHealthy` requires /ready and heartbeat; absence also throws permanently. These are two boot races on the same startup path.

Condition: a reported agent build differs. Proxy: stored version does not equal required. Divergence: agent has not reported yet. Keep shared compatibility strict (used by placement, cleanup, dispatch and incidents); defer only explicit pinned startup. Re-read node and all admission gates after waiting, and never claim, replace or delete the pinned node while waiting.

Existing timer: TASK_RUNNER_AGENT_READY_TIMEOUT_MS, default 900000 ms, and TASK_RUNNER_AGENT_POLL_INTERVAL_MS, default 5000 ms. Persist agentReadyStartedAt; readiness wait survives alarms. Maximum default wait 15 min plus alarm scheduling latency; 180 polls at 5 s, deadline scheduling capped to remaining wait; no external I/O in waiting branch. One node row per task per poll; normal alarm authority/phase bookkeeping unchanged. Startup reports reasons in structured waiting logs and terminal errors. Real admission/reservation remains authoritative.

Rules: 39 (debug first), 62 (real trigger), 67 (shared predicate unchanged), 74 (proxy mismatch), 81 (wait throughput). Principles X/XI/XIII: small fix, existing configurable bound, fail closed on reported mismatch and deadline. Tests must enter TaskRunner.start/alarm and use D1/DO storage, not just invoke a helper. Public architecture docs will describe pinned boot waiting; no new API contract.

## Checklist and acceptance

- [x] Read idea and updates; confirm null and missing-ready failure paths.
- [x] Guard pinned boot with existing configurable readiness deadline; preserve admission and ownership checks.
- [x] Distinguish reported mismatch, missing-version deadline and missing-ready deadline messages.
- [x] Real startup tests: null version -> wait -> matching heartbeat but no /ready -> wait -> /ready -> workspace_creation.
- [x] Controls: reported mismatch refused, never-ready timeout terminal, missing/deleted node still refused.
- [x] Remove new wait guard temporarily and prove divergence test red; restore and pass.
- [x] Sync relevant public docs; lint, typecheck, tests, build.
- [x] Local specialist and task completion reviews; resolve findings.
- [ ] Both staging lease status checks, queue/reserve/deploy, real node and immediately pinned task, confirm running after readiness, delete workspace/node, release.
- [ ] Ready PR, full CI, best-effort CodeRabbit, merge authorized, production deploy and smoke; complete idea with PR/commit and report feature.selfhost-landing.

## Validation evidence

- Existing selection unit suite: 43/43 passed.
- Real startup Worker suite: 11/11 passed (one file collected), including authenticated SELF /heartbeat + /ready and actual workspace allocation. Added late-ready and mismatch-during-wait controls after Cloudflare review.
- Mutation: removed only the new readiness wait block; running-null-version divergence failed (`completed: true` instead of false), while both initial differing-build controls still passed (1 failed, 2 passed, 8 skipped). Restored guard; final green rerun underway.
- Baseline lint: 22 tasks passed; typecheck: 36 tasks passed. Full build: 18 tasks passed. Full root tests rerunning after an overlapping Astro build caused a shared-dist ERR_MODULE_NOT_FOUND; no code defect found in that collision.
- Cloudflare review P2: delayed alarm after late readiness could bypass deadline. Fixed by enforcing persisted deadline even when readiness is now present; reviewer rechecked and approved. Constitution PASS; docs PASS, LOW clarification applied to existing configuration docs.
- Staging remains pending, not waived. Both lease statuses checked. Reserve run 43918326968 succeeded but intentionally wrote no reservation because the primary holder predates queue. Wake accepted at18:26:35Z to recheck/reserve after holder expiry. No test resources or deployments started yet.

## Expanded producer trace

`POST /api/projects/:id/tasks/submit` -> `submitTaskImplementation` rejected preferred status creating before runner; an immediate new-node pin could not reach the readiness wait. New route regression proves this: only creating case red (26 others pass). Accept owned creating/running at submission; stopped/deleted/foreign/missing remain refused before task effects. Rule18 required splitting preexisting783-line module: shared validation/runtime resolution remains submit-task-implementation.ts, VM stage moves unchanged to submit-vm-task.ts (separate refactor commit8e80ced19). Both under500 lines. Source-scan consumers and allocation inventory updated to moved location; real route+runner regressions remain behavioral.

- [x] Confirm outer submit status gate with pre-fix HTTP400 regression.
- [x] Split oversized source module preserving behavior before changing status condition.
- [x] Accept creating/running on real submission producer; retain foreign/deleted/stopped controls.
- [x] Update moved static source consumers and allocation inventory; rerun affected tests.
      All354 affected tests verified; route27/27, Worker11/11, restored proof green. Final constitution, doc-sync, expanded Cloudflare and completion implementation reviews PASS.

Post-mutation restored Worker suite11/11 passed. Full root test attempt2: web419/420 files passed, single inbox test timed out waiting for count; isolated6/6 passed. Also Vitest teardown import error in retired-trial; latest full test attempt running without concurrent build. API suite was canceled by sibling web failure, so it needs the final full run.

## Final local review and quality delta

All specialist reviews pass: test-engineer, Cloudflare (deadline finding addressed), constitution/doc-sync, completion validator. Sonar actual issues (despite green quality gate) found a nested ternary and complexity35 in the newly extracted VM function. Replaced ternary with equivalent if/elseif and extracted unchanged quota/session/idea-link effects into focused helpers, preserving effect order and failure handling. Cloudflare verified normalized executable blocks unchanged; 203 affected tests across5 files pass, including route27; lint on adjusted source-contract tests passes. Helper149lines / parent408lines, no suppression.

Serial full root test:38/39 tasks pass, web420/420 files pass, API1053 passed/1failed/3skipped files (15945 passed/1failed/4skipped cases). Sole API failure was stale placement-authority fixture missing the new ready field/timer, now seeded ready and timer null; targeted fixture suite passes. Full root suite rerun ongoing on final code. Format ratchet passed with baseline2101/2180 unformatted files; changed files formatted. Final lint/typecheck/build underway after Sonar cleanup.

Staging queue18:00: primary productionhotfix holder until18:29:01, L5b first, D3second projected18:39:01. Secondary helduntil18:46+queue. Accepted rescheduled wake version4 due18:39:02Z (prior timeout reconciled and retried successfully). No deploy or VM/workspace created; real-node pin script prepared and browser/auth recovery verified read-only.

Final post-Sonar lint22/typecheck36/build18 tasks passed; focused Worker startup suite11/11 passed in72s. Allocation inventory and format ratchet pass. Full serial root suite approaching completion; archive after green.

## Final local gate result

Final full root serial run `pnpm exec turbo run test --concurrency=1` passed39/39 tasks. API1054 passed/3 skipped files;15947 passed/4 skipped cases (15951 collected). Web420/420 files passed in the serial root run. Lint22, typecheck36, build18 tasks passed. Focused Worker11/11, route27/27, affected203, existing selection43 and authority43 pass. No unresolved local reviewer or implementation findings.

Archived at completed implementation/local-validation phase per /do. Release gates remain pending and merge-blocking: ready CI, CodeRabbit request/wait, leased staging real-node immediate pin + cleanup, merge, production deploy/smoke, idea completion and channel report. Archive does not claim these pending operations passed.

## CodeRabbit deadline correction

CodeRabbit review5925400274 found one valid Major (discussion4589889927): a /ready received within the readiness window was rejected if the alarm ran after the deadline. Added a twelfth real startup/allocation test: authenticated heartbeat/ready, controlled server timestamp90s ago and deadline60s ago, current fresh heartbeat, delayed alarm. It failed before the guard correction (1 failed/11 skipped), then all12 startup cases passed; the existing actually-late-ready refusal remains green. Related selection/placement authority tests86/86, API lint/typecheck pass.

The deadline now accepts an expired alarm only if readiness is currently complete and the server-stamped agent_ready_at is finite and within the original deadline. Reported version mismatch remains refused before this check; current ownership/status/placement/capacity/health checks remain authoritative. /ready records the timestamp and reported version; VM version enforcement belongs to the runner. No timeout/configuration added. Cloudflare, constitution/doc-sync and completion delta reviews PASS. Final full root suite rerunning after this change; CI, incremental review and live leased staging/cleanup still required before merge.

Final post-correction full root serial suite passed39/39 tasks (API15947 passed/4 skipped; web420files). Rootlint22/typecheck36 passed; Worker12 and unit86 pass. Incremental trusted CodeRabbit request43932056749 succeeded, then18:49:46 replydeclined for review quota; wait ends per rule25, no retrigger. Original finding replied/resolved. Sonar's only additional issue preferred Number.NaN to NaN; equivalent constant spelling applied and targeted lint passes. Final root build18/18 passed; current-head CI and staging/release evidence tracked in PR.
