# TLS for API Worker ↔ VM Agent Communication

**Created**: 2026-03-04
**Priority**: Security
**Estimated scope**: 13 files changed (1 new)

## Problem

The API Worker communicates with VM agents over **plain HTTP** (`http://vm-{nodeId}.{domain}:8080`). All traffic between the control plane and VMs — including JWTs, agent prompts, and session data — is unencrypted.

## Solution

Use a **Cloudflare Origin CA certificate** (wildcard, 15-year validity) managed declaratively via Pulumi. Orange-cloud the `vm-*` DNS records so Cloudflare's edge validates the Origin CA cert. VM agent listens on port 8443 with TLS.

```
Before:  Worker --[HTTP:8080]--> vm-{id} (DNS-only) --> VM agent
After:   Worker --[HTTPS:443]--> vm-{id} (CF-proxied) --[HTTPS:8443]--> VM agent
```

## Prerequisites

- [x] CF API token updated with "SSL and Certificates: Edit" zone permission

## Acceptance Criteria

- [ ] **Pulumi Origin CA cert** — `infra/resources/origin-ca.ts` generates wildcard cert for `*.{BASE_DOMAIN}` using `@pulumi/tls` + `@pulumi/cloudflare` `OriginCaCertificate` resource (15-year validity, protected)
- [ ] **Pulumi exports** — `infra/index.ts` exports `originCaCertPem` and `originCaKeyPem` as secret outputs
- [ ] **Deploy pipeline reads cert** — `deploy-reusable.yml` reads Origin CA cert/key from Pulumi state (heredoc for multi-line PEM), passes to configure-secrets step
- [ ] **Worker secrets set** — `configure-secrets.sh` sets `ORIGIN_CA_CERT` and `ORIGIN_CA_KEY` as required Worker secrets
- [ ] **Cloud-init writes cert files** — `packages/cloud-init/src/template.ts` writes cert to `/etc/sam/tls/origin-ca.pem` (0644) and key to `/etc/sam/tls/origin-ca-key.pem` (0600) via `write_files`
- [ ] **Cloud-init injects TLS env vars** — systemd service gets `TLS_CERT_PATH`, `TLS_KEY_PATH`, `VM_AGENT_PORT=8443`
- [ ] **Cloud-init variables updated** — `CloudInitVariables` interface includes `originCaCert?` and `originCaKey?`
- [ ] **VM agent TLS config** — `config.go` adds `TLSCertPath`, `TLSKeyPath`, `TLSEnabled` (derived) fields from env vars
- [ ] **VM agent serves HTTPS** — `server.go` `Start()` uses `ListenAndServeTLS` when TLS enabled, falls back to `ListenAndServe` otherwise
- [ ] **DNS records proxied** — `dns.ts` `createNodeBackendDNSRecord()` changed to `proxied: true`
- [ ] **HTTPS fetch URLs** — `node-agent.ts` `getNodeBackendBaseUrl()` uses configurable protocol/port (`VM_AGENT_PROTOCOL`/`VM_AGENT_PORT` env vars, defaults `https`/`8443`)
- [ ] **Workspace proxy updated** — `index.ts` proxy uses `https:` protocol and configurable port
- [ ] **Env interface updated** — `VM_AGENT_PORT`, `VM_AGENT_PROTOCOL`, `ORIGIN_CA_CERT`, `ORIGIN_CA_KEY` added to Env
- [ ] **Wrangler defaults** — `wrangler.toml` sets `VM_AGENT_PORT = "8443"` and `VM_AGENT_PROTOCOL = "https"`
- [ ] **Node provisioning passes cert** — `nodes.ts` `provisionNode()` passes `originCaCert`/`originCaKey` from env to `generateCloudInit()`
- [ ] **Cloud-init size OK** — Cert+key (~3.4KB) keeps total well within 32KB Hetzner limit
- [ ] **WebSocket works over TLS** — Terminal and agent WebSocket connections verified functional
- [ ] **Unit tests** — Cloud-init generation, VM agent config loading, URL construction
- [ ] **Integration test** — Deploy to staging, provision node, verify HTTPS health check + WebSocket

## Files to Change

| File | Change |
|------|--------|
| `infra/resources/origin-ca.ts` | **NEW** — Pulumi Origin CA cert resource |
| `infra/index.ts` | Export origin CA outputs |
| `.github/workflows/deploy-reusable.yml` | Read + pass Origin CA cert/key from Pulumi |
| `scripts/deploy/configure-secrets.sh` | Set ORIGIN_CA_CERT/KEY Worker secrets |
| `packages/cloud-init/src/generate.ts` | Add originCaCert/Key to variables + replacements |
| `packages/cloud-init/src/template.ts` | write_files for cert/key, systemd env vars |
| `packages/vm-agent/internal/config/config.go` | TLS config fields |
| `packages/vm-agent/internal/server/server.go` | Conditional ListenAndServeTLS |
| `apps/api/src/services/dns.ts` | `proxied: true` for node backend records |
| `apps/api/src/services/node-agent.ts` | HTTPS URL construction |
| `apps/api/src/index.ts` | Env interface + proxy URL update |
| `apps/api/wrangler.toml` | VM_AGENT_PORT/PROTOCOL vars, secrets comments |
| `apps/api/src/services/nodes.ts` | Pass cert/key to generateCloudInit |

## Rollout Notes

- Clean cutover — after deploying, existing VMs must be **reprovisioned** (they have the old binary and no TLS cert)
- No hot-update mechanism exists for running VMs
- Port 8443 is in Cloudflare's supported HTTPS proxy port list
- `ListenAndServeTLS` preserves `WriteTimeout: 0` for WebSocket compatibility

## Design Reference

Full plan at: `/workspaces/claude-home/plans/transient-shimmying-allen.md`
