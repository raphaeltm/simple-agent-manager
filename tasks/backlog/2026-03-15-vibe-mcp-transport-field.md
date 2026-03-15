# Fix: Add transport field to Vibe MCP server config

## Problem

When starting a Mistral Vibe agent session with MCP servers configured, the ACP session creation fails with:

```
ACP new session failed: {"code":-32602,"message":"Invalid params","data":{"errors":[{"ctx":{"discriminator":"'transport'"},"input":{"headers":{"Authorization":"Bearer ..."},"name":"sam-mcp-0","url":"https://api.simple-agent-manager.org/mcp"},"msg":"Unable to extract tag using discriminator 'transport'","type":"union_tag_not_found"}]}}
```

Mistral Vibe uses a Pydantic discriminated union on the `transport` field to distinguish MCP server types (`http`, `streamable-http`, `stdio`). Our generated `config.toml` omits this field entirely.

## Research Findings

- **Root cause**: `generateVibeConfig()` in `packages/vm-agent/internal/acp/gateway.go:778` generates `[[mcp_servers]]` entries without a `transport` field.
- **Mistral Vibe docs** (via Context7) confirm `transport` is required and must be one of `"http"`, `"streamable-http"`, or `"stdio"`.
- Our MCP servers are HTTP endpoints, so `transport = "http"` is the correct value.
- The ACP SDK path (`buildAcpMcpServers` in `session_host.go`) is unaffected — it uses `acpsdk.McpServer` structs which handle transport internally. Only the Vibe TOML config path is broken.

## Implementation Checklist

- [x] Add `transport = "http"` to the MCP server TOML generation in `gateway.go:generateVibeConfig()`
- [x] Update `TestGenerateVibeConfig_McpServerWithToken` to assert `transport = "http"` is present
- [x] Run Go tests to verify

## Acceptance Criteria

- [ ] Vibe config TOML includes `transport = "http"` for every `[[mcp_servers]]` entry
- [ ] All existing gateway tests pass
- [ ] No other MCP server paths (ACP SDK) are affected

## References

- Mistral Vibe docs: MCP server config requires `transport` discriminator
- Error source: Pydantic validation in Mistral's ACP session creation
