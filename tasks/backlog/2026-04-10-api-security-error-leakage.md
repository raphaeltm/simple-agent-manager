# API Security: Error Leakage, Health Endpoint, and Input Validation

## Problem

Several security issues in the API Worker leak internal information to clients or have insufficient input validation:

1. Global `onError` handler returns raw `err.message` for non-AppError exceptions, potentially leaking stack traces or internal details
2. Public `/health` endpoint returns binding availability, limits, and missing bindings to unauthenticated callers
3. Workspace subdomain parser accepts any string as workspaceId without ULID validation
4. Admin user status endpoint lacks self-modification protection (role endpoint has it but status endpoint doesn't)
5. MCP tokens use `crypto.randomUUID()` (122 bits) instead of stronger `crypto.getRandomValues()` (256 bits)

## Research Findings

- **Error handler** (`apps/api/src/index.ts:487-494`): Catches `AppError` and `GcpApiError` specifically but falls through to raw `err.message` for all other errors. The error is already logged server-side.
- **Health endpoint** (`apps/api/src/index.ts:718-754`): Returns `limits`, `bindings`, and `missingBindings` objects. Should keep minimal public response and move details to admin route.
- **Subdomain parser** (`apps/api/src/lib/workspace-subdomain.ts:39,54`): Extracts workspaceId via `.toUpperCase()` but never validates ULID format before use in DB queries.
- **Admin status route** (`apps/api/src/routes/admin.ts:57-88`): The role-change endpoint (line 100) already has `if (userId === currentUserId)` check, but the status-change endpoint doesn't use `getUserId(c)` at all.
- **MCP token** (`apps/api/src/services/mcp-token.ts:38-40`): Uses `crypto.randomUUID()` which gives 122 bits of entropy. Can be upgraded to 256 bits with `crypto.getRandomValues(new Uint8Array(32))` + base64url.
- Admin routes are mounted at `/api/admin` with `requireSuperadmin()` wildcard middleware already applied.
- Existing test patterns in `apps/api/tests/unit/routes/security-fixes.test.ts` provide a good model.

## Implementation Checklist

- [ ] 1. Stop leaking internal error messages in global onError handler
  - Replace `err.message` with `"Internal server error"` for non-AppError/non-GcpApiError
- [ ] 2. Move health endpoint internals to admin
  - Reduce public `/health` to `{ status, version, timestamp }`
  - Add `GET /api/admin/health/details` with full binding/limits info
- [ ] 3. Validate workspace subdomain IDs against ULID pattern
  - Add `/^[0-9A-Z]{26}$/` check after extraction, return error for malformed IDs
- [ ] 4. Add admin self-suspension protection
  - Add `getUserId(c)` check to status-change endpoint, matching existing role-change pattern
- [ ] 5. Use stronger MCP token generation
  - Replace `crypto.randomUUID()` with `crypto.getRandomValues(new Uint8Array(32))` + base64url
- [ ] 6. Write unit tests for all changes
- [ ] 7. Ensure all existing tests pass

## Acceptance Criteria

- [ ] Non-AppError exceptions return generic "Internal server error" to clients
- [ ] Public `/health` returns only status, version, and timestamp
- [ ] New `/api/admin/health/details` endpoint returns full details behind superadmin auth
- [ ] Malformed workspace subdomain IDs (not matching ULID pattern) return 404
- [ ] Superadmin cannot suspend their own account via PATCH /api/admin/users/:userId
- [ ] MCP tokens use 256-bit entropy
- [ ] All existing tests pass
- [ ] PR created but NOT merged

## References

- `apps/api/src/index.ts` (error handler, health endpoint)
- `apps/api/src/lib/workspace-subdomain.ts`
- `apps/api/src/routes/admin.ts`
- `apps/api/src/services/mcp-token.ts`
- `apps/api/src/middleware/error.ts` (AppError class)
