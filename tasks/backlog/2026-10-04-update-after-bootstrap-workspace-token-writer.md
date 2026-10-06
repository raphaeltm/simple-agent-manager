# Audit the workspace token write in UpdateAfterBootstrap

## Problem

`Server.UpdateAfterBootstrap` (`packages/vm-agent/internal/server/server.go`) writes
`cfg.CallbackToken` into the boot workspace's `WorkspaceRuntime.CallbackToken` directly. It
bypasses `adoptWorkspaceCallbackTokenLocked` (never adopt an earlier-expiring token, never adopt
another workspace's or a node-scoped token) and the persist-then-propagate step that every other
writer of the runtime token now uses. It also refreshes message reporter tokens
(`setTokenAllReporters`) before the write, so reporters get the old value.

It is unclear which token `cfg.CallbackToken` holds at that point. The bootstrap token data carries
a callback token, and if that is node-scoped, the boot workspace would hold a node token that every
workspace callback rejects.

## Context

Found by the test review of workspace callback-token renewal
(`tasks/archive/2026-10-04-workspace-callback-token-renewal.md`). That task enumerated four writers
of the runtime token and routed the other three through the adopt/persist/propagate path. This one
runs once at boot, before any token is old enough to renew, so it does not race renewal in
practice.

## Acceptance Criteria

- [ ] Establish which token scope `cfg.CallbackToken` holds when `UpdateAfterBootstrap` runs, and
      for which node types `cfg.WorkspaceID` is set
- [ ] Route the write through the shared adopt/persist/propagate path, or remove it if it is dead
- [ ] Test that drives `UpdateAfterBootstrap` and asserts the runtime, the reporter and every
      SessionHost end up with the same token
