# Migrate File Proxy Token to Auth Header

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** the VM agent side. `requireWorkspaceRequestAuth` accepts
>   `Authorization: Bearer` and falls back to `?token=`
>   (`packages/vm-agent/internal/server/workspace_routing.go:108–124`; PR #570 a7254b4bc,
>   PR #651 ccccbcec7). Current VM agents accept the header, so the API side should be able to
>   switch without a compatibility window.
> - **Still open:** this file owns all token-in-URL work, including the `getFileRawUrl`
>   `<img src>`. `2026-03-28-file-raw-security-hardening.md` keeps the size-limit, symlink and
>   MIME items.
>   - The API file proxy still sends the terminal token as `?token=`:
>     `apps/api/src/routes/projects/files.ts:168` (`proxyToVmAgent`: list, find, view, git
>     status, git diff), `:378` (raw), `:471` (upload), `:527` (download).
>   - `getFileRawUrl` (`apps/web/src/lib/api/files.ts:394–404`) puts the token in the
>     `<img src>` that `FileViewerPanel.tsx:218` renders; needs a blob or API-proxy approach.
>   - No test yet proves terminal tokens stay out of query strings and logs.

**Created**: 2026-03-28
**Context**: Discovered during workspace-file-upload-download implementation

## Problem

The file proxy routes (files/list, files/view, git/status, git/diff, files/raw, files/upload, files/download) pass the terminal token as a query parameter (`?token=...`). Query parameters are logged in access logs, proxy logs, and potentially browser history — exposing short-lived but sensitive auth tokens.

## Proposed Solution

Migrate all file proxy routes to pass the token via the `Authorization: Bearer <token>` header instead of a query parameter. This requires updating:

1. `apps/api/src/routes/projects/files.ts` — all `proxyToVmAgent` calls and direct fetch calls
2. `packages/vm-agent/internal/server/auth.go` — `requireWorkspaceRequestAuth` to also check `Authorization` header
3. `apps/web/src/lib/api.ts` — `getSessionFileRawUrl` and `getFileRawUrl` which build URLs used as `<img src>` (these need special handling since img src doesn't support custom headers — may need a fetch+blob approach)

## Acceptance Criteria

- [ ] All file proxy routes send token via `Authorization: Bearer` header
- [ ] VM agent `requireWorkspaceRequestAuth` accepts token from header (with query param fallback for backward compat during rollout)
- [ ] No terminal tokens appear in query strings in production logs
- [ ] Image rendering still works (may need blob URL approach for `<img src>`)
- [ ] Backward-compatible: old VM agents still work with query param tokens during rolling deploy
