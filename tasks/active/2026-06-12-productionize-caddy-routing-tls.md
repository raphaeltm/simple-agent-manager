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

- [x] Add a release-apply vertical slice test with realistic environment, node, release manifest, DNS state, callback payload, and route targets.
- [x] Add tests proving public routes get DNS + payload route targets while private routes do not.
- [x] Add tests that would fail if Caddyfile updates are skipped while containers apply successfully.
- [x] Add tests proving Caddy reload failures fail release apply before the release is marked current/applied.
- [x] Run package-level tests for `shared`, `cloud-init`, `api`, and `vm-agent`.

### 6. Documentation / Operational Decision Record

- [x] Document the HTTP-01 decision in the task/archive record or relevant operational notes, citing code paths and explicitly noting that DNS-01 would require node-side Cloudflare DNS edit credentials and a custom Caddy build.
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

## Operational Decision: HTTP-01 ACME

SAM app-deployment routes use node-side Caddy with HTTP-01 ACME. The control plane creates exact grey-cloud A records with `upsertAppRouteDNSRecord()` in `apps/api/src/services/dns.ts`, and `deploy-release-callback.ts` ensures those records point at the deployment node before returning the signed payload. The vm-agent then writes a Caddyfile from signed route targets and runs `caddy reload` in `packages/vm-agent/internal/deploy/engine.go`.

DNS-01 is intentionally not used for this implementation. The spike found it would require a custom Caddy build with the Cloudflare DNS module plus a Cloudflare token with DNS edit permissions on the deployment node. HTTP-01 keeps DNS-write authority in the control plane, avoids node-side Cloudflare credentials, and uses standard Caddy.

## ATTACK PLAN — Debugging "app unreachable over HTTPS" (added 2026-06-12)

This plan is the result of an end-to-end trace of the deploy apply path. It corrects two
earlier hypotheses, identifies the real candidate failure points in order, gives the
distinguishing diagnostic for each, and lists fixes that are correct regardless of which
candidate is the culprit.

### Corrections to earlier hypotheses

1. **"Docker is absent on deployment nodes" — INVALID on Hetzner (the staging provider).**
   `packages/shared/src/constants/hetzner.ts` sets `DEFAULT_HETZNER_IMAGE = 'docker-ce'`, a
   first-party marketplace image with Docker CE + the compose v2 plugin pre-baked. Deployment
   mode skips `provision.Run` (the only apt-based Docker installer), but on Hetzner Docker is
   already present, so `docker compose pull/up` should work. (This hypothesis could still bite
   GCP/Scaleway base images, which install Docker only via the skipped provision step — but
   staging is Hetzner.)

2. **"A Hetzner cloud firewall blocks :80/:443" — INVALID.** Only `GcpProviderConfig` has
   firewall fields (`appRoutePorts`, etc.) in `packages/providers/src/types.ts`.
   `HetznerProviderConfig` has no firewall config and the Hetzner provider creates no cloud
   firewall, so 80/443 are open at the Hetzner edge.

3. **"`deployment_releases` stuck at `created` proves the apply failed" — MISLEADING.** The
   `status` column is **write-once**. It is set to `'created'` on insert
   (`apps/api/src/routes/deployment-releases.ts:235,286`) and **no control-plane code path ever
   advances it** to `applying`/`applied`/`failed`/`reverted` (verified by grepping all of
   `apps/api/src`). The node reports observed apply state in each heartbeat body
   (`body.deployment` from `health.go:sendNodeHeartbeat`), but the heartbeat handler
   (`apps/api/src/routes/node-lifecycle.ts:262-298`) only reads `appliedSeq` to compute
   `pendingReleaseSeq` — it never persists the observed status. **So "stuck at `created`" is the
   default for every release and is NOT evidence of an apply failure.** This is the single
   biggest observability gap: the control plane has zero persisted view of apply success/failure.

### Verified apply-trigger chain (code paths)

1. Node heartbeats with `body.deployment = {environmentId, appliedSeq, status, services}`
   (`packages/vm-agent/internal/server/health.go:116-124`). Requires `deployEngine` attached —
   done in `main.go:runDeploymentMode` via `srv.SetDeployEngine(engine)`.
2. Control plane resolves env by `deployment_environments.node_id == nodeId`
   (`node-lifecycle.ts:267-271`) and returns `pendingReleaseSeq = latestRelease.version` when
   `version > appliedSeq` (`:276-285`), plus `deployPubKey` from `DEPLOY_SIGNING_PUBLIC_KEY`
   (`:295-296`). **Hard dependency: the environment row's `node_id` must equal this node's id.**
3. Node: if `pendingReleaseSeq > observed.AppliedSeq`, background `FetchAndApply`
   (`health.go:184-211`).
4. `fetchRelease` GETs `/api/nodes/:id/deploy-release?seq=&environmentId=`
   (`deploy-release-callback.ts:35`). It re-checks `env.node_id == nodeId` AND
   `project.userId == node.userId` (`:95-102`); **if the manifest has routes and the node has no
   IP yet it throws 409** (`:135-137`); it upserts grey-cloud DNS (`:139`), renders compose, and
   returns the signed payload. Any non-200 returns an error to the node **before** `Apply` runs,
   so `observed.AppliedSeq` stays unchanged and the node retries on the next heartbeat.
5. `Apply` (`engine.go:~146-229`): nil verifier → "refusing to apply unsigned payload";
   then `GenerateCaddyfile` → `WriteRelease` → `composePull` → `composeUp` → `waitForHealth` →
   `reloadCaddy` → `SetCurrent`. Any step failure → `handleApplyFailure` (records
   `state.ErrorMessage`, sets observed status `failed`/`failed_initial`/`reverted`).

### Candidate failure points — ordered, each with its distinguishing diagnostic

The decisive next step is the **node debug package** (`GET /api/nodes/:id/debug-package`), which
bundles cloud-init logs, `journalctl -u vm-agent`, `journalctl -u caddy`, `docker ps/logs`, and
network/iptables state. Pull it once and most of the table below resolves immediately.

| # | Candidate | Distinguishing diagnostic |
|---|-----------|---------------------------|
| 1 | **Caddy daemon not running** (caddy-setup cloud-init step failed, or `caddy.service` not enabled/started) | `journalctl -u caddy` empty/failed; `systemctl is-active caddy` != active; `reloadCaddy` would fail with admin-API connection refused → look for `deploy: caddy reload failed` in vm-agent log. **Most likely given prior `:80` "Timeout during connect".** |
| 2 | **Apply never ran** (env→node binding missing, or fetchRelease 409 because node had no IP) | vm-agent log shows no "deploy: pending release detected" OR repeated `fetch and apply failed` with 409/404. CF: `SELECT node_id FROM deployment_environments WHERE id=…` must equal the node id. |
| 3 | **ACME HTTP-01 unreachable** (grey-cloud A record missing/wrong IP, or :80 not actually listening) | `dig +short app.<env>.apps.sammy.party` must return the node IP; `curl -v http://<host>/.well-known/acme-challenge/test` must reach Caddy (not time out). caddy log shows ACME order failures. |
| 4 | **`docker compose` plugin mismatch** (engine hardcodes v2 `"docker compose"`) | `docker compose version` on node; vm-agent log `composePull/Up` exec errors. Low risk on Hetzner `docker-ce` image. |
| 5 | **waitForHealth timeout** (containers never become healthy) | vm-agent log health-poll timeout; `docker ps` shows unhealthy/restarting containers; `docker logs` for the app container. |
| 6 | **Caddyfile content invalid** | RULED OUT locally — current generator output passes `caddy validate` and enables auto-HTTPS (tested with Caddy v2.8.4). |

### Fixes that are correct regardless of root cause

1. **Control-plane release-status lifecycle + persisted observed state (TOP observability fix).**
   Persist `body.deployment` (appliedSeq, status, error) from the heartbeat onto the environment
   (or a new column) and advance `deployment_releases.status` accordingly. Without this, every
   failure mode above is invisible from the control plane. *(Larger change: schema migration +
   heartbeat persistence + status transitions; file as the next implementation slice.)*
2. **vm-agent deployment-mode error reporting.** `FetchAndApply`/`Apply` failures currently
   produce a single `slog.Error` and nothing reaches the control plane. Route deploy apply/fetch
   failures through the existing VM-agent error-report channel
   (`node-lifecycle.ts` VM error report handler) so they surface in `/admin/errors`.
3. **Deployment-mode startup preflight logging.** At `runDeploymentMode` start, log
   availability of `docker`, `docker compose`, and `caddy` (LookPath + `--version`) and whether
   `caddy.service` is active, so a missing dependency is obvious in the first seconds of the log.
4. **ACME email + issuer pin in `GenerateCaddyfile`.** Add a global options block with a
   configurable contact `email` and an optional `acme_ca` override (env-driven), so testing can
   target the LE **staging** CA and avoid burning prod rate limits, and prod sets a real contact
   email. Verified locally: both `{ email … }` and `{ email …; acme_ca <staging> }` global blocks
   pass `caddy validate` on Caddy v2.8.4. (Hardening, not the root-cause fix — current output is
   already valid.)

### Local replication already done
- Reproduced current generator output and ran `caddy validate` (Caddy v2.8.4): **valid**, auto-HTTPS
  enabled on :443, HTTP→HTTPS redirect enabled.
- Validated the proposed global-options block (email, and email+staging `acme_ca`): both valid.

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
