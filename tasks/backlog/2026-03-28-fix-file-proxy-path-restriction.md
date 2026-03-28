# Fix File Proxy Path Restriction in Chat File Viewer

## Problem

The chat file viewer (clicking file references in tool calls) rejects absolute paths outside `/home/node/` and `/home/user/`. Since workspace code lives at `/workspaces/...`, users can't view any workspace files via the file viewer in project chat.

The path validation function `normalizeProjectFilePath()` was designed for the **runtime files write API** (security finding INJ-VULN-03) but is also used by the **read-only file proxy routes**. The write restrictions are appropriate for file writes but overly restrictive for read-only viewing — users have full access to their dev containers and should be able to view any file.

## Research Findings

- **Validation function**: `apps/api/src/routes/projects/_helpers.ts` — `normalizeProjectFilePath()` (lines 46-91)
- **Allowed prefixes**: `ALLOWED_ABSOLUTE_PREFIXES = ['/home/node/', '/home/user/']` (line 34)
- **File proxy routes (read-only)**: `apps/api/src/routes/projects/files.ts` — uses `normalizeProjectFilePath` via `requireSafePath()`
- **Runtime file writes**: `apps/api/src/routes/projects/crud.ts` — also uses `normalizeProjectFilePath`
- **Security tests**: `apps/api/tests/unit/routes/security-fixes.test.ts` (lines 106-180) — tests the write API only
- The file proxy routes are already protected by authentication (user must own the project + workspace) and the VM agent validates the terminal token

## Implementation Checklist

- [ ] Create `normalizeFileProxyPath()` in `_helpers.ts` — keeps traversal prevention (no `..`, no empty segments, character validation) but removes the `ALLOWED_ABSOLUTE_PREFIXES` restriction. Still blocks `~/.ssh/authorized_keys` etc. for defense-in-depth.
- [ ] Update `requireSafePath()` in `files.ts` to use `normalizeFileProxyPath` instead of `normalizeProjectFilePath`
- [ ] Update the direct `normalizeProjectFilePath` call in the `/files/list` route to use `normalizeFileProxyPath`
- [ ] Add unit tests for `normalizeFileProxyPath` verifying:
  - Absolute paths like `/workspaces/foo/bar.ts` are allowed
  - `/etc/passwd` and other system paths are allowed (read-only is safe)
  - Path traversal (`..`) is still blocked
  - Empty/dot segments still blocked
  - Invalid characters still blocked
- [ ] Verify existing security tests for the write API still pass unchanged
- [ ] Export `normalizeFileProxyPath` for test access

## Acceptance Criteria

- [ ] Clicking a file reference in a chat tool call that uses an absolute path (e.g., `/workspaces/simple-agent-manager/src/foo.ts`) successfully opens the file viewer
- [ ] Path traversal attacks (`../../etc/passwd`) are still blocked
- [ ] The runtime file write API (`POST /runtime/files`) retains its strict path restrictions
- [ ] All existing security tests pass without modification
