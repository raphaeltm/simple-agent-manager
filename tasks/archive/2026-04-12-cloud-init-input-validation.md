# Cloud-Init Input Validation (Security Hardening)

## Problem

`packages/cloud-init/src/generate.ts` lacks input validation on `CloudInitVariables` before embedding them into shell scripts and systemd configs. Variables like `nodeId`, `hostname`, `vmAgentPort`, and `nekoImage` are interpolated into YAML/shell without format validation, creating template injection risks.

Most critically, `buildNekoPrePullCmd()` interpolates the Docker image name directly into a shell command without quoting: `` `- docker pull ${image} || true` ``.

## Research Findings

### Variables embedded in shell/systemd context
- `nodeId` → systemd `Environment=NODE_ID={{ node_id }}` and JSON config. Source: `ulid()` → uppercase alphanumeric. Pattern: `^[A-Z0-9]+$` but accepting lowercase too for safety.
- `hostname` → YAML `hostname:` and systemd service name. Source: `node-${node.id.toLowerCase()}`. Pattern: `^[a-z0-9.-]+$`
- `controlPlaneUrl` → systemd env var and curl URL. Source: `https://api.${env.BASE_DOMAIN}`. Pattern: valid URL.
- `jwksUrl` → systemd env var. Source: `https://api.${env.BASE_DOMAIN}/.well-known/jwks.json`. Pattern: valid URL.
- `callbackToken` → systemd env var. Source: JWT token. Pattern: base64url + dots.
- `vmAgentPort` → firewall script `VM_AGENT_PORT=`, systemd env var. Pattern: numeric 1-65535.
- `nekoImage` → `docker pull ${image}` (UNSAFE — no quoting). Pattern: Docker image chars.
- `cfIpFetchTimeout` → curl `--max-time` arg. Pattern: numeric.
- `logJournalMaxUse/KeepFree` → journald config values. Pattern: `^[0-9]+[KMGT]?$`
- `logJournalMaxRetention` → journald config. Pattern: `^[0-9]+(us|ms|s|min|h|day|week|month|year)$`
- `dockerDnsServers` → JSON array content. Pattern: quoted IP addresses.
- `projectId`, `chatSessionId`, `taskId` → systemd env vars. Pattern: alphanumeric + hyphens.
- `taskMode` → systemd env var. Pattern: `task` or `conversation`.
- `originCaCert`, `originCaKey` → PEM file content. Complex multiline — validated by structure.

### Existing test patterns
- Tests in `packages/cloud-init/tests/generate.test.ts` use `baseVariables()` helper
- Tests parse YAML output and verify content integrity
- Tests use realistic PEM certificates

## Implementation Checklist

- [ ] 1. Add `validateCloudInitVariables()` function in `generate.ts`
  - Validate `nodeId`: `^[a-zA-Z0-9-]+$`
  - Validate `hostname`: `^[a-zA-Z0-9.-]+$`
  - Validate `vmAgentPort` (if present): numeric 1-65535
  - Validate `nekoImage` (if present): `^[a-zA-Z0-9./:@_-]+$`
  - Validate `cfIpFetchTimeout` (if present): numeric positive integer
  - Validate `controlPlaneUrl`: valid URL format (starts with https://)
  - Validate `jwksUrl`: valid URL format
  - Validate `callbackToken`: no shell metacharacters
  - Validate `projectId` (if present): `^[a-zA-Z0-9_-]+$`
  - Validate `chatSessionId` (if present): `^[a-zA-Z0-9_-]+$`
  - Validate `taskId` (if present): `^[a-zA-Z0-9_-]+$`
  - Validate `taskMode` (if present): must be `task` or `conversation`
  - Validate `logJournalMaxUse` (if present): `^[0-9]+[KMGT]?$`
  - Validate `logJournalKeepFree` (if present): `^[0-9]+[KMGT]?$`
  - Validate `logJournalMaxRetention` (if present): systemd time span pattern
  - Validate `dockerDnsServers` (if present): safe characters only
- [ ] 2. Call `validateCloudInitVariables()` at top of `generateCloudInit()`
- [ ] 3. Single-quote Docker image name in `buildNekoPrePullCmd()` output
- [ ] 4. Export `validateCloudInitVariables` from index.ts for testing
- [ ] 5. Add comprehensive unit tests for validation
  - Valid inputs pass (realistic values from codebase)
  - Shell metacharacters rejected (`$(cmd)`, `` `cmd` ``, `; rm -rf /`, `| cat /etc/passwd`)
  - Empty required fields rejected
  - Edge cases: max-length strings, Unicode, null bytes
  - Each field has specific valid/invalid test cases
- [ ] 6. Ensure all existing tests still pass
- [ ] 7. Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] `validateCloudInitVariables()` rejects inputs with shell metacharacters
- [ ] `validateCloudInitVariables()` accepts all realistic values used in production
- [ ] `buildNekoPrePullCmd()` single-quotes the Docker image name
- [ ] All existing tests continue to pass unchanged
- [ ] New tests cover valid inputs, invalid inputs, and edge cases
- [ ] `pnpm lint && pnpm typecheck && pnpm test` all pass
