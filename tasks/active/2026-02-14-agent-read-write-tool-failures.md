# Agent Read/Write Tool Calls Always Fail

**Created**: 2026-02-14
**Priority**: High
**Relates to**: ACP gateway, `packages/vm-agent/internal/acp/gateway.go`

## Summary

Agent Read and Write tool calls always fail. The root cause is **not** a permissions issue — it's a capability contract violation. The gateway declares `ReadTextFile: true, WriteTextFile: true` during ACP initialization but the actual handlers are stubs that return errors.

## Root Cause (Confirmed via code inspection)

**Declaration** (`gateway.go` ~line 528):
```go
ClientCapabilities: acpsdk.ClientCapabilities{
    Fs: acpsdk.FileSystemCapability{ReadTextFile: true, WriteTextFile: true},
},
```

**Implementation** (`gateway.go` ~line 971):
```go
func (c *gatewayClient) ReadTextFile(_ context.Context, _ acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
    return acpsdk.ReadTextFileResponse{}, fmt.Errorf("ReadTextFile not supported by gateway")
}

func (c *gatewayClient) WriteTextFile(_ context.Context, _ acpsdk.WriteTextFileResponse) (acpsdk.WriteTextFileResponse, error) {
    return acpsdk.WriteTextFileResponse{}, fmt.Errorf("WriteTextFile not supported by gateway")
}
```

The agent (Claude Code) sees the capability flag, attempts to use Read/Write tools, and gets errors every time.

## Fix Options

### Option 1: Implement the capabilities (Recommended)
- Implement real `ReadTextFile` and `WriteTextFile` handlers
- Use `docker exec` to read/write files in the devcontainer (same pattern as git operations in `git.go`)
- Path sanitization: reuse `sanitizeFilePath()` from `git.go`
- Respect `GIT_FILE_MAX_SIZE` for read size limits

### Option 2: Don't claim support
- Set `ReadTextFile: false, WriteTextFile: false` in the Initialize call
- Agent will fall back to Bash tool with `cat`/`echo` instead
- Worse UX but simpler — could be a quick interim fix

## Notes

- The permission mode system (`default`/`acceptEdits`/`bypassPermissions`) is separate and working correctly
- The `RequestPermission` handler currently auto-approves all requests regardless of mode
- This is purely about the file system capability contract, not tool approval
