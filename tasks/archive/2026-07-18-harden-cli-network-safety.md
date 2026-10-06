# Harden CLI network safety

## Problem

The CLI/VM Go audit task `01KXT1F6JSDV3J5CJ22TGXRGAV` recommended two narrow remediation items:

1. Enforce HTTPS JWKS/issuer rules with explicit local-development exceptions.
2. Cap CLI API response body reads.

The current VM agent JWT validator can initialize against any JWKS URL accepted by the JWKS client, including remote `http://` endpoints. The VM agent config also allows `CONTROL_PLANE_URL` to be `http` or `https` without distinguishing local development from remote production-like hosts. Separately, the CLI API client reads response bodies with unbounded `io.ReadAll`, which can turn a large API error or malformed response into excessive memory use.

This PR must be tightly targeted and backward-compatible: remote/production JWKS and issuer/control-plane URLs should require HTTPS, while existing local development and `httptest` fixtures should continue to work through explicit localhost/private-loopback exceptions.

## Research findings

- `packages/vm-agent/internal/auth/jwt.go`
  - `NewJWTValidator(jwksURL, nodeID, issuer, audience)` currently constructs `keyfunc.NewDefaultCtx` directly from `jwksURL`.
  - Issuer validation is an exact string comparison against the configured `issuer`.
  - Tests in `packages/vm-agent/internal/auth/jwt_test.go`, `packages/vm-agent/internal/server/git_credential_test.go`, and `packages/vm-agent/internal/server/workspaces_test.go` use `httptest.Server` URLs (`http://127.0.0.1:<port>`), so local exceptions must cover loopback hosts.
- `packages/vm-agent/internal/config/config.go`
  - `JWKSEndpoint` defaults to `ControlPlaneURL + "/.well-known/jwks.json"`.
  - `JWTIssuer` defaults to `ControlPlaneURL`.
- `packages/vm-agent/internal/config/helpers.go`
  - `Validate()` currently permits both `http` and `https` `CONTROL_PLANE_URL` schemes.
  - `TestValidateInvalidControlPlaneURL` covers invalid schemes, but no test distinguishes remote HTTP from local HTTP.
- `packages/cli/internal/cli/client.go`
  - `doJSON()` reads `response.Body` with unbounded `io.ReadAll` before error parsing or JSON decoding.
  - This path is used by auth helpers and all CLI API methods.
- Existing bounded response-body patterns:
  - VM agent already uses `io.LimitReader` for non-2xx control-plane responses in several places, e.g. ACP heartbeat/reporting and workspace callbacks.
  - `packages/vm-agent/internal/publish/controlplane.go` has `maxControlPlaneErrorBodyBytes = 4096`.
- Relevant rules/docs:
  - `.claude/rules/36-cli-quality.md` requires high-quality Go changes in `packages/cli`.
  - `.claude/rules/34-vm-agent-callback-auth.md` documents callback JWT auth pitfalls and the need for route/auth regression tests.
  - Public docs describe VM agent JWT validation via JWKS (`apps/www/src/content/docs/docs/architecture/security.md`, `architecture/overview.md`, `reference/vm-agent.md`).
- Relevant archived task context:
  - `tasks/archive/2026-05-15-fix-git-credential-callback-auth.md` establishes that valid workspace callback JWTs are intentionally accepted through the VM agent JWT validator and must remain covered by tests.
  - `tasks/archive/2026-05-03-vm-agent-workspace-scoping-callbacks.md` previously added bounded response-body logging for VM-agent callbacks, reinforcing the bounded-read pattern.

## Implementation checklist

- [x] Add a small shared VM-agent auth URL validation helper that:
  - [x] Accepts `https://` for JWKS and issuer/control-plane URLs.
  - [x] Accepts `http://` only for explicit local development hosts (`localhost`, loopback IPv4/IPv6).
  - [x] Rejects remote `http://` JWKS URLs before any network fetch.
  - [x] Rejects remote `http://` issuer/control-plane URLs during config validation.
- [x] Wire HTTPS/local validation into `auth.NewJWTValidator()`.
- [x] Wire HTTPS/local validation into VM agent config validation for `CONTROL_PLANE_URL`, `JWKS_ENDPOINT`, and URL-form `JWT_ISSUER`.
- [x] Keep non-URL issuer strings compatible for existing tests/config (`test-issuer` style).
- [x] Cap CLI `doJSON()` response body reads with a clear maximum.
- [x] Return a clear CLI error when a success response exceeds the cap before JSON decoding.
- [x] Preserve bounded parsing of oversized error responses without reading unbounded data.
- [x] Add Go tests for HTTPS enforcement and local exceptions.
- [x] Add Go tests for bounded CLI body reads, including oversized error responses.
- [x] Run relevant Go tests and repository quality checks.
- [x] Archive this task file after validation.

## Acceptance criteria

- Remote `http://` JWKS endpoints fail closed before fetching keys.
- Remote `http://` control-plane/issuer URLs are rejected by VM agent config validation.
- `https://` JWKS/issuer URLs are accepted.
- Local development `http://localhost`, `http://127.0.0.1`, and `http://[::1]` URLs remain accepted.
- Existing tests using `httptest.Server` continue to pass.
- CLI API response body reads are bounded for both successful and error responses.
- Oversized API error responses are parsed/truncated safely and do not require reading the full body.
- Go tests cover the new security behavior and bounded-read behavior.
- PR body states this is non-breaking and includes test evidence.
