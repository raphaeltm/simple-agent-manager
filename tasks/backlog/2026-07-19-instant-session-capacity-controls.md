# Instant-Session Capacity Controls: Per-User Quota + Real Request Cancellation

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - `max_instances` is deploy-configurable: `VM_AGENT_CONTAINER_MAX_INSTANCES` (default 3) in
>     `scripts/deploy/sync-wrangler-config.ts:54,163`, wired at
>     `.github/workflows/deploy-reusable.yml:838`, tested at
>     `scripts/quality/sync-wrangler-config.test.ts:710` (PR #1697, 4f7f4dd1a).
>   - The "or document why" branch of the cancellation item:
>     `apps/api/src/services/node-agent.ts:317-328` explains why an `AbortSignal` cannot cross
>     the DO RPC boundary (regression proven by PR #1544).
> - **Still open:**
>   - Per-user Instant quota. `acceptInstantSession` (`instant-session.ts:246-370`) has no
>     per-user gate, and the capacity-pool node trigger (migration 0167) skips Instant nodes
>     because their `capacity_pool_id` is null. The stale-row escape this needed now exists
>     (the `instant_persistence` sweep in `apps/api/src/scheduled/stuck-tasks.ts`).
>   - Rule-47 load review in the PR.
> - **Moot/dropped:** real cancellation of the container request moves to
>   `2026-07-21-instant-container-request-timeout-cancellation.md`, which has the workable design
>   (timeout inside `proxyHttp`).

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

## Update 2026-07-20 (PR #1643 review)

PR #1643 exposed `runtime: "cf-container"` on the MCP `dispatch_task` tool, so
instant sessions are now agent-automatable (including recursive dispatch up to
`dispatchMaxDepth`), not just browser-initiated via chat-start. The generic
per-task/per-project dispatch limits apply to instant dispatches (shared atomic
INSERT), but the missing per-user/cross-project instant capacity gate described
above is now more reachable. Raised by the security review of PR #1643 —
prioritize accordingly.
