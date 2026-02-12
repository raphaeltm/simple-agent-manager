# Implementation Plan: Multi-Workspace Nodes

**Branch**: `[014-multi-workspace-nodes]` | **Date**: February 10, 2026 | **Spec**: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/spec.md`  
**Input**: Feature specification from `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/spec.md`

**Note**: This plan is created by `/speckit.plan` and produces the Phase 0/1 artifacts listed below.

## Summary

Introduce a first-class Node resource (one VM per Node) that can host multiple isolated Workspaces (devcontainers), and make Agent Sessions a first-class, user-manageable concept within each Workspace.

Control Plane responsibilities:
- Provision and lifecycle-manage Nodes (VMs) and persist Node/Workspace/Agent Session metadata.
- Enforce ownership and authorization for Nodes, Workspaces, and Agent Sessions (single-user Nodes).
- Proxy `ws-{workspaceId}.*` traffic to the correct Node and Workspace context.
- Set trusted routing context (`nodeId` + `workspaceId`) for Node Agent requests.
- Track Node health freshness from Node Agent check-ins and surface unhealthy states.

Node Agent responsibilities (one per Node):
- Manage Workspace lifecycle inside the Node (create/stop/restart/delete).
- Manage Agent Sessions inside a Workspace (create/list/attach/stop).
- Ensure Workspaces can run the same port configurations concurrently without conflicts.
- Expose Node-level and Workspace-level event/log endpoints for observability in the Control Plane.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js >= 20) and Go 1.22 (Node Agent)  
**Primary Dependencies**: Cloudflare Workers (Hono), React 18 + Vite (UI), Drizzle ORM (D1), BetterAuth, Cloudflare KV/R2; Go `net/http` + WebSockets  
**Storage**: Cloudflare D1 (SQLite) for app state; Cloudflare KV for bootstrap tokens and boot logs; Cloudflare R2 for Node Agent binaries  
**Testing**: Vitest + Miniflare (API), Vitest + React Testing Library (Web), Go unit tests (Node Agent), optional Playwright smoke/E2E  
**Target Platform**: Cloudflare Worker API, Cloudflare Pages UI, Linux VMs (Docker + devcontainers + Node Agent)  
**Project Type**: Web application monorepo (`apps/web` + `apps/api`) plus Go Node Agent (`packages/vm-agent`)  
**Performance Goals**: Maintain spec success criteria; support users creating 2+ Workspaces per Node with predictable readiness and attach flows  
**Constraints**: No hardcoded URLs/timeouts/limits; preserve `app.${BASE_DOMAIN}` / `api.${BASE_DOMAIN}` / `ws-{workspaceId}.${BASE_DOMAIN}` URL rules; Workspaces must avoid port collisions; stopping a Workspace preserves files/config and terminates its sessions; automatic idle shutdown is out of scope for this feature  
**Scale/Scope**: Single-user Nodes; support multiple concurrent Workspaces on one Node; all per-Node/per-Workspace limits must be configurable via environment with sensible defaults

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Status: PASS (no violations required by this plan).

Gates:
- Principle XI (No Hardcoded Values): any new limits/timeouts (max Workspaces per Node, max Agent Sessions per Workspace, proxy timeouts) must be configured via env vars with defaults.
- URL construction rules: user-facing redirects and UI links must use `app.${BASE_DOMAIN}`; API calls use `api.${BASE_DOMAIN}`; Workspace access uses `ws-{workspaceId}.${BASE_DOMAIN}`.
- Infrastructure Stability: new/changed critical paths (Node provisioning, Workspace lifecycle, ws-* proxy routing, Node Agent auth) require tests and cannot regress coverage targets.
- Documentation Excellence: API contract changes and new user journeys must be documented (specs + guides) during implementation.

Post-Phase 1 design re-check: PASS.

Planned new configurable settings (names to be finalized during implementation):
- `MAX_NODES_PER_USER`
- `MAX_WORKSPACES_PER_NODE`
- `MAX_AGENT_SESSIONS_PER_WORKSPACE`
- `NODE_HEARTBEAT_STALE_SECONDS`

## Project Structure

### Documentation (this feature)

```text
specs/014-multi-workspace-nodes/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
└── tasks.md             # Created by /speckit.tasks (not by /speckit.plan)
```

### Source Code (repository root)
```text
apps/
├── api/
│   ├── src/
│   │   ├── db/
│   │   ├── routes/
│   │   └── services/
│   └── tests/
└── web/
    ├── src/
    │   ├── components/
    │   ├── pages/
    │   └── lib/
    └── tests/

packages/
├── shared/              # Shared API types (Node/Workspace/Agent Session)
├── cloud-init/          # Node bootstrap template updates
└── vm-agent/            # Node Agent updates (multi-workspace + routing + sessions)
```

**Structure Decision**: This is a web application + worker API with a VM-side Node Agent. The feature will touch `apps/api`, `apps/web`, `packages/shared`, `packages/cloud-init`, and `packages/vm-agent`.

## Complexity Tracking

No constitution violations requiring justification were identified for this plan.

## Phase 0: Outline & Research (Output: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/research.md`)

Research goals:
- Confirm the best routing strategy for per-Workspace subdomains (`ws-{workspaceId}.*`) when multiple Workspaces share one Node.
- Confirm a practical isolation model that prevents port collisions between Workspaces on the same Node.
- Confirm the authentication model between Control Plane and Node Agent for multi-Workspace operations (user access tokens vs node callback tokens vs per-Workspace tokens).

## Phase 1: Design & Contracts (Outputs under `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/`)

Design goals:
- Define the new data model for Node, Workspace (within Node), and Agent Session.
- Define API contracts for Node/Workspace/Agent Session lifecycle and for `ws-*` proxy behavior.
- Define Control Plane callback contracts for Node Agent ready/check-in signaling.
- Define Node Agent management API contracts used by the Control Plane.
- Define WebSocket attach/session semantics for Agent Sessions.
- Define explicit session attach concurrency/idempotency and stop/attach race behavior.
- Provide a quickstart that matches the new UI and API flows (create Node, create multiple Workspaces on it, manage sessions).

## Phase 2: Planning Stop Point

This `/speckit.plan` run ends after generating `research.md`, `data-model.md`, `contracts/*`, and `quickstart.md`, and after updating agent context via `.specify/scripts/bash/update-agent-context.sh codex`.
