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

## Staging deploy + cleanup results (2026-06-13)

Deploy `27464896689` (Deploy Staging) succeeded. Authenticated to `api.sammy.party` and exercised
the new `DELETE /api/projects/:projectId/environments/:envId` endpoint end-to-end:

- **Feature validated end-to-end.** Deleting `caddyverify` (`01KV01STTRB1ETNECMZ7SGX3XE`) and
  `caddyfresh` (`01KV07K3WX5P7SPSNJHJH8ZJYS`) each returned `{"deleted":true,"dnsRecordsDeleted":1}`
  and their `r1-whoami-80-*` A records were confirmed removed from the `sammy.party` zone (whoami
  record count: 2 → 0).
- **Bulk orphan cleanup.** Found 24 orphaned `caddy*` test environments total (all `node_id=null`,
  same test user). Deleted all 24 via the endpoint. Six `caddy-e2e-*` envs each removed their
  matching full-id `r1-web-8080-*` record (`dnsRecordsDeleted:1`); the rest had no live records.
  D1 `caddy*` environment count is now 0.
- **8 of 12 orphaned A records removed** by the endpoint (2× `r1-whoami-80-*`, 6× `r1-web-8080-*`).

### Remaining: 4 legacy DNS records require manual deletion

Four records remain that the endpoint **cannot** match because they were created under an OLD
hostname scheme that truncated the env ID to 12 chars; the current `buildRouteHostname` uses the
full 26-char ULID, so no derivable hostname matches them. Their owning env rows were deleted, but
the records are now unreferenced:

| Record name | Cloudflare record ID |
|---|---|
| `r1-web-80-01ktxh72x9nq.apps.sammy.party` | `e0d46d0a69a803689e3e338bbef46b03` |
| `r1-web-80-01ktxj3pkz3n.apps.sammy.party` | `ebd9679bb2132c0a27c30074f1e20f82` |
| `r1-web-80-01kty7vwnrka.apps.sammy.party` | `428f54e043201f9372630218a8db4cf3` |
| `r1-web-80-01kty96vcsrn.apps.sammy.party` | `3a513cf12609e2aca624cd9bb1bdde0e` |

The CF token available in this environment is read-only for DNS (delete returns `Authentication
error`), so these must be removed manually via the Cloudflare dashboard or a token with DNS-edit
on zone `ff189eb6d934a6c2b3f9f9595cafc256`. They are harmless legacy leftovers — no current code
path can recreate that scheme.
