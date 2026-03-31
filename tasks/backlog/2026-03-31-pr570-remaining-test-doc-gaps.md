# PR #570 Remaining Test & Documentation Gaps

## Problem

The task-completion-validator identified gaps that were not fully addressed before PR #570 merged:

1. **Cloud-init forwarding unit test**: No test verifies that `NEKO_IMAGE` and `NEKO_PRE_PULL` from the `Env` interface are passed through to `generateCloudInit()`. The code change is 2 lines in `nodes.ts` but could silently break in a refactor.

2. **self-hosting.md documentation**: `NEKO_IMAGE`, `NEKO_PRE_PULL`, and other Neko-related env vars are not documented in `docs/guides/self-hosting.md`. They exist in `.env.example` but operators starting from the self-hosting guide won't find them.

3. **browser_handlers_test.go**: The four HTTP handlers (`handleStartBrowser`, `handleGetBrowserStatus`, `handleStopBrowser`, `handleGetBrowserPorts`) have no Go tests. Auth rejection, nil browserManager guard, resolveContainerID error path, and error status codes are untested.

4. **SyncForwardersFromPorts early-return test**: The `status != StatusRunning` guard has no direct test.

## Context

Discovered by task-completion-validator during PR #570 review. The BrowserSidecar React tests (14 tests) and orphan recovery wiring were addressed before merge, but these items were not.

## Acceptance Criteria

- [ ] Add unit test in `apps/api/tests/unit/` verifying NEKO_IMAGE and NEKO_PRE_PULL reach generateCloudInit()
- [ ] Add "Neko Browser Sidecar" subsection to `docs/guides/self-hosting.md`
- [ ] Add `packages/vm-agent/internal/server/browser_handlers_test.go` for all four handlers
- [ ] Add SyncForwardersFromPorts early-return test to socat_test.go
