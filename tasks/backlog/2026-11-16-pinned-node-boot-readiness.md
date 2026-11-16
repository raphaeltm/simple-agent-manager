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
- [ ] Guard pinned boot with existing configurable readiness deadline; preserve admission and ownership checks.
- [ ] Distinguish reported mismatch, missing-version deadline and missing-ready deadline messages.
- [ ] Real startup tests: null version -> wait -> matching heartbeat but no /ready -> wait -> /ready -> workspace_creation.
- [ ] Controls: reported mismatch refused, never-ready timeout terminal, missing/deleted node still refused.
- [ ] Remove new wait guard temporarily and prove divergence test red; restore and pass.
- [ ] Sync relevant public docs; lint, typecheck, tests, build.
- [ ] Local specialist and task completion reviews; resolve findings.
- [ ] Both staging lease status checks, queue/reserve/deploy, real node and immediately pinned task, confirm running after readiness, delete workspace/node, release.
- [ ] Ready PR, full CI, best-effort CodeRabbit, merge authorized, production deploy and smoke; complete idea with PR/commit and report feature.selfhost-landing.
