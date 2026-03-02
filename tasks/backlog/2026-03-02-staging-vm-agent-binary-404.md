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

## Investigation Steps

- [ ] Check if the `AGENT_BUCKET` R2 binding exists in the staging wrangler config
- [ ] Check if the VM agent binary has been uploaded to the staging R2 bucket
- [ ] Check the deploy workflow to see if binary upload is included in staging deploys
- [ ] Verify the `/api/agent/download` route handler and error response

## Acceptance Criteria

- [ ] `GET https://api.sammy.party/api/agent/download?arch=amd64` returns the VM agent binary (200)
- [ ] New nodes on staging successfully download and start the VM agent
- [ ] Heartbeats are received and workspaces can be provisioned
