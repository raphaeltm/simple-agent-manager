# Make CLI local forwarding fail closed

## Problem

`sam workspace <id> forward` uses `httputil.ReverseProxy.Director` to acquire and attach the SAM local-forward token. `Director` cannot abort proxying. If token acquisition fails after the request URL has been rewritten, the proxy can still contact the upstream local-forward endpoint without `X-SAM-Forward-Token`.

This must fail closed: when the CLI cannot acquire a forward token, it should return a local redacted `502`/`503` and must not contact upstream.

## Scope

- Only change `packages/cli`.
- Preserve successful existing behavior, flags, URLs, headers, defaults, public API shape, and data formats.
- Keep the PR tightly targeted.
- Open a PR and do not merge.

## Research Findings

- CLI local forwarding is implemented in `packages/cli/internal/cli/workspace.go`.
- `acceptConnections` creates a `tokenCache` and a `httputil.ReverseProxy`.
- The current `Director` rewrites `req.URL`, strips spoofable proxy/SAM headers, then calls `tc.getToken(req.Context())`.
- On token acquisition failure, `Director` writes a redacted log line and returns, but `ReverseProxy` continues with the already-mutated request.
- Existing tests in `packages/cli/internal/cli/workspace_test.go` cover successful local forwarding, app `Authorization`/`Cookie` preservation, multiple `Set-Cookie` preservation, escaped path segments, host validation, header stripping, token cache refresh, and shutdown.
- Prior local forwarding task: `tasks/archive/2026-06-17-localhost-preserving-cli-forwarding.md`.
- CLI quality requirements are in `.claude/rules/36-cli-quality.md`: command-boundary and scenario tests, injectable boundaries, redaction, race/coverage evidence.

## Implementation Checklist

- [x] Move token acquisition out of `ReverseProxy.Director` and into the local handler before proxying.
- [x] Ensure the handler returns a local redacted `502`/`503` on token acquisition failure.
- [x] Ensure `Director` only rewrites and attaches a token already acquired by the handler.
- [x] Add a regression test proving upstream is never contacted when token acquisition fails.
- [x] Add/constrain a race/scenario test proving concurrent token acquisition failures do not leak requests upstream.
- [x] Preserve and rerun existing success-path tests for URLs, escaped paths, headers, app auth/cookies, and `Set-Cookie`.
- [x] Run `go test -race -coverprofile=coverage.out -covermode=atomic ./...` in `packages/cli`.
- [x] Review `go tool cover -func=coverage.out` for touched production file coverage.
- [x] Record local `test-engineer`, `go-specialist`, `security-auditor`, and task-completion review outcomes.

## Acceptance Criteria

- A forward-token acquisition error returns a local redacted `502`/`503`.
- No upstream request is made when token acquisition fails.
- Token strings, session cookies, and internal auth details are not written to local HTTP responses.
- Existing successful local forwarding behavior remains unchanged.
- Tests are scenario-driven and include race-capable coverage for the safety path.

## Bug-Fix Post-Mortem

### What broke

CLI local forwarding could contact the upstream local-forward endpoint without `X-SAM-Forward-Token` when token acquisition failed inside `ReverseProxy.Director`.

### Root cause

`httputil.ReverseProxy.Director` is not an abort hook. The CLI used it both to rewrite the outbound request and to acquire credentials. Returning from `Director` after an error did not stop `ReverseProxy` from sending the partially prepared request.

### Process fix

Security-sensitive proxy credentials must be acquired and validated before entering a proxy component whose request lifecycle cannot be aborted by the credential hook. Regression tests must prove the protected upstream is not contacted on credential acquisition failure.

## References

- `packages/cli/internal/cli/workspace.go`
- `packages/cli/internal/cli/workspace_test.go`
- `.claude/rules/36-cli-quality.md`
- `tasks/archive/2026-06-17-localhost-preserving-cli-forwarding.md`


## Validation Evidence

- `go test ./internal/cli -run 'TestAcceptConnections(ProxiesWithToken|FailsClosedWhenTokenAcquisitionFails|ConcurrentTokenFailuresNeverContactUpstream|PreservesEscapedPathSegments)'` passed.
- `go test -race -coverprofile=coverage.out -covermode=atomic ./...` passed in `packages/cli`.
- `go tool cover -func=coverage.out` reviewed: `packages/cli/internal/cli/workspace.go` `acceptConnections` 77.8%, `getToken` 100%, package total 81.4%.
- `pnpm lint` passed from repository root with existing warnings.
- `pnpm typecheck` passed from repository root.
- `pnpm build` passed from repository root.
- `pnpm test` from repository root failed in unrelated API timeout tests under full-suite load; both failed tests passed on focused rerun:
  - `pnpm vitest run tests/unit/vm-agent-cross-boundary-contract.test.ts -t 'sendPromptToAgentOnNode sends'` in `apps/api`.
  - `pnpm vitest run tests/unit/routes/mcp-orchestration-tools.test.ts -t 'should reject missing taskId'` in `apps/api`.

## Local Review Evidence

| Reviewer | Status | Outcome |
| --- | --- | --- |
| test-engineer | PASS (local checklist) | New tests are scenario-level: token failure response/redaction/no-upstream-contact and concurrent failure no-upstream-contact under race suite. |
| go-specialist | PASS (local checklist) | Token acquisition now occurs before `ReverseProxy.ServeHTTP`; `Director` no longer contains fallible token acquisition. Existing success path URL/header behavior remains covered. |
| security-auditor | ADDRESSED | Initial local review found raw token acquisition errors reached stderr. Fixed by logging generic failure only and asserting stderr/body do not leak canary secret or spoofed token. |
| task-completion-validator | PASS (local checklist) | Research findings map to checklist and diff; acceptance criteria have tests or validation evidence; no UI/backend or multi-resource scope. |
| delegated subagents | FAILED TOOLING | Four local subagents returned without inspecting files due sandbox `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`; not counted as review passes. |

## Staging Evidence

Not deployed to staging. This change is limited to `packages/cli`, which is not a staging Worker/web runtime surface; behavior is covered by local CLI HTTP proxy tests and the Go race/coverage suite.
