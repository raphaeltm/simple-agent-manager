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
- [ ] Sync relevant public docs; lint, typecheck, tests, build.
- [ ] Local specialist and task completion reviews; resolve findings.
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
- [ ] Update moved static source consumers and allocation inventory; rerun affected tests.

Post-mutation restored Worker suite11/11 passed. Full root test attempt2: web419/420 files passed, single inbox test timed out waiting for count; isolated6/6 passed. Also Vitest teardown import error in retired-trial; latest full test attempt running without concurrent build. API suite was canceled by sibling web failure, so it needs the final full run.
