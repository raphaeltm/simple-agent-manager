# Split Oversized Files (Pre-Existing Tech Debt)

> **Reconciliation 2026-09-30:** still open, and most files grew. Line counts now (when filed):
> `bootstrap.go` 3,297 (2,236), `session_host.go` 744 (2,207), vm-agent `server/server.go` 2,003
> (1,287), `gateway.go` 1,408 (1,081), vm-agent `server/workspaces.go` 2,201 (1,067),
> `apps/api/src/index.ts` 939 (848), `MultiTerminal.tsx` 825 (841), `useAcpSession.ts` 831 (822).
> Add `apps/api/src/scheduled/stuck-tasks.ts` (1,742, also in `EXEMPT_FILES`) and
> `scripts/deploy/sync-wrangler-config.ts` (1,444; its FILE SIZE EXCEPTION comment points here).
> `session_host.go` is now under 800 and can leave `EXEMPT_FILES`.

## Problem

8 files exceed the 800-line mandatory split threshold (`.claude/rules/18-file-size-limits.md`). These are allowlisted in `scripts/quality/check-file-sizes.ts` to avoid blocking CI, but should be split.

## Files

| File | Lines | Notes |
|------|-------|-------|
| `packages/vm-agent/internal/bootstrap/bootstrap.go` | 2236 | Largest — split by lifecycle phase |
| `packages/vm-agent/internal/acp/session_host.go` | 2207 | Split by concern (session mgmt, message handling) |
| `packages/vm-agent/internal/server/server.go` | 1287 | Extract middleware, route registration |
| `packages/vm-agent/internal/acp/gateway.go` | 1081 | Extract protocol handling |
| `packages/vm-agent/internal/server/workspaces.go` | 1067 | Split by workspace operation type |
| `apps/api/src/index.ts` | 848 | Extract route registration, middleware setup |
| `packages/terminal/src/MultiTerminal.tsx` | 841 | Extract sub-components |
| `packages/acp-client/src/hooks/useAcpSession.ts` | 822 | Extract helper functions |

## Acceptance Criteria

- [ ] Each file above is under 800 lines
- [ ] All imports still resolve (barrel re-exports where needed)
- [ ] All tests pass after splitting
- [ ] File removed from allowlist in `scripts/quality/check-file-sizes.ts`
