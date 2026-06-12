# Productionize Caddy Routing/TLS for App Deployment Nodes

**Created:** 2026-06-12
**SAM task:** 01KTX9M6J0TPMGW0CQ98HQ1EAW
**Branch:** `sam/productionize-caddy-routingtls-app-01ktx9`

## Problem Statement

The app-deployment path can now create deployment nodes and apply releases, but deployed containers are not reachable from the internet. There is no app-route DNS, no node-side HTTP/TLS reverse proxy, and no release-apply path that updates routing without restarting the proxy.

This task productionizes the missing data plane: deployment nodes install Caddy, the control plane creates grey-cloud app DNS records, release payloads carry route targets derived from the manifest's `routes` array / `x-sam-routes`, and the deployment agent writes a generated Caddyfile and performs zero-downtime `caddy reload` after successful release apply.

## Research Findings

- `packages/shared/src/deployment-manifest/schema.ts` defines `routes: [{ service, port, mode }]`; `packages/shared/src/compose-parser/parse-fields.ts` maps `x-sam-routes` into the same shape. There is no hostname field, so hostnames should be SAM-derived for now rather than user-supplied.
- `apps/api/src/routes/deploy-release-callback.ts` currently renders and signs only `composeYaml`. The signed payload contract should include route config so the node does not parse Compose or infer hostnames.
- `packages/vm-agent/internal/deploy/engine.go` writes release state, runs `docker compose pull/up`, health-checks, then marks the release current. Caddyfile write/reload belongs after successful container convergence and before final success observation.
- `packages/cloud-init/src/template.ts` already supports deployment role env vars. It needs Caddy installation/configuration as a separate systemd-managed service, independent from `vm-agent`.
- `apps/api/src/services/dns.ts` already creates Cloudflare DNS records for `ws-*` and `*.vm` patterns. App-route DNS should follow this machinery, but create grey-cloud records (`proxied: false`) so Caddy can use HTTP-01 ACME without Cloudflare DNS-write credentials on the node.
- Draft spike task `tasks/backlog/2026-06-11-caddy-acme-spike.md` recommends Caddy with node-side ACME and grey-cloud DNS. It notes DNS-01 requires a custom Caddy build plus Cloudflare DNS edit credentials; production implementation should prefer HTTP-01 to avoid node-side Cloudflare DNS credentials.
- Recent archived task `tasks/archive/2026-06-13-deployment-node-provisioning.md` confirms deployment provisioning must remain provider-agnostic through the shared Provider interface and that real staging VM provisioning is required.
- Rules read: `.claude/rules/02-quality-gates.md`, `13-staging-verification.md`, `22-infrastructure-merge-gate.md`, `23-cross-boundary-contract-tests.md`, `27-vm-agent-staging-refresh.md`, `34-vm-agent-callback-auth.md`, `35-vertical-slice-testing.md`, and `03-constitution.md`.

## Implementation Checklist

### 1. Cloud-Init Caddy Installation and Service

- [x] Install Caddy on deployment nodes via `packages/cloud-init/` without adding provider-specific cloud-init branches.
- [x] Create required Caddy directories and a minimal initial `/etc/caddy/Caddyfile`.
- [x] Ensure Caddy is a separate systemd service from `vm-agent`, enabled at boot, and not restarted by release applies.
- [x] Keep workspace-node behavior intact.
- [x] Add cloud-init tests that parse the generated YAML and assert Caddy setup round-trips for realistic deployment-role data.

### 2. Control-Plane Route Hostname and DNS

- [x] Add deterministic app hostname generation from environment/project/release route state using `BASE_DOMAIN`; avoid hardcoded domains.
- [x] Add DNS service functions for app route A records that create/update grey-cloud records (`proxied: false`) pointing at the deployment node IP.
- [x] Wire release creation/provisioning so public routes create/update DNS records through `apps/api/src/services/dns.ts`; no provider-specific branches in `apps/api`.
- [x] Omit private routes from public DNS/Caddy exposure.
- [x] Add unit tests for hostname generation, grey-cloud DNS payloads, and idempotent create/update behavior.

### 3. Signed Release Payload Route Contract

- [x] Add route-target data to the deploy release callback response and signature contract.
- [x] Generate Caddy route targets from the validated manifest and environment metadata in the control plane.
- [x] Preserve callback JWT auth and route mounting outside session-authenticated project routes.
- [x] Add cross-boundary contract tests proving the API response shape matches the Go deployment agent payload shape.

### 4. Caddyfile Generation and Reload in VM Agent

- [x] Add Go Caddyfile generation from signed route targets with realistic multi-route support.
- [x] Parse/round-trip the generated Caddy config in tests rather than relying on string containment only.
- [x] Write the generated Caddyfile atomically to disk during release apply.
- [x] Run `caddy reload --config <path> --adapter caddyfile` after successful compose convergence.
- [x] Ensure reload failures fail the release apply before it is marked applied.
- [x] Add Go tests for successful reload, reload failure, atomic write behavior, and no container restart of Caddy.

### 5. Vertical Slice and Regression Tests

- [ ] Add a release-apply vertical slice test with realistic environment, node, release manifest, DNS state, callback payload, and route targets.
- [x] Add tests proving public routes get DNS + payload route targets while private routes do not.
- [x] Add tests that would fail if Caddyfile updates are skipped while containers apply successfully.
- [ ] Run package-level tests for `shared`, `cloud-init`, `api`, and `vm-agent`.

### 6. Documentation / Operational Decision Record

- [ ] Document the HTTP-01 decision in the task/archive record or relevant operational notes, citing code paths and explicitly noting that DNS-01 would require node-side Cloudflare DNS edit credentials and a custom Caddy build.
- [ ] Supersede and close draft PR #1292 after this implementation PR is ready.

### 7. Mandatory Staging Verification

- [ ] Deploy branch to staging.
- [ ] Follow rule 27: ensure VM-agent staging verification uses freshly provisioned deployment nodes with the new binary.
- [ ] Submit a release with public routes on staging.
- [ ] Verify DNS resolves for the generated app hostname.
- [ ] Verify TLS handshake succeeds over HTTPS at the app hostname.
- [ ] Verify the app responds over HTTPS.
- [ ] Verify Caddy reload path, not container restart, is used for route updates.
- [ ] Clean up test deployment environment, node, DNS records, and any other paid/external resources.
- [ ] Record exact staging evidence in the PR.

## Acceptance Criteria

1. Deployment nodes install and run Caddy independently from `vm-agent`.
2. Release apply writes Caddy config from manifest routes and reloads Caddy without restarting the Caddy service.
3. Public app hostnames get grey-cloud DNS records via the existing control-plane DNS service pattern.
4. HTTP-01 ACME is the documented TLS strategy; no node-side Cloudflare DNS-write token is required.
5. The implementation remains provider-agnostic: provider operations go through `packages/providers`, and `apps/api` has no provider-specific routing/TLS branches.
6. Unit, contract, vertical-slice, and Go tests cover the route/DNS/payload/Caddy reload path.
7. Staging verification proves DNS resolution, TLS handshake, and HTTPS app response on a real deployment node, with cleanup completed.

## References

- Draft spike: PR #1292 / `tasks/backlog/2026-06-11-caddy-acme-spike.md`
- Library docs: `.library/02-phased-delivery.md/02-phased-delivery-plan.md`, `.library/10-release-apply.md/10-release-apply-semantics.md`
- Recent provisioning task: `tasks/archive/2026-06-13-deployment-node-provisioning.md`
- Deployment manifest: `packages/shared/src/deployment-manifest/schema.ts`
- Compose routes parser: `packages/shared/src/compose-parser/parse-fields.ts`
- Release callback: `apps/api/src/routes/deploy-release-callback.ts`
- DNS service: `apps/api/src/services/dns.ts`
- Deployment engine: `packages/vm-agent/internal/deploy/engine.go`
- Cloud-init template: `packages/cloud-init/src/template.ts`
