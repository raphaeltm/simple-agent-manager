# Deployment routing: per-environment host-port offset to prevent collisions

## Problem

`buildDeploymentRouteTargets` (`apps/api/src/services/deployment-routing.ts`) allocates
public-route host ports from a flat range starting at `portBase` (default 35000) using
only the route index — `hostPort = portBase + index`. It does NOT incorporate
`environmentId`. Two environments placed on the same deployment node that both define
public routes will therefore be assigned overlapping host ports (both starting at 35000),
producing a Docker `bind: address already in use` error when the second environment is
deployed.

This collision was previously masked: the `sam-internal` network was declared
`internal: true`, which dropped all host->container published-port traffic, so the
`ports:` bindings never functioned. Commit `5b0765bd` made `sam-internal` a normal bridge
so public routes work — which means the published ports are now real and the collision is
observable for the first time.

A related manifestation: the deploy Apply path (`engine.go`) does NOT `composeDown` the
previous release before bringing up the new one (composeDown only runs in
`handleApplyFailure`/revert). Consecutive releases in the SAME environment use a project
name = seq, so they collide on the same host port (35000) and the in-place upgrade fails
to rebind → revert. A fresh node sidesteps this. Both are the same root cause class:
host-port allocation does not account for what else is bound on the node.

## Context

- Discovered during the Caddy routing/TLS productionization staging verification
  (branch `sam/resume-land-caddy-routingtls-01ktyg`, 2026-06-13).
- Flagged by cloudflare-specialist review of the compose-renderer fix.
- Out of scope for the routing/TLS landing PR (pre-existing, not introduced by it).

## Acceptance Criteria

- [ ] Host-port allocation derives a per-environment (and ideally per-release) offset so
      two environments on one node, and consecutive releases in one environment, do not
      collide on the same host port.
- [ ] Decide and document whether deploy Apply should `composeDown` the prior release
      before binding the new one (in-place redeploy on a single node), or whether ports
      should rotate per release.
- [ ] Regression test: two environments on the same node both with public routes render
      non-overlapping host ports.
- [ ] Regression test: a redeploy (seq N → N+1) in the same environment does not fail to
      rebind the public host port.
