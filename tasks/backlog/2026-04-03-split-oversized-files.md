# Split Oversized Files (Pre-Existing Tech Debt)

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
