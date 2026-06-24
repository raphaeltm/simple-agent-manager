# Custom domains for deployment public routes (v1)

## Problem statement

Today, a public route (`mode: 'public'`) on a deployment environment automatically
gets a SAM-owned grey-cloud hostname:
`r{N}-{service}-{port}-{env}.apps.{baseDomain}`, with a stable loopback `hostPort`,
a DNS-only A record pointing at the node IP, and a node-local Caddy site block that
terminates TLS via ACME HTTP-01 and reverse-proxies to `127.0.0.1:{hostPort}`.

Users want to serve those same apps on **their own subdomain** (e.g.
`app.theircompany.com`). We let them attach a custom subdomain to an existing
public route. They point a CNAME at the SAM-owned route hostname; we verify the
CNAME/A resolves to our route target, then emit an **additional** static Caddy
site block for the custom hostname (same `hostPort` as the parent public route)
inside the existing Ed25519-signed `ApplyPayload`. Caddy provisions TLS for the
custom hostname via the same ACME HTTP-01 path.

## Locked design decisions (from Raphaël — do NOT re-litigate)

1. **Subdomains only** for v1 — no apex/root domains. User points a CNAME at the
   existing SAM-owned route hostname. No apex A-record / ALIAS handling.
2. **No wildcards** — single concrete hostnames only.
3. **Ownership proof = "domain points at us is sufficient"** — no TXT challenge.
   Verify the user's hostname CNAME/A-resolves (via a configurable DNS-over-HTTPS
   resolver, defaulting to Cloudflare DoH) to our route target (or node IP) before
   activating. No separate TXT record.
4. **Caddy strategy = simple / static** — emit a static per-domain site block
   inside the signed `ApplyPayload` (custom hostname must be covered by
   `routesHash`). No on-demand TLS / no `ask` authorization endpoint in v1.

## Proven prerequisite (do not re-litigate)

Node-local Caddy + ACME HTTP-01 on :80/:443 already works (existing deployment URLs
serve valid HTTPS). iptables defaults to ACCEPT and does not block 80/443; the
provider cloud firewall is the ingress gate. Custom domains exercise the SAME path.
One confirmation item only: ensure the cloud-firewall rule allowing 80/443 is
applied to every deployment node, not just tested ones.

## Research findings (key files / injection points)

### Routing derivation — `apps/api/src/services/deployment-routing.ts`

- `buildRouteHostname(environmentId, service, port, routeIndex, baseDomain)` →
  `r${routeIndex+1}-${servicePart}-${port}-${envPart}.apps.${baseDomain}` (the
  CNAME target users will point at).
- `assignRouteTargets(publicRoutes, opts)` → assigns `hostPort = envPortBase + index`.
- `buildDeploymentRouteTargets(manifest, opts)` → filters `manifest.routes` where
  `mode === 'public'`. Returns `DeploymentRouteTarget { hostname, service, containerPort, hostPort }`.
- `collectEnvironmentRouteHostnames(manifests, opts)` → used for stale DNS teardown.

### Signed payload boundary — `apps/api/src/services/deploy-signing.ts`

- `signDeployPayload(payload, env)`; `buildSignableBytes` computes
  `routesHash = SHA-256 hex of JSON.stringify(routes ?? [])`. Custom hostnames MUST
  be appended to `routes` BEFORE signing so they ride inside `routesHash`.

### Injection point — `apps/api/src/routes/deploy-release-callback.ts`

- `GET /:id/deploy-release` handler. Two release shapes share the apply path,
  discriminated by `release.source`:
  - `compose-publish` branch (≈219–264): `routes = buildComposePublishApplyPayload(...).routes`.
  - default/`build-on-node` branch (≈265–306): `routes = buildDeploymentRouteTargets(...)`.
- Both branches: when `routes.length > 0`, loop `upsertAppRouteDNSRecord(route.hostname, nodeIp)`.
- After the if/else (≈ line 306, before `cleanupStaleRoutes`/`signDeployPayload`):
  **append verified custom-domain RouteTargets**, each reusing its parent public
  route's `hostPort`, matched by `service` + `containerPort`. Custom domains are
  USER-owned DNS — **exclude** them from the `upsertAppRouteDNSRecord` loop (SAM
  does not create their records).
- Mounted at `/api/nodes` in `index.ts` BEFORE `projectsRoutes` (Rule 34). Auth:
  `verifyCallbackToken(token, env, { expectedScope: 'node' })`.

### DNS / verification — `apps/api/src/services/dns.ts`

- `upsertAppRouteDNSRecord` / `deleteAppRouteDNSRecord` / `cleanupAppRouteDNSRecords`
  manage SAM-owned grey-cloud records. The branch adds a DNS-over-HTTPS verifier
  with configurable `DOH_RESOLVER_URL` and `DOH_TIMEOUT_MS` defaults for hostname
  verification.

### VM agent — `packages/vm-agent/internal/deploy/`

- `types.go`: `ApplyPayload.Routes []RouteTarget`; `RouteTarget { Hostname, Service, ContainerPort, HostPort }`; `SignablePayload.RoutesHash`.
- `caddy.go`: `GenerateCaddySnippet(routes)` renders per-hostname `reverse_proxy 127.0.0.1:{HostPort}`; `validateRouteTarget` already guards hostname chars (`^[A-Za-z0-9.-]+$`) and port ranges. Custom hostname reuses this exactly — **no Go changes expected** beyond a unit test proving a custom hostname renders a valid site block.

### Data model

- No `deployment_domains` table exists. Latest migration is `0075`; new migration is **`0076`**.
- `deployment_environments` is a CASCADE parent (Rule 31) — additive only, never DROP/recreate.

## Implementation checklist

### Migration + schema

- [x] `apps/api/src/db/migrations/0076_deployment_custom_domains.sql` — `CREATE TABLE deployment_custom_domains` (id, environment_id FK→deployment_environments ON DELETE CASCADE, service, port, route_index, hostname, verification_status TEXT DEFAULT 'pending', verification_error TEXT, verified_at TEXT, created_by FK→users ON DELETE SET NULL, created_at). Unique index on `hostname`. Index on `environment_id`.
- [x] Add `deploymentCustomDomains` table to `apps/api/src/db/schema.ts`.

### DoH verification helper

- [x] New `apps/api/src/services/deployment-domain-verify.ts`: `resolveHostnameTarget(hostname, env)` via configurable DoH. `verifyCustomDomainTarget(hostname, expectedCnameTarget, expectedNodeIp, env)` → boolean (matches CNAME to route hostname OR A to node IP).
- [x] Unit tests: matching CNAME answer → verified; non-matching answer → failed; A-record-to-node-ip → verified.

### API CRUD

- [x] Routes under `/api/projects/:projectId/environments/:environmentId/custom-domains` (reuse `requireAuth` + `requireApproved` + `requireOwnedProject`). POST (attach: validate hostname maps to a real public route of the env — reject private/nonexistent; persist pending; return the exact CNAME target). POST `/:domainId/verify` (run DoH, set verified/failed). GET (list). DELETE (remove).
- [x] Integration tests for each route incl. reject-private-route and reject-nonexistent-route.

### Signed payload injection

- [x] In `deploy-release-callback.ts`, after the release-shape branch, load verified custom domains for the env and append a `DeploymentRouteTarget` for each (hostname = custom hostname; service/containerPort = parent route; hostPort = parent route's hostPort matched by service+containerPort). Skip if no matching parent route in current `routes`. Do NOT call `upsertAppRouteDNSRecord` for them.
- [x] Vertical-slice test (Rule 35): attach→verify→apply in `apps/api/tests/unit/routes/deployment-custom-domains-vertical.test.ts`. Mock DoH (realistic CNAME), mock the signed-payload boundary, and assert the custom hostname rides in `routes` with the parent's `hostPort` while user DNS is not upserted.

### Cross-boundary + Go

- [x] Cross-boundary contract test (Rule 23): the hostname/hostPort the API emits matches what `caddy.go` `GenerateCaddySnippet` renders.
- [x] Go unit test in `packages/vm-agent/internal/deploy/caddy_test.go`: `GenerateCaddySnippet` emits a valid site block for a custom hostname.

### Docs (Rule 01 — same PR)

- [x] Update `apps/www/src/content/docs/docs/guides/app-deployments.md` with a custom-domains section (CNAME setup, verify flow, what's out of scope).
- [x] Update any deployment architecture/spec docs touching routing.

## Acceptance criteria

- [x] A user can attach a custom subdomain to an existing public route; private/nonexistent routes are rejected.
- [x] Verification resolves the hostname via Cloudflare DoH and only marks `verified` when it points at our route target (CNAME) or node IP (A). Non-matching → `failed` with the exact CNAME target surfaced.
- [x] On verified, the custom hostname rides as an additional `RouteTarget` (same `hostPort` as its parent public route) in the next signed `ApplyPayload`, covered by `routesHash`.
- [x] Node Caddy provisions TLS + reverse-proxies the custom hostname (verified on staging serving valid HTTPS).
- [x] Deleting a custom domain drops its site block on next apply.
- [x] SAM never creates the user's DNS record (no `upsertAppRouteDNSRecord` for custom hostnames).

Staging evidence: on 2026-06-24, staging environment
`01KVWBXQZ3QZV8EKW7WFHTGTDM` (`sam-cd-20260624082835`) applied release v2 on
deployment node `01KVT1KVGZ8S9NZHKHKAV0QFP6`. Custom hostname
`sam-custom-01kvwbxqz3.138-199-146-229.sslip.io` verified via A-record-to-node-IP
and served HTTPS 200 with `ssl_verify_result=0`, `remote_ip=138.199.146.229`,
`server: nginx/1.31.2`, and `via: 1.1 Caddy`.

Browser staging verification: Playwright token-login against
`https://api.sammy.party/api/auth/token-login` then navigation to
`https://app.sammy.party/projects/01KVRJCC7Y3NSDQYCPWDRPVJVH/deployments/01KVWBXQZ3QZV8EKW7WFHTGTDM`
loaded the deployment view with expected environment/deployments content and no
browser console errors. A broader staging pass also loaded dashboard, project
chat, the deployment environment, and settings routes with content present, no
404s, and no browser console errors.

## Out of scope (v2 — note in spec)

- Apex / root domains; node-IP / apex ALIAS handling.
- Wildcards.
- TXT ownership proof.
- On-demand TLS + `ask` authorization endpoint.

## References

- Rule 31 (migration safety — additive only on CASCADE parents)
- Rule 34 (VM agent callback routes — callback JWT auth; mount before projectsRoutes)
- Rule 23 (cross-boundary contract tests), Rule 35 (vertical-slice tests)
- Rule 01 (doc sync), Rule 10 (e2e capability), Rule 13 (staging verification)
