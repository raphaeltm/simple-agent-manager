# Staging VM Agent Binary Download Returns 404

## Problem

The VM agent binary download endpoint on staging returns HTTP 404:

```
GET https://api.sammy.party/api/agent/download?arch=amd64 → 404
```

This means cloud-init on newly provisioned VMs cannot download the `vm-agent` binary. The systemd service fails to start, no heartbeat is ever sent, and workspaces remain stuck in "creating" status indefinitely.

## Impact

- **All new nodes on staging are non-functional** — they boot but the VM agent never starts
- Both nodes observed on 2026-03-02 show `lastHeartbeat: null` and `status: Stale`
- Workspaces cannot be provisioned or tested on staging
- Blocks any staging-dependent testing (including env var injection investigation)

## Context

- Discovered during staging investigation on 2026-03-02
- Cloud-init template (`packages/cloud-init/src/template.ts:39`) downloads from `{{ control_plane_url }}/api/agent/download?arch=${ARCH}`
- The endpoint serves binaries from the R2 bucket (`AGENT_BUCKET` binding)
- Likely cause: the VM agent binary was never uploaded to the staging R2 bucket, or the R2 binding is misconfigured

## Root Cause (Confirmed)

The `deploy.yml` workflow does NOT build or upload the VM agent binary to R2. The R2 binding exists (the `/api/agent/version` endpoint returns `{ version: "unknown", available: false }` rather than 503), but the R2 bucket is empty — no `agents/vm-agent-linux-amd64` binary, no `agents/version.json`.

The route handler (`apps/api/src/routes/agent.ts`) is correct — it looks for `agents/vm-agent-linux-amd64` in R2 and returns 404 when not found.

## Fix Required

Add a step to the deploy workflow (or a separate workflow) that:
1. Cross-compiles the Go VM agent for linux/amd64 and linux/arm64
2. Uploads the binaries to R2 under `agents/vm-agent-linux-{arch}`
3. Uploads a `agents/version.json` with version metadata

## Investigation Steps

- [x] Check if the `AGENT_BUCKET` R2 binding exists — **yes, R2 is bound (not 503)**
- [x] Check if the VM agent binary has been uploaded — **no, R2 bucket is empty**
- [x] Check the deploy workflow for binary upload — **not present in `deploy.yml`**
- [x] Verify the `/api/agent/download` route handler — **correct, returns 404 when R2 object missing**

## Acceptance Criteria

- [ ] `GET https://api.sammy.party/api/agent/download?arch=amd64` returns the VM agent binary (200)
- [ ] New nodes on staging successfully download and start the VM agent
- [ ] Heartbeats are received and workspaces can be provisioned
