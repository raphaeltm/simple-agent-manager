# Unhealthy node: root cause, truthful liveness verdicts, bounded drain-and-kill

**Created**: 2026-09-25
**SAM task**: `01M3CJS7YSFH5FWSKM2JKXEEN5` (coordinator `01M3CHX9QYJ6GHWQEXY532FYSA`)
**Branch**: `sam/16-vcpu-node-sat-kxeen5`
**Classes**: cross-component-change, business-logic-change, infra-change (vm-agent), security-sensitive-change (callback auth semantics), docs-sync-change

## Problem

Node `01M3B4SA1J2KT4TDF2NK982K3R` (Hetzner cx53, 16 vCPU / 32 GB, hel1) showed unhealthy for about
seven hours on 2026-09-25. Its agents kept working, three of its tasks were failed with false
verdicts, nothing drained or reaped it, and its 16 cores sat against the Hetzner shared-core quota
until new dispatches failed with `403 shared core limit exceeded`. Raphaël's reported symptom: the
machine showed unhealthy for 5-6 hours, tasks were no longer running on it, new agents were not
being scheduled on it, and it was never killed.

## Evidence (production, read-only, 2026-09-25)

Sources: Workers Observability (head sampling 1.0, so absence is evidence), `sam-prod` D1,
`sam-observability-prod` D1. Query helpers were kept in `.tmp/incident/` (not committed).

| Time (UTC)        | Event                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 02:02:23          | Node created. Hosted 14 workspaces across 4+ projects over its life.                                                                                                                                                                                                                                                    |
| 08:02:45-08:09:26 | Parent session's sleep snapshot: capture sent `prepare` + one `progress`, then nothing for 6.5 min; the control plane degraded it after its 120 s no-progress window (08:04:47) and the VM's late uploads got 410 (workspace already sleeping). The uploads did not fail; they arrived after the control plane gave up. |
| 08:22:12          | Cleanup begins for workspace `01M3BD6BAK...`, the last active workspace of project `01KK26ZX...` on this node. The VM still has its runtime in memory until 08:28.                                                                                                                                                      |
| **08:22:33**      | `POST /api/projects/01KK26ZX.../node-acp-heartbeat` returns **410** (the same node's heartbeats for the other two projects got 204 in the same second).                                                                                                                                                                 |
| 08:22:31-35       | Last message POSTs (all 200 in ~300 ms), last node heartbeat, last node-level ACP heartbeat, last VM error report. None ever resumed.                                                                                                                                                                                   |
| 08:22-15:05       | Activity callbacks (`runtimeWorkState: active`, tool progress every ~1 min), 241 `/git-token` callbacks (all 200, same transport, workspace tokens), control-plane-to-VM requests (200/202) and agent MCP calls all kept working.                                                                                       |
| 08:31-15:01       | The control plane's `/health` probe to the VM timed out every time (see open question).                                                                                                                                                                                                                                 |
| 09:36:27          | Reconciliation **cancelled T1's in-flight prompt** at the 2 h prompt ceiling while T1's tool progress was 6 s old.                                                                                                                                                                                                      |
| 09:37:09          | Check-in sent to T1. 09:37:32 T1 answered through MCP `request_human_input` (exactly what the check-in asks for). 09:38:10 T1 failed "Agent became unresponsive after SAM check-in".                                                                                                                                    |
| 12:02, 15:03      | Placement correctly refused the node ("node telemetry is stale"); a new cx53 was attempted and hit the core quota.                                                                                                                                                                                                      |
| 15:06:06          | A human pressed Stop on T3 (its check-in had been deferred 5.5 h by active-work evidence). 15:06:15 T3 failed "Agent became unresponsive after SAM check-in".                                                                                                                                                           |
| 15:06:19          | A human deleted the node from the UI (`DELETE /api/nodes/:id`, 200 in 12.7 s, `destroying_terminal reason=explicit_terminal_proof`). No sweep ever acted.                                                                                                                                                               |
| 15:06:39          | T2 failed "Task runtime is no longer live after 240 minutes. Last liveness result: workspace_deleted" (a consequence of the human's node delete).                                                                                                                                                                       |

Ruled out with evidence: control-plane rejection of writes (message POSTs were 200 until the VM stopped
sending), root ProjectData overload (same), network/DNS/TLS/token expiry (git-token kept working on
the same transport), disk (heartbeat disk % was normal and git kept committing).

## Root cause

### 1. Node side: a per-project 410 tripped a node-wide, permanent callback latch

- API `authorizeNodeScopedHeartbeat` (`apps/api/src/routes/projects/node-acp-heartbeat.ts`) answers
  **410** when a live node has no active workspace left in the heartbeated project, naming an
  arbitrary workspace (`.limit(1)` without ORDER BY). That is a transient, project-scoped condition.
- vm-agent `sendAcpHeartbeatForProject` treats any 401/403/404/410 as `markControlPlaneCallbacksTerminal`
  (`packages/vm-agent/internal/server/callback_terminal.go`): an atomic latch that is never reset and
  that (a) exits the node heartbeat loop, (b) exits the ACP heartbeat loop, (c) marks the error reporter
  terminal and wipes its spool, and (d) marks every workspace's message reporter terminal and clears
  its outbox. Session activity callbacks and inbound HTTP are not gated, which is exactly the observed
  split. The same latch is tripped by a per-task `postTaskCallback` 401/403/404/410
  (`internal/server/server.go`).
- The latch shipped 2026-08-26 (`3e74a0851`, "stop zombie callback storms") to stop _deleted nodes_
  from calling back forever; its tests covered node-kind terminal responses only. On a multi-tenant
  node, "one project/task/workspace ended" became "this node is dead".
- The VM logged a Warn when it latched, but that Warn could never ship: the error reporter is latched
  in the same instant.

### 2. Control plane: no reaper looks at node health

- `health_status` is derived on read (`routes/nodes/response.ts:deriveHealthStatus`), written only when
  someone lists nodes. No sweep reads heartbeat age; every reaper is gated on "no active workspace",
  so a node whose tasks stay `in_progress` is immortal. Tasks stayed `in_progress` because a timed-out
  `/health` probe is (correctly) inconclusive, keeping them up to the 24 h absolute ceiling.
- No durable record of node health transitions exists; the NodeLifecycle DO and the VM event store die
  with the node.

### 3. Verdicts: liveness keyed on a proxy that was itself down (rule 74)

- The check-in idle clock is "last persisted chat message" only (`reconciliation-candidates.ts`).
- `resolvePromptAction` cancels any prompt at or past the 2 h prompt ceiling using prompt age alone,
  ignoring the runtime-work progress the check-in expiry already treats as authoritative
  (`attention-expiry.ts:activeCheckinEvidence`). That is how SAM itself cancelled working agents.
- A check-in answered through `request_human_input` is not a response: the `needs_input` marker only
  blocks _new_ check-ins.
- A user Stop ends the active-work evidence that was deferring a pending check-in, so the stale marker
  fires "unresponsive" on what is a normal lifecycle termination (policies a974b04f, 486d1dd1).
- Tasks stranded by a user deleting their node are failed ~20 s later by the stuck-task sweep with a
  message that blames the task's runtime rather than naming the deletion.

## Decisions (policy 1b930820)

- Fix the root cause at both ends: the node-wide latch is reserved for the node's own identity
  callbacks (ready, heartbeat), expressed as a type so a per-resource caller cannot compile into it;
  the API stops answering a live node's project-scoped "nothing to refresh" with a terminal 410
  (protects already-deployed agents, rule 54).
- Drain-and-kill lives in the node-cleanup cron as its own isolated phase and composes existing
  primitives: `queueWorkspaceSessionSleep` (the sleep lifecycle keeps its idleness safety gate, so a
  mid-turn session is not force-snapshotted), `persistMessage` for chat notices, and
  `destroyNodeForCleanup` (claim CAS with provenance/class gates, strict provider deletion, soft
  delete). Signal = the node's own heartbeat age; condition = SAM has lost the node. Divergence case
  (heartbeat dead while agents work) is exactly this incident; after fix 1 it has no known cause, and
  the drain preserves idle sessions before release either way.
- A fleet guard refuses to drain when more than a configurable fraction of running nodes are silent at
  once (that pattern may be a control-plane heartbeat-intake failure, not N dead nodes). It records
  a bounded escalation event rather than treating elapsed time as proof that busy nodes died.
- Node health transitions go to a new append-only D1 table `node_health_events` (no FK, survives node
  deletion), deduplicated per heartbeat-loss episode by a unique key; the drain also writes the
  persisted `health_status` so placement's SQL filter stops lagging.
- Verdict fixes stay out of files PR #2145 rewrites where possible; the one shared predicate extracted
  from `attention-expiry.ts` is a small, documented rebase for #2145.
- Out of scope, filed as SAM ideas: dead `https://do/activity` POSTs in MCP task tools (files over the
  size ceiling), VM workspace callback tokens never refreshed (24 h TTL), vm-agent JWKS refresh context
  cancelled at construction, message reporter head-of-line blocking on unclassified errors, and the
  `/health` probe anomaly if staging does not explain it.

## Implementation checklist

### A. Root cause (vm-agent + API)

- [x] vm-agent: reserve the node-wide latch for node identity callbacks via a typed operation; ACP
      heartbeat (per project) and task callback (per task) terminal statuses no longer latch the node
- [x] vm-agent: tests through the real loops/senders (httptest): a 410 for one project leaves the node
      heartbeat, other projects' ACP heartbeats and message reporters running; task callback 404/410
      does not latch; control: node heartbeat 410 still latches. Update tests that pinned the old
      node-wide behaviour
- [x] API: live node + project with no active workspace on it -> 204 without refreshing sessions (no
      410, no arbitrary-workspace signal); 403 tenant binding and node-kind 410 unchanged
- [x] API: route tests for the new branch plus controls (active workspace refresh, deleted node 410)

### B. Node health record (observability)

- [x] D1 migration `node_health_events` (append-only, no FK, unique episode key) + Drizzle schema
- [x] `services/node-health.ts`: record (idempotent per episode) + list-by-node read
- [x] Move `deriveHealthStatus` into a service so the UI route and the drain share one authority

### C. Bounded drain-and-kill

- [x] Pure heartbeat-age decision (healthy / waiting / drain / release) with env-configurable
      `DEFAULT_*` thresholds and a fleet guard
- [x] Phase `unhealthy_nodes` in node-cleanup (own module, isolated like every phase): record
      transitions, write `health_status`, request sleep for each active session, post one chat notice
      per session per episode, release via `destroyNodeForCleanup` when nothing is left to preserve or
      the bound elapses, record held/released decisions with one-condition reasons
- [x] Stranded-task terminalization service shared by the drain (failed, names the lost node and
      timings) and the owner's node DELETE (cancelled, names the owner deletion); sessions that slept are
      left resumable
- [x] Owner `DELETE /api/nodes/:id` records `deleted_by_owner` and terminalizes stranded tasks truthfully
- [x] Env vars in `env.ts`, `.env.example`, sync-wrangler-config optional list, deploy workflow mapping,
      env-reference skill

### D. Truthful check-in verdicts

- [x] Shared runtime-work progress ceiling predicate; `resolvePromptAction` observes (does not cancel) a
      prompt past its ceiling while runtime work is still progressing; the check-in expiry uses the same
      predicate
- [x] `request_human_input` answers a pending SAM check-in (resolved inside ProjectData)
- [x] User Stop resolves a pending SAM check-in (a human took over; policy a974b04f)

### E. Docs and rules

- [x] Public docs: node lifecycle / health behaviour and new env vars (cite code paths)
- [x] Scoped rule 34 (both copies): terminal status scope; per-resource callbacks never stop node-wide
      delivery

## Acceptance criteria

- [ ] A per-project or per-task terminal callback status never silences node heartbeats, other projects,
      error reports or message persistence (Go tests through the real senders, proven discriminating)
- [ ] A live node's project with no active workspace gets 204 from the node-level ACP heartbeat
- [ ] A node silent past the drain threshold gets its active sessions asked to sleep and one notice each,
      and is released (strict provider deletion) within the configured bound; transitions are recorded
      in `node_health_events` and survive node deletion
- [ ] Controls: a healthy node is untouched; a node that recovers inside the window is not released and
      records recovery; a node whose sessions all sleep is released without waiting for the deadline;
      a fleet-wide heartbeat loss is held, not drained; user-owned, deployment and cf-container nodes are
      never candidates
- [ ] A prompt past the 2 h ceiling with fresh runtime-work progress is observed, not cancelled; a
      stalled one is still cancelled (control)
- [ ] `request_human_input` after a check-in resolves it; the user Stop resolves it; a genuinely silent
      agent still fails the check-in (control)
- [ ] Tasks stranded by the drain fail with a reason naming the lost node; tasks stranded by the owner's
      delete are cancelled with a reason naming the deletion; parent-stop semantics unchanged
- [ ] Staging: a real cx23 node whose vm-agent is stopped over SSH is drained and released within the
      bound, visible in the UI and in D1; everything created is cleaned up

## Validation in progress

- `go test ./internal/server` passes for the preserved vm-agent root-cause fix.
- API typecheck passes; 89 focused reconciliation, attention, and unhealthy-node unit tests pass.
- The existing node-cleanup Workers suite passes (22/22); a new test through
  `runNodeCleanupSweep` verifies notice → sleep request → release and durable event retention.
- SQLite-backed tests now also cover early release after the session sleeps, fleet-wide intake loss
  with a busy node past the escalation window, a hung preservation RPC, and release when append-only
  health-event writes fail. A real SQLite claim verified that the
  existing warm-placement guard requires its first threshold bind; an apparent extra-bind review
  finding was ruled out by a failing surgical removal.
- Root typecheck, lint, and format checks pass. A full API rerun follows updates to source-contract
  tests after splitting oversized modules. Specialist security, Cloudflare, and completion reviews
  were completed; their actionable findings are addressed on branch head `3525cfc10`.
- Surgical revert: omitting the exact-heartbeat cleanup claim made
  `refuses deletion when a heartbeat arrives after selection` fail because it deleted the
  recovered node. Restored the guard and the test passed.
- Surgical revert: ignoring runtime-work progress made
  `keeps a long prompt running while its runtime work is making progress` fail with
  `cancel_prompt` instead of `observe_prompt`. Restored the guard and the test passed.
- Surgical revert: removing the UI health-refresh heartbeat comparison made
  `does not overwrite a heartbeat that arrived after the node was read` fail; restoring the
  comparison passed. The same SQLite-backed test also verifies the missing-heartbeat event.
- Surgical revert: removing the fleet-loss hold made the beyond-escalation busy-node test fail;
  removing the sleep RPC deadline left the hung-request test blocked until the external five-second
  test timeout. Both guards were restored and the focused suites passed.
- A timed-out sleep request now aborts its pending service operation. The queue checks cancellation
  after snapshot setup and checks the expected node before and after that setup, so a deferred
  completion after release cannot schedule sleep on a replacement node. The deferred-completion
  test turns red when those post-setup abort checks are removed; the sweep test also rejects a late
  promise after release without an unhandled rejection. Late chat notices use a stable message ID
  and target the original chat session, not a workspace mutation.
- The snapshot placeholder's actual D1 INSERT/UPSERT now fences old workspace/node ownership and
  refuses to repoint a snapshot already held by a replacement workspace. The final sleep-intent
  UPDATE has a separate atomic ownership guard. Real SQLite tests compare the stored snapshot after
  simulated recovery and node detachment, and verify both guarded success and guarded refusal.
  Removing the conflict owner predicate repointed the recovered row; removing the final UPDATE's
  workspace EXISTS predicate scheduled sleep on a moved workspace. Both surgical reversions failed
  their tests, then were restored.
- Split the oversized `session-sleep.ts` into queue, eligibility, execution, and cleanup modules;
  its public export path stays stable. All resulting source modules are below the 500-line ceiling.
- SonarCloud flagged cognitive complexity in the moved sleep executor and new unhealthy-node sweep.
  The sleep executor now separates workspace loading, pre-teardown safety checks, teardown, and
  final cleanup; the unhealthy sweep separates one-node decisions from provider release. The
  flagged `NaN` style issue was corrected. The follow-up Sonar pass identified two helper
  signatures over the parameter limit and one teardown helper two complexity points over; these
  are now split into smaller operations. Focused regressions, typecheck, lint, and the full API
  suite (757 files / 10,330 tests) pass at `12bb5c02b`; a final Sonar rerun remains.
- Staging deploy run `36188818700` succeeded, including smoke tests, pinned to earlier reviewed
  head `4529b8ba3`. Migration `0172_node_health_events` applied: staging D1 has the empty
  `node_health_events` table. No VM
  was provisioned. The coordinator explicitly ruled out a healthy-only smoke and transient API
  rejection as substitutes for dead-host proof. The disposable host has no supported SSH key or
  provider poweroff credential available here; the workspace Docker daemon is nested. No
  node-specific fault has been run, so the real-trigger drain/delete acceptance test is missing.
  D1 confirmed zero active nodes after deploy. Three nonterminal historical workspaces (created
  Sep 4/13) predate this test, have no live node, and were left untouched. The reporter workstream
  and coordinator received explicit staging release; this task owns no staging resource.
- Draft PR #2147 remains open and **must not merge** until an actual host-fault method is
  available, the latest head is deployed and validated with a live cx23, and final CI passes.

## Open question

The control plane's `/health` probe (`probeNodeHealthForTaskLiveness`, raw fetch to
`https://<node>.vm.<domain>:8443/health`) timed out for 6.5 h while authenticated requests to the same
host and port succeeded and the handler (`internal/server/routes.go:handleHealth`) takes no locks.
Probe it directly against a staging VM; file an idea with the finding if it is not explained here.

## References

- `.claude/rules/74-proxy-signals-must-match-the-condition.md`, `.claude/rules/39-debug-before-redesign.md`
- `apps/api/.claude/rules/53-...`, `47-...`, `51-server-side-node-class-gates.md`, `57-...`, `58-...`, `67-...`
- `packages/vm-agent/.claude/rules/34-vm-agent-callback-auth.md`, `54-vm-agent-rollout-compatibility.md`
- Prior incidents: `tasks/backlog/2026-08-26-stop-zombie-callback-storms.md` (the latch),
  `tasks/archive/2026-08-27-checkin-watchdog-busy-agents.md` (check-in ceilings),
  `tasks/archive/2026-08-06-fix-node-reaping-orphan-reconciliation.md` (reaper isolation)
- Composability: PR #2145 (`sam/preserve-failed-tasks-work-fn8ba7`) rebases onto this change
