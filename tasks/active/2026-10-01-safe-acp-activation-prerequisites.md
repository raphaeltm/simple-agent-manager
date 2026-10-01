# Safe ACP activation prerequisites

## Problem

ACP permissions and conversation forms are merged but dormant. The prior activation PR would enable permission creation from a checked-in default while an old VM agent could still serve sessions. A final snapshot with `home-skipped` could pass the old sleep verification and tear down its live workspace. Direct agent-session creation on an existing workspace also bypassed required-version placement.

## Research

- Approved v2 idea `01M3P2E0JJNQRXX020P65ZRKEJ` requires additive rollout, safe disable, creator-only answers, Cloudflare authority, and old-runtime fencing.
- PRs #2202 and #2206 merged with independent flags false. Draft #2204 has a binding CodeRabbit changes-requested finding about premature checked-in enable.
- `session-sleep-execution.ts`, `vm-agent-container.ts`, and `session-sleep-lifecycle-repair.ts` can release compute from a degraded snapshot. The shared artifact verifier is their appropriate safety boundary.
- `routes/workspaces/agent-sessions.ts` creates directly on an existing node; normal placement checks do not cover it.
- Read-only production D1 at 2026-10-01 ~05:33Z showed the old node and remaining workspace marked deleted; its latest snapshot is still degraded/home-skipped, with no home key and failed sleep at nine attempts. Parent was alerted. This prerequisite prevents future loss; it does not recover that missing home.
- Absolute node-lifetime cleanup bypassed the session sleep gate by deleting managed nodes with stale but active workspace rows. The prerequisite now queues bounded sleep retries at that ceiling and records an owner-visible failure plus durable node-health event after the configured retry window. A missing or degraded snapshot never authorizes automatic deletion; `claimNodeForCleanup` keeps its no-active-workspace CAS. This can hold a managed VM past its nominal ceiling until a verified migration or explicit owner operation. The alternative would discard uncaptured work and is not a safe automatic fallback.

## Checklist

- [x] Require complete final generation, exact workspace/agent/node/runtime identity, and durable home before VM sleep teardown.
- [x] Fence stopping CAS by the verified generation and complete status; recheck reclaimed legacy stopping claims.
- [x] Apply the shared strict artifact gate to Instant sleep and stale sleep repair.
- [x] Refuse direct new agent sessions on incompatible old VM nodes before credential minting.
- [x] Fence absolute-lifetime node cleanup against active workspaces; bound retry/escalation and test the old-node shape.
- [ ] Complete focused and full repository validation; review with relevant specialists.
- [ ] Coordinate staging slot with parent, then verify real VM heartbeat and applicable VM/Instant paths.
- [ ] Create reviewed draft prerequisite PR and reconcile activation PR #2204 with merged forms and CodeRabbit finding.

## Acceptance

An unsafe final capture cannot stop VM or Instant compute or be repaired into sleeping state. Complete captures retain normal sleep behavior. Direct session creation rejects an incompatible VM without creating a row or token. The activation candidate keeps production false until the parent explicitly opts in after reviewing production evidence, with independent permissions and conversation-form controls.
