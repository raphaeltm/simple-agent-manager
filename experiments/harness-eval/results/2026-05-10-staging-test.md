# Staging Test Report: harness/develop Branch

**Date:** 2026-05-10
**Branch:** `harness/develop`
**Deploy Run:** [25622918992](https://github.com/raphaeltm/simple-agent-manager/actions/runs/25622918992)
**Result:** Deploy succeeded, partial feature validation complete

## Summary

Deployed the full `harness/develop` branch to staging (`sammy.party`). The deploy completed successfully including VM agent binary upload. Core infrastructure is in place but sandbox agent features require additional Worker secrets to be configured.

## Deploy Results

| Step | Status | Notes |
|------|--------|-------|
| Build (pnpm) | PASS | All 9 packages built successfully (cached) |
| Build (Go harness) | PASS | All 8 test packages pass |
| Build (Go vm-agent) | PASS | All 15 test packages pass |
| Staging deploy | PASS | Full pipeline: Pulumi, Workers, Pages, D1, R2, secrets |
| Health check | PASS | `api.sammy.party/health` returns healthy |
| Smoke tests | PASS | Post-deploy smoke test job passed |

## Feature Validation

### 1. Agent Catalog — sam-harness Registration

**Status: WORKING**

`sam-harness` appears correctly in the agents catalog API:
```json
{
  "id": "sam-harness",
  "name": "SAM Harness",
  "description": "SAM native Go coding agent harness",
  "supportsAcp": true,
  "configured": false,
  "credentialHelpUrl": "",
  "fallbackCredentialSource": null
}
```

The agent type is properly registered in `packages/shared/src/agents.ts` with:
- `acpCommand: "sam-harness"`
- `acpArgs: ["--acp"]`
- `envVarName: "SAM_API_KEY"`
- `installCommand: "cd /opt/harness && CGO_ENABLED=0 go build -o /usr/local/bin/sam-harness ./cmd/harness/"`

### 2. Sandbox Admin Endpoints

**Status: CORRECTLY GATED (disabled)**

The `/api/admin/sandbox/status` endpoint reports:
```json
{
  "enabled": false,
  "bindingAvailable": true,
  "config": {
    "execTimeoutMs": 30000,
    "gitTimeoutMs": 120000,
    "sleepAfter": "10m"
  }
}
```

Key findings:
- `SANDBOX` Cloudflare Containers binding IS available on staging
- `SANDBOX_ENABLED` Worker secret is NOT set to `"true"` — agent loop is correctly gated
- `/api/admin/sandbox/agent` returns: `"Sandbox prototype is disabled. Set SANDBOX_ENABLED=true to enable."`

### 3. ProjectAgent DO — Sandbox Prompt Endpoint

**Status: CORRECTLY GATED (disabled)**

The `ProjectAgent` DO has a `/sandbox-prompt` endpoint gated behind TWO env vars:
1. `SANDBOX_ENABLED` — must be `"true"` (currently not set)
2. `HARNESS_AGENT_ENABLED` — must be `"true"` (currently not set)

Both are required for the project-level harness agent to function.

### 4. Harness Binary in R2

**Status: UPLOADED**

The harness binary is available in the staging R2 bucket:
```
experiments/harness-linux-amd64 (6,103,224 bytes / ~6.1 MB)
```

VM agent binaries also present:
```
agents/vm-agent-linux-amd64 (13,512,996 bytes)
agents/vm-agent-linux-arm64 (12,714,168 bytes)
```

### 5. VM Agent — sam-harness Gateway Support

**Status: CODE PRESENT (untestable without VM)**

The vm-agent `gateway.go` correctly handles `sam-harness`:
- Command: `sam-harness`
- Args: `["--acp"]`
- Install: `cd /opt/harness && CGO_ENABLED=0 go build -o /usr/local/bin/sam-harness ./cmd/harness/`
- Model env var: `SAM_AI_MODEL`

## Gaps / Blockers

### 1. Worker Secrets Not Configured

The following env vars need to be set as Worker secrets for sandbox features to activate:

| Secret | Required Value | Purpose |
|--------|---------------|---------|
| `SANDBOX_ENABLED` | `"true"` | Enable Sandbox SDK prototype endpoints |
| `HARNESS_AGENT_ENABLED` | `"true"` | Enable ProjectAgent sandbox harness loop |

**Action:** Run via deployment pipeline or manual `wrangler secret put` for staging.

### 2. Harness Source Not Provisioned on VMs

The `sam-harness` install command expects Go source at `/opt/harness` on the VM:
```
cd /opt/harness && CGO_ENABLED=0 go build -o /usr/local/bin/sam-harness ./cmd/harness/
```

But cloud-init (`packages/cloud-init/`) has no step to:
- Clone the harness source to `/opt/harness`, OR
- Download the pre-built binary from R2 (`experiments/harness-linux-amd64`)

**Options:**
1. **Download pre-built binary from R2** (faster, simpler) — change install command to fetch `experiments/harness-linux-amd64` from R2 and place at `/usr/local/bin/sam-harness`
2. **Clone source and build** (current approach) — add cloud-init step to clone the repo or download source archive to `/opt/harness`
3. **Include in cloud-init image** — bake into the base image

**Recommendation:** Option 1 — download pre-built binary from R2. The binary is already uploaded during deploy. This avoids requiring Go on the VM and reduces agent startup time.

### 3. No Agent API Key Required

The `sam-harness` agent uses `SAM_API_KEY` as its credential env var. Since this is a SAM-native agent, it may not need a traditional API key — it could authenticate via the platform's internal mechanisms. The credential flow needs clarification.

## Existing Staging Health

Verified during testing:
- [x] API health endpoint responds correctly
- [x] Authentication via smoke test token works
- [x] Agent catalog returns all 6 agent types
- [x] Admin sandbox endpoints are properly guarded (superadmin + SANDBOX_ENABLED)
- [x] One running node exists on staging (01KPJMMVWB70BA7MEGA7Z5GAS8)

## Next Steps

1. **Set Worker secrets** — configure `SANDBOX_ENABLED=true` and `HARNESS_AGENT_ENABLED=true` on staging
2. **Fix harness install path** — update install command to download pre-built binary from R2 instead of building from source
3. **Test sandbox agent loop** — once enabled, test `POST /api/admin/sandbox/agent` with a simple prompt
4. **Test sam-harness on a fresh VM** — delete existing node, provision new one, attempt to run harness agent
5. **Wire SAM AI Gateway** — ensure the harness routes through SAM's proxy to Cloudflare AI Gateway (per project policy)
