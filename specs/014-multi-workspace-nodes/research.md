# Research: Multi-Workspace Nodes

**Feature**: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/spec.md`  
**Plan**: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/plan.md`  
**Created**: February 10, 2026

This document records the key technical decisions needed to implement the Node -> Workspace -> Agent Session hierarchy, along with rationale and alternatives.

## Decision 1: Keep `ws-{workspaceId}` as the Primary Workspace Address

Decision: Continue using `https://ws-{workspaceId}.${BASE_DOMAIN}` as the canonical user entrypoint for a Workspace.

Rationale: The existing Worker already proxies `ws-*` subdomains to VM agents. Preserving this pattern minimizes user-facing change and keeps links stable while we change the underlying hosting model from "1 VM per Workspace" to "1 VM per Node, many Workspaces per Node".

Alternatives considered:
- Use `https://ws-{nodeId}.${BASE_DOMAIN}/{workspaceId}` paths instead: simpler DNS but breaks existing links and requires path routing changes everywhere.
- Introduce a new subdomain prefix for Workspaces: adds churn without clear benefit.

## Decision 2: Control Plane Worker Remains the Workspace Subdomain Proxy

Decision: Keep proxying of `ws-{workspaceId}.*` requests in the Control Plane Worker (see `apps/api/src/index.ts`) and extend it to route Workspaces that live on shared Nodes.

Rationale: Cloudflare Workers can terminate HTTPS and handle WebSocket upgrades consistently, and the project already depends on this for `ws-*` routing. Extending the proxy logic preserves deployment patterns and avoids moving TLS/proxy complexity onto Nodes.

Alternatives considered:
- Point `ws-*` DNS directly at Nodes and terminate TLS on the Node: increases operational burden and certificate management complexity.
- Use Cloudflare Tunnel per Node: adds extra moving parts and new failure modes.

## Decision 3: Node Agent Uses Trusted Request Context to Select Workspace

Decision: The Node Agent will not be configured with a single `WORKSPACE_ID`. Instead, it will determine the target Workspace per request from trusted routing context set by the Control Plane Worker (`X-SAM-Node-Id`, `X-SAM-Workspace-Id`) and enforce that any presented user token is for that same Workspace.

Rationale: A Node hosts multiple Workspaces. Binding the agent to one workspace ID prevents routing and prevents safe token validation for multiple Workspaces.

Alternatives considered:
- Run one agent process per Workspace on the same Node: complicates deployment, port management, and upgrades.
- Maintain a dynamic allow-list of workspace IDs in the agent config file: requires a config distribution mechanism and restart semantics.

Notes:
- Direct access to Node backends is acceptable for this feature as long as all user-facing and management endpoints still enforce authentication and Workspace claim validation.
- Client-provided routing headers are not trusted as routing authority.

## Decision 4: Workspace Stop/Restart Preserves Files, Terminates Sessions

Decision: Stopping a Workspace preserves its files/configuration on the Node but terminates all running processes and Agent Sessions; restarting resumes the same Workspace environment with new sessions.

Rationale: Matches expected semantics for stop vs delete and reduces accidental data loss while still giving isolation.

Alternatives considered:
- Stop deletes Workspace (ephemeral only): fast cleanup but violates the clarified semantics and surprises users.

## Decision 5: Port/Network Isolation via Single Ingress + Per-Workspace Routing

Decision: Ensure Workspaces can run the same internal ports concurrently by avoiding host-level port publishing conflicts. The Node Agent (single ingress per Node) provides per-Workspace access and routes requests to the correct Workspace context without requiring users to manually reconfigure ports.

Rationale: The main motivating use case is running multiple isolated instances of a project that would otherwise collide on default ports. Isolation must be automatic to be usable.

Alternatives considered:
- User-managed port offsets: pushes complexity onto users and breaks the "quick iteration" goal.
- Allocate unique host ports per Workspace and teach the Worker proxy to dial different ports: adds coordination state and increases configuration surface.

## Decision 6: Single-User Nodes (No Sharing)

Decision: Nodes are owned by exactly one user; no team/shared Nodes in this feature.

Rationale: Keeps authorization and isolation scope bounded while introducing the new hierarchy.

Alternatives considered:
- Shared Nodes via invites or org membership: significantly increases permissions complexity and threat surface.

## Decision 7: Limits Must Be Configurable

Decision: Any new limits introduced by this feature (for example max Workspaces per Node, max Agent Sessions per Workspace) will be configurable via environment variables with sensible defaults.

Rationale: Constitution Principle XI (No Hardcoded Values).

Alternatives considered:
- Hardcoding "reasonable" defaults with no overrides: rejected by constitution.

## Decision 8: No Automatic Idle Shutdown in This Feature

Decision: Automatic idle shutdown is out of scope. Lifecycle changes are explicit (user stop/restart/delete and system error handling only).

Rationale: Keeps the first multi-workspace Node implementation simpler and avoids coupled Node/Workspace idle semantics while the hierarchy model is introduced.

Alternatives considered:
- Keep legacy idle behavior: rejected due to ambiguity and additional risk during hierarchy refactor.

## Decision 9: Node Agent Must Provide Node + Workspace Event APIs

Decision: Node Agent exposes event/log endpoints scoped to Node and Workspace so the Control Plane can surface progress and failure diagnostics in the UI.

Rationale: Multi-workspace Nodes increase operational complexity; users need clear observability to understand provisioning/runtime state.

Alternatives considered:
- Keep logs only in VM local files: insufficient for user-facing troubleshooting.

## Decision 10: Node Health Uses Explicit Agent Check-Ins

Decision: Node Agent periodically reports health/check-in status to the Control Plane via callback endpoints. The Control Plane updates `lastHeartbeatAt` and derives health state transitions using a configurable threshold (`NODE_HEARTBEAT_STALE_SECONDS`).

Rationale: Unhealthy-node handling must be based on an explicit signal path instead of inference from user traffic alone.

Alternatives considered:
- Infer health from failed user requests only: too late and too noisy for operational UX.

## Decision 11: Agent Session Attach Uses Single Interactive Attachment + Explicit Takeover

Decision: A running Agent Session allows one active interactive attachment by default. Additional attach attempts receive conflict unless the client explicitly requests takeover. Session creation supports idempotency keys to prevent duplicate sessions on retried create actions.

Rationale: Deterministic behavior under reconnect/multi-tab usage avoids race conditions and confusing split-control behavior for users.

Alternatives considered:
- Allow unrestricted concurrent interactive attachments: simpler server logic but introduces ambiguous input arbitration and poor UX.

## Decision 12: Workspace Name Uniqueness Is Enforced in Application and Database

Decision: Workspace display-name uniqueness remains Node-scoped with auto-suffix behavior, and is backed by a DB unique index on a normalized name field (for example (`nodeId`, `normalizedDisplayName`)).

Rationale: App-level suffixing alone is insufficient under concurrent create/rename races; DB-level constraints are required for correctness.

Alternatives considered:
- App-only uniqueness checks: rejected due to race-condition duplicates under concurrent requests.
