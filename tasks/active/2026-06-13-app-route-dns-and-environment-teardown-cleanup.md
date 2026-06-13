# App-route DNS records and deployment environments are not cleaned up on teardown

## Problem

Two related cleanup gaps in the app-deployment lifecycle, discovered during the Caddy
routing/TLS staging verification (branch `sam/resume-land-caddy-routingtls-01ktyg`,
2026-06-13):

1. **App-route DNS records are never deprovisioned.** When a public route is provisioned,
   the control plane creates a grey-cloud A record `r{n}-{service}-{port}-{envId}.apps.<domain>`
   via `apps/api/src/services/dns.ts`. Deleting the deployment node (`DELETE /api/nodes/:id`)
   does NOT remove these records. After staging verification, 12 orphaned A records remained
   in the `sammy.party` zone (e.g. `r1-whoami-80-01kv07k3wx5p7spsnjhjh8zjys.apps.sammy.party`),
   all pointing at a now-freed node IP. They accumulate across every test/real deployment.

2. **There is no environment-delete endpoint.** `apps/api/src/routes/deployment-environments.ts`
   only exposes `POST` (create) and `GET` (list/detail). A deployment environment (and its
   releases) cannot be removed via the API once created — test environments `caddyfresh`
   (`01KV07K3WX5P7SPSNJHJH8ZJYS`) and `caddyverify` (`01KV01STTRB1ETNECMZ7SGX3XE`) are now
   orphaned with no API path to delete them.

## Context

- Discovered during Caddy routing/TLS productionization staging verification.
- Node teardown frees the Hetzner VM but leaves DNS + environment/release rows behind.
- The staging CF API token is read-only for DNS, so the verifying agent could not remove the
  orphaned records itself — they require a control-plane deprovision path or manual deletion.

## Acceptance Criteria

- [x] Public-route A records are deleted when the owning environment/node is torn down (wire
      DNS deprovisioning into node deletion and/or an environment-delete path, using the same
      `dns.ts` service that created them; idempotent / tolerant of already-deleted records).
- [x] Add `DELETE /api/projects/:projectId/environments/:envId` (ownership-checked) that
      removes the environment, its releases, and its app-route DNS records.
- [x] Regression test: provisioning a public route then tearing it down removes the A record.
- [x] Regression test: environment delete is ownership-scoped and cascades release cleanup.

## Implementation Notes (2026-06-13)

App-route DNS record IDs are not persisted anywhere, so cleanup reconstructs the hostnames
from each release's manifest using the same `buildDeploymentRouteTargets` derivation as the
apply path.

- `apps/api/src/services/dns.ts`: added `deleteAppRouteDNSRecord(hostname, env)` (idempotent,
  404-tolerant) and `cleanupAppRouteDNSRecords(hostnames, env)` (bulk, per-record failure-tolerant,
  returns count deleted).
- `apps/api/src/services/deployment-routing.ts`: added `collectEnvironmentRouteHostnames(manifests, opts)`
  reusing the apply-path derivation; skips malformed and over-span manifests.
- `apps/api/src/routes/deployment-environments.ts`: added `DELETE /:projectId/environments/:envId`
  (ownership-checked). Deprovisions DNS before the row delete (so manifests are still available),
  then the FK cascade removes releases/secrets/volumes/routes.
- `apps/api/src/routes/nodes.ts`: node delete now deprovisions DNS for environments hosted on the
  node (their `nodeId` is set null by the FK, so the rows survive but their A records would point
  at the freed VM IP).
- Tests: `tests/unit/services/dns-app-routes.test.ts` (6 new), `tests/unit/services/deployment-routing.test.ts`
  (5 new), plus a DELETE 401-without-auth route test and the existing DB-level cascade test in
  `tests/workers/deployment-routes.test.ts`.

Remaining: deploy to staging, then USE the new endpoint to delete orphaned envs `caddyfresh`
(`01KV07K3WX5P7SPSNJHJH8ZJYS`, project `01KTKXZ4ZZAT6MJFXRW1ZTQ7RB`) and `caddyverify`
(`01KV01STTRB1ETNECMZ7SGX3XE`, project `01KJNR9R3TEN3KX1ETE33852R8`), plus manual cleanup of the
older `r1-web-*` A records that have no owning environment.
