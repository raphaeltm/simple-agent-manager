# Fix 6 Issues from Debug Package Analysis

**Created**: 2026-05-05
**Source**: Debug package from node `01KQV7ZAHKB9EPFCM11XCZ7G9P`
**Priority**: CRITICAL (3 issues), HIGH (1), MEDIUM (1), LOW (1)

## Problem Statement

Debug package analysis from a failing workspace node revealed a cascading failure chain: containers can't reach Ubuntu apt mirrors (archive.ubuntu.com times out through Docker bridge NAT on Hetzner), causing gh CLI install to take 11.5 minutes and agent (codex-acp) install to fail entirely. The agent failure triggers a task callback that returns 401, leaving the task stuck "running" forever. Additionally, error reporting returns 400, the agent binary has a dirty version suffix, and cloud-init fails schema validation.

## Research Findings

### Issue 1: Container apt mirrors unreachable (CRITICAL)

**Root cause**: Host VM uses Hetzner's fast mirror (`mirror.hetzner.com`) configured via `/etc/apt/sources.list`, but Docker containers use the default `archive.ubuntu.com` which is slow/unreachable from Hetzner's network via Docker bridge NAT.

**Key files**:
- `packages/cloud-init/src/template.ts` — cloud-init template, no apt mirror config for containers
- `packages/cloud-init/src/generate.ts` — `CloudInitVariables` interface, no `provider` field
- `apps/api/src/services/nodes.ts` — node provisioning, provider info available but not passed to cloud-init
- `packages/vm-agent/internal/bootstrap/bootstrap.go` — devcontainer build, no mirror injection

**Fix approach**: Thread `provider` through cloud-init variables. Add a `write_files` entry in cloud-init that writes an apt mirror config script. The VM agent's bootstrap should inject the appropriate apt mirror config into containers based on the provider. Only use Hetzner mirror on Hetzner machines.

**Provider-specific mirrors**:
- Hetzner: `mirror.hetzner.com` (fast, already used by host)
- Scaleway: use defaults (Scaleway's network has good Ubuntu mirror peering)
- GCP: use defaults (Google's network has good Ubuntu mirror peering)

### Issue 2: Devcontainer builds stuck forever (CRITICAL)

**Root cause**: `ensureDevcontainerReady()` in `bootstrap.go` calls `devcontainer up` with the inherited context but no explicit timeout for the devcontainer build itself. When apt times out inside the Dockerfile, the build hangs indefinitely.

**Key files**:
- `packages/vm-agent/internal/bootstrap/bootstrap.go` line ~860: `exec.CommandContext(ctx, "devcontainer", args...)`
- No `DEVCONTAINER_BUILD_TIMEOUT` env var or config

**Fix**: Add a configurable `DEVCONTAINER_BUILD_TIMEOUT` (default: 15 minutes) that wraps the `devcontainer up` call with a context deadline.

### Issue 3: Task callback returns 401 (CRITICAL)

**Root cause**: The task callback at `apps/api/src/routes/tasks/crud.ts:457` uses `verifyCallbackToken()` which validates the JWT and checks `payload.workspace === task.workspaceId`. The VM agent uses `callbackTokenForWorkspace()` (workspace_provisioning.go:27) which looks up the workspace runtime's callback token. The callback token is workspace-scoped (signed with `signCallbackToken()` in jwt.ts:80).

The 401 occurs because either:
1. The token has expired (24h default, but this happened within ~15 min of provisioning)
2. The workspace runtime entry doesn't exist yet when the callback is attempted (workspace provisioning failed before it was registered)
3. The node's initial `CALLBACK_TOKEN` env var (from cloud-init) is node-scoped, not workspace-scoped

**Analysis**: Looking at `server.go:302`, the error reporter is initialized with `cfg.CallbackToken` (the node's callback token from cloud-init). But `callbackTokenForWorkspace()` at workspace_provisioning.go:27 checks the workspace runtime first, falling back to `s.config.CallbackToken` (line 33-35). The task callback endpoint at crud.ts:464 calls `verifyCallbackToken()` which verifies the JWT signature and checks `payload.workspace !== task.workspaceId`. If the VM agent is using the node-scoped callback token (fallback), the workspace claim won't match — causing the 401.

**Fix**: Ensure the VM agent uses the workspace-specific callback token (not the node's token) for task callbacks. The workspace runtime should always have its callback token set before agent sessions are attempted. Add better error logging to distinguish token scope mismatches from expiry.

### Issue 4: Agent binary is dirty (HIGH)

**Root cause**: `Makefile:8` uses `git describe --tags --always --dirty`. The `-dirty` suffix appears when there are uncommitted changes in the git working tree at build time. In CI (`deploy-reusable.yml:632`), `make -C packages/vm-agent build-all` runs after other build steps that may modify files (npm install, pnpm build, Pulumi operations).

**Fix**: Pass `VERSION` explicitly in the CI build step using `git describe` from a clean checkout point, or ensure the build happens before any operations that modify the working tree.

### Issue 5: Error reporting returns 400 (MEDIUM)

**Root cause**: The error reporter (`reporter.go:302`) is initialized with `cfg.CallbackToken` — the node's callback token. The errors endpoint at `node-lifecycle.ts:293` calls `verifyNodeCallbackAuth()` which at line 379 calls `verifyCallbackToken()` then checks that `payload.scope !== 'workspace'` and `payload.workspace === nodeId`.

The error reporter sends to `/api/nodes/{nodeId}/errors` with a Bearer token. If the token's `workspace` claim doesn't match the nodeId, it returns 401/403. But the log shows 400, not 401. The 400 likely comes from the `jsonValidator(NodeErrorBatchSchema)` — the request body might have an unexpected field or format that fails Valibot validation.

**Debugging approach**: Add response body logging in the VM agent's error reporter when non-OK status is received, so we can see the actual validation error message. Also check if the `context` field (map[string]interface{}) serializes in a way that fails validation.

**Fix**: Improve error reporter to log the response body on failure. Also review the schema to ensure it's permissive enough for the entries the VM agent sends (currently `v.array(v.unknown())` which should accept anything).

### Issue 6: Cloud-init schema validation warning (LOW)

**Root cause**: `cloud-config failed schema validation!` at boot. The cloud-init template at `template.ts` may have fields that don't conform to the Ubuntu 24.04 cloud-init schema. Common causes: `ssh_authorized_keys: []` (empty array where the schema expects at least one entry or the field to be omitted), or `permissions` as a string vs octal.

**Fix**: Review the template against the cloud-init JSON schema for Ubuntu 24.04 and fix any non-conforming fields. Most likely the empty `ssh_authorized_keys: []` should be removed.

## Implementation Checklist

### 1. Thread provider through cloud-init
- [ ] Add `provider` field to `CloudInitVariables` interface in `generate.ts`
- [ ] Pass provider from `nodes.ts` to `generateCloudInit()`
- [ ] Add apt mirror configuration `write_files` entry to cloud-init template, conditional on provider
- [ ] Write `/etc/sam/apt-mirror.sh` script that containers can source
- [ ] Update cloud-init tests to verify provider-aware mirror config

### 2. Inject apt mirror into containers
- [ ] In VM agent bootstrap, inject apt mirror config into containers before package installs
- [ ] Pass provider info from cloud-init env vars to VM agent
- [ ] Add `PROVIDER` environment variable to vm-agent systemd service in cloud-init template
- [ ] In bootstrap.go, read provider env var and configure apt mirrors accordingly
- [ ] Test with Hetzner mirror config only applied for Hetzner provider

### 3. Add devcontainer build timeout
- [ ] Add `DEVCONTAINER_BUILD_TIMEOUT` config field to vm-agent config
- [ ] Default to 15 minutes (configurable via env var)
- [ ] Wrap `devcontainer up` call with timeout context in `ensureDevcontainerReady()`
- [ ] Add timeout error reporting with resource diagnostics
- [ ] Add test for timeout behavior

### 4. Fix task callback 401
- [ ] Investigate workspace callback token availability at task failure time
- [ ] Ensure workspace runtime has callback token set before agent sessions start
- [ ] Add structured error logging in crud.ts callback handler for auth failures
- [ ] Add response body logging in VM agent's `postTaskCallback()` for non-2xx responses
- [ ] Add test verifying task callback works with workspace-scoped token

### 5. Fix dirty agent binary
- [ ] In `deploy-reusable.yml`, compute VERSION from git before any build artifacts are created
- [ ] Pass `VERSION=<value>` explicitly to `make -C packages/vm-agent build-all`
- [ ] Verify the built binary reports a clean version

### 6. Fix error reporting 400
- [ ] Add response body logging in VM agent error reporter for non-2xx responses
- [ ] Investigate actual validation error (may need staging reproduction)
- [ ] If schema validation issue: fix the schema or the request format
- [ ] Test error reporting with realistic payloads

### 7. Fix cloud-init schema validation
- [ ] Remove empty `ssh_authorized_keys: []` from users section (or omit when empty)
- [ ] Validate template output against cloud-init schema
- [ ] Add test parsing generated YAML against cloud-init schema expectations

## Acceptance Criteria

- [ ] Containers on Hetzner VMs use `mirror.hetzner.com` for apt operations
- [ ] Containers on non-Hetzner providers use default Ubuntu mirrors
- [ ] `devcontainer up` has a configurable timeout (default 15min)
- [ ] Task callbacks succeed with workspace-scoped callback tokens
- [ ] Failed tasks transition to "failed" status (not stuck on "running")
- [ ] Agent binary version has no `-dirty` suffix in CI builds
- [ ] Error reporting endpoint returns 2xx for valid error batches
- [ ] Cloud-init generates schema-valid YAML (no warnings in logs)
- [ ] All changes have tests
- [ ] Provider abstraction respected (Hetzner mirror not hardcoded for all providers)

## References

- Debug package: `/workspaces/.private/debug-01KQV7ZAHKB9EPFCM11XCZ7G9P.tar.gz`
- Cloud-init template: `packages/cloud-init/src/template.ts`
- VM agent bootstrap: `packages/vm-agent/internal/bootstrap/bootstrap.go`
- Task callback: `apps/api/src/routes/tasks/crud.ts:457`
- Error reporter: `packages/vm-agent/internal/errorreport/reporter.go`
- JWT service: `apps/api/src/services/jwt.ts`
- Node provisioning: `apps/api/src/services/nodes.ts`
- CI build: `.github/workflows/deploy-reusable.yml:630`
