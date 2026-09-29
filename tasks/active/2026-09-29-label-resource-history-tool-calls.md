# Label Resource-History Tool Calls

## Problem

Resource-history tool spans are currently stored as the generic `acp_tool_call` kind. The session Resources drawer and both `get_resource_history` MCP surfaces therefore cannot identify which tool overlapped a CPU or memory spike. The span pipeline must retain the ACP tool kind and stable tool name while preserving the resource-history privacy contract: tool titles, inputs, commands, outputs, paths, environment values, and prompts must never enter the uploaded payload.

## Research Findings

- `SessionHost.applyACPToolCallLifecycle` is the real ACP lifecycle entry point. It currently reduces notifications to tool-call ID and status before calling `ToolLifecycleObserver`, so kind/name must be extracted there from the ACP notification rather than injected later in collector tests.
- ACP initial tool calls carry a concrete `Kind` and metadata map. Patch updates may omit status/kind/name, so the collector must retain metadata from the initial edge and avoid erasing it on sparse updates.
- `message_extract.go` already reads `_meta.claudeCode.toolName`, but its chat-specific helper can fall back to the ACP title. Resource history must use a metadata-only helper because Bash titles can contain complete command lines.
- `resourcehistory.Collector` hashes raw tool-call IDs and builds gzip JSON chunks locally. A regression test can drive an actual ACP `session/update` through `sessionHostClient`, let the collector upload to an HTTP test server, decompress that request, and prove the command canary is absent.
- The API validates the outer callback body before decompressing the chunk, then normalizes decoded samples/spans in `workspace-resource-history.ts`. The decoded-chunk normalization is the correct API boundary for allowlisting ACP kinds and bounding UTF-8 tool names.
- Tool span types already permit an optional `toolName`, but normalization currently returns unvalidated span objects. Old chunks without the new fields must remain readable.
- Both MCP definitions promise that commands and tool args are omitted. Their descriptions and returned notes should state that kind/name are available when reported by the VM agent without weakening that promise.
- The web drawer currently renders `span.kind || 'tool'`. It needs a label preference of bounded tool name, then ACP kind, then the legacy fallback, and its Playwright fixture must cover named, kind-only, and legacy spans at mobile and desktop widths.
- This task overlaps sibling work in `collector.go`, the API resource-history service, and the drawer. The branch must rebase on current `origin/main` before each shared-file push and preserve additive sibling fields.

## Implementation Checklist

- [x] Extend the VM-agent tool lifecycle observer and collector to retain ACP kind and metadata-derived tool name across initial, patch, terminal, and reconciled tool-call edges.
- [x] Keep resource-history extraction metadata-only; never pass ACP title or raw input/output into the observer or collector.
- [x] Add a real-path Go regression test that drives a Bash ACP notification through `sessionHostClient`, captures the collector upload, verifies kind/name, and proves the full command canary is absent.
- [x] Normalize decoded tool spans at the API boundary: allow known ACP kinds, omit invalid values, trim and UTF-8 length-cap tool names using configurable resource-history limits, and preserve legacy spans.
- [x] Cover valid, oversized, malformed, and legacy tool-span payloads through callback/storage/read tests.
- [x] Carry optional kind/name through API response types, both MCP tool surfaces, and privacy/correlation notes.
- [x] Render tool name first, ACP kind second, and a legacy `tool` fallback in the Resources drawer without breaking old VM-agent chunks.
- [x] Update web behavioral/Playwright fixtures and assertions for named, kind-only, legacy, long-name, dense, empty, and error states.
- [x] Run the focused Go, API, MCP, and web test suites plus lint/typecheck/build gates.
- [x] Run Playwright visual audits at 375x667 and 1280x800, inspect screenshots, and verify no horizontal overflow or clipping.
- [x] Run task-completion, Go, Cloudflare, UI/UX, constitution, and test specialist reviews; address all blocking findings.
- [x] Rebase on `origin/main`, deploy to staging, provision a current VM agent, verify upload/read/MCP/UI behavior end to end, capture screenshots, and clean up the workspace/node.

## Acceptance Criteria

- A real ACP tool call with kind `execute` and metadata tool name `Bash` produces a resource-history span containing only the hashed ID, `execute`, `Bash`, timing/correlation fields, and no title, command, input, or output.
- The callback rejects or normalizes untrusted decoded span metadata so only supported ACP kinds and bounded valid tool names reach stored/read responses.
- Session API reads and both `get_resource_history` MCP surfaces expose the optional tool kind/name while maintaining their no-command privacy promise.
- The Resources drawer displays `Bash` for a named tool span, a readable kind fallback for a kind-only span, and `tool` for a legacy span with neither field.
- Existing chunks and uploads from old VM agents remain readable and render with a fallback label.
- The real-path privacy test fails if ACP title or raw input begins flowing into the resource-history upload.
- Mobile and desktop screenshots show readable, unclipped tool-window labels with no horizontal overflow.

## References

- `packages/vm-agent/internal/acp/session_host_harness_work.go`
- `packages/vm-agent/internal/acp/message_extract.go`
- `packages/vm-agent/internal/resourcehistory/collector.go`
- `apps/api/src/routes/projects/workspace-resource-history-callback.ts`
- `apps/api/src/services/workspace-resource-history.ts`
- `apps/api/src/durable-objects/sam-session/tools/get-resource-history.ts`
- `apps/api/src/routes/mcp/tool-definitions-project-awareness.ts`
- `apps/web/src/components/chat/SessionResourceHistoryDrawer.tsx`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `tasks/archive/2026-09-20-workspace-resource-history.md`
