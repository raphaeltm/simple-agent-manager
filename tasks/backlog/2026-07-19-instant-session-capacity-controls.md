# Instant-Session Capacity Controls: Per-User Quota + Real Request Cancellation

## Problem

Security review of the 2026-07-19 instant-container clone fix (branch `sam/looks-instant-containers-no-p29hx9`) confirmed two pre-existing capacity gaps on the instant (cf-container) path:

1. **No per-user quota on instant sessions.** `POST /projects/:projectId/sessions/start` → `launchInstantSession` creates a node/container with no `getRuntimeLimits(env).maxNodesPerUser`-style check, unlike `workspaces/crud.ts:236-256` and `nodes.ts`. The `VmAgentContainer` class is capped at `max_instances = 3` platform-wide (`apps/api/wrangler.toml`), and every successful session occupies a slot for up to `sleepAfter` (1h). Any single approved user can occupy the entire instant pool.
2. **Worker-side timeouts do not cancel container work.** `fetchNodeAgent`'s cf-container branch races `fetchVmAgentContainer` against a timer with no `AbortController`; on timeout the in-container clone keeps running until the caller's cleanup destroys the container. The 120s create budget added by the clone fix lengthens this zombie window on failure paths (was 30s).

Neither was introduced by the clone fix — the dominant slot-hold cost was always the 1h post-launch session lifetime — but the review (HIGH finding) asks for explicit capacity work.

## Design Constraints (learned during the incident)

- A naive "count non-terminal cf-container nodes per user" cap would count rows stranded by the stuck-`queued` launch bug (`tasks/backlog/2026-07-19-instant-launch-stuck-queued-on-disconnect.md`) and could lock the user out of instant sessions entirely. The quota needs the stale-row escape path (rule 47) solved first or together.
- `max_instances = 3` itself deserves review — it is the real platform ceiling for concurrent instant sessions and is not env-derived today.

## Acceptance Criteria

- [ ] Per-user concurrency/quota gate on instant-session creation (env-configurable with a `Default*` constant), with behavioral tests covering at-limit rejection, rollover, and the stale/stranded-row case (must NOT permanently block a user after failed launches)
- [ ] Timeout on the cf-container create path propagates cancellation (AbortController through `fetchNodeAgent`'s container branch) or documents why the containers API cannot support it
- [ ] `max_instances` reviewed and either raised or made deploy-configurable with rationale
- [ ] Load review per rule 47 documented in the PR
