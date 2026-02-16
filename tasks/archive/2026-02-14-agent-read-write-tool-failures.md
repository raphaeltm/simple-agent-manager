# Agent Read/Write Tool Calls Always Fail

**Created**: 2026-02-14
**Resolved**: 2026-02-16
**Priority**: High
**Status**: Resolved
**Relates to**: ACP gateway, `packages/vm-agent/internal/acp/session_host.go`

## Summary

Agent Read and Write tool calls always fail. The root cause is **not** a permissions issue — it's a capability contract violation. The gateway declares `ReadTextFile: true, WriteTextFile: true` during ACP initialization but the actual handlers are stubs that return errors.

## Root Cause (Confirmed via code inspection)

**Declaration** (`session_host.go`):
```go
ClientCapabilities: acpsdk.ClientCapabilities{
    Fs: acpsdk.FileSystemCapability{ReadTextFile: true, WriteTextFile: true},
},
```

**Original Implementation** (stubs that always errored):
```go
func (c *gatewayClient) ReadTextFile(_ context.Context, _ acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
    return acpsdk.ReadTextFileResponse{}, fmt.Errorf("ReadTextFile not supported by gateway")
}

func (c *gatewayClient) WriteTextFile(_ context.Context, _ acpsdk.WriteTextFileResponse) (acpsdk.WriteTextFileResponse, error) {
    return acpsdk.WriteTextFileResponse{}, fmt.Errorf("WriteTextFile not supported by gateway")
}
```

## Resolution

Resolved by the **agent-file-ops** feature. Option 1 (implement the capabilities) was chosen:

- `ReadTextFile` implemented using `docker exec cat <path>` inside the devcontainer
- `WriteTextFile` implemented using `docker exec tee <path>` with stdin piped content
- Handlers live on `sessionHostClient` in `session_host.go` (the old `gatewayClient` was refactored into `sessionHostClient` during the persistent-agent-sessions work)
- `FileExecTimeout` (configurable, default 30s) applied to both operations
- `FileMaxSize` (configurable, default 1MB) enforced for both read and write
- `applyLineLimit()` supports partial reads via `Line`/`Limit` params
- Null byte path validation added to prevent injection

### Hardening applied (cleanup PR)

- Added null byte validation to both `ReadTextFile` and `WriteTextFile` paths
- Added write size limit (`FileMaxSize`) to `WriteTextFile` — previously only `ReadTextFile` had a size check
- Added tests for null byte rejection, write size enforcement, and default size limits

## Notes

- The permission mode system (`default`/`acceptEdits`/`bypassPermissions`/`plan`/`dontAsk`) is separate and working correctly
- This was purely about the file system capability contract, not tool approval
- Tests in `file_ops_test.go` cover: `applyLineLimit`, path validation, container resolver failures, null byte rejection, and write size limits
