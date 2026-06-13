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

- [ ] Public-route A records are deleted when the owning environment/node is torn down (wire
      DNS deprovisioning into node deletion and/or an environment-delete path, using the same
      `dns.ts` service that created them; idempotent / tolerant of already-deleted records).
- [ ] Add `DELETE /api/projects/:projectId/environments/:envId` (ownership-checked) that
      removes the environment, its releases, and its app-route DNS records.
- [ ] Regression test: provisioning a public route then tearing it down removes the A record.
- [ ] Regression test: environment delete is ownership-scoped and cascades release cleanup.
