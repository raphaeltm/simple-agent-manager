# Compose preview endpoint omits route port bindings

## Problem

`GET /api/projects/:projectId/environments/:envId/releases/:releaseId/compose`
(`apps/api/src/routes/deployment-releases.ts`) calls `renderCompose` WITHOUT supplying
`routeTargets`. The renderer defaults `routeTargets` to an empty array, so the previewed
YAML contains no `ports:` stanzas. The real node-apply payload (built in the deploy
release callback path) DOES pass `routeTargets`, so the preview shows a different compose
file than what the node actually receives — specifically, the public-route port bindings
are absent from the preview.

This is a debugging/confusion hazard: a user or developer inspecting the rendered YAML via
the preview endpoint will not see the `127.0.0.1:<hostPort>:<containerPort>` bindings that
make public routes work.

## Context

- Pre-existing; flagged by cloudflare-specialist review of the compose-renderer fix
  (branch `sam/resume-land-caddy-routingtls-01ktyg`, 2026-06-13).
- Out of scope for the routing/TLS landing PR.

## Acceptance Criteria

- [ ] Preview endpoint either passes `routeTargets` (using the same
      `buildDeploymentRouteTargets` logic the apply path uses) so the preview matches the
      node payload, OR clearly documents in the response that port bindings are
      intentionally omitted from the preview.
- [ ] Test asserting preview output matches node-apply output for a manifest with a public
      route (or asserting the documented difference).
