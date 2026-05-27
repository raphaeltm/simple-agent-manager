# Workspace Forward: Local Port Remapping (--local flag)

## Problem

`sam workspace <id> forward --port 3000` always binds to `localhost:3000`. If the user already has a service on port 3000, the command fails. A `--local` flag would allow remapping: `--port 3000 --local 8080` forwards remote port 3000 to local port 8080.

## Implementation

- Add `--local` as a repeatable flag (paired with `--port`)
- When `--local` is provided, use it as the listener port while keeping `--port` as the remote port for URL construction
- If `--local` count doesn't match `--port` count, error
- Update help text and tests

## Acceptance Criteria

- [ ] `sam workspace <id> forward --port 3000 --local 8080` binds to localhost:8080 and proxies to remote port 3000
- [ ] Mismatched `--port` and `--local` counts produce a clear error
- [ ] Tests cover the remapping logic
