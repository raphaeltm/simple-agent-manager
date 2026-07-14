# Restore Codex Tool Output Persistence After ACP Wrapper Upgrade

## Problem

After the maintained `@agentclientprotocol/codex-acp` wrapper upgrade, Codex command and MCP tool results stopped surviving SAM's durable message path. Version 1.1.2 emits command results in `rawOutput.formatted_output` and MCP results in `rawOutput.result` / `rawOutput.error`, while the VM-agent extractor only builds durable renderable content from ACP `ToolCallContent`. Empty content therefore becomes `(tool call)` / `(tool update)` placeholders. The generic live card also ignores `rawOutput` when content is empty.

Assistant text and task output summaries are not affected. The fix must restore meaningful bounded tool output without expanding persistence of sensitive tool input.

## Research Findings

- Idea `01KXG3XNSCH81RGKNH4KYM53B6` contains production evidence, exact 1.1.2 output shapes, and acceptance criteria.
- `packages/vm-agent/internal/acp/message_extract.go` is SAM's durable ACP compatibility boundary. It preserves structured `ToolCallContent`, but only allowlists document/library tools for `rawInput` and `rawOutput`; all other empty-content results become placeholders.
- `packages/acp-client/src/hooks/useAcpMessages.ts` retains live `rawOutput` and merges calls/updates by `toolCallId`, preserving fields missing from status-only updates.
- `packages/acp-client/src/components/ToolCallCard.tsx` computes renderability from `content` only, so a live 1.1.2-shaped result with empty content cannot expand.
- `apps/web/src/components/project-message-view/types.ts` already merges durable call/update rows by `toolCallId` and does not require updates to repeat title/tool name. Normalized content must preserve this behavior.
- `apps/api/src/durable-objects/project-data/row-schemas/messages.ts` strips generic `tool_metadata.content` in compact mode and exposes a content pointer for lazy loading; document-card `rawOutput` is separately preserved under its bounded typed-card policy.
- `packages/shared/src/agents.ts` and `apps/api/Dockerfile.vm-agent-container` reference the maintained wrapper differently and without a shared reviewed version contract.
- Retained lessons in `tasks/archive/2026-03-10-preserve-raw-tool-call-content.md` and `tasks/archive/2026-05-06-compact-mode-tool-content-lazy-load.md` require exact structured-content preservation and lazy loading rather than flattening or globally inlining output.
- Commit `805da56ed` changed the package but did not adapt the new wrapper's raw-output result contract.

## Implementation Checklist

- [ ] Add a focused, agent-agnostic ACP output normalizer at the VM-agent extraction boundary for recognized safe output shapes.
  - [ ] Convert bounded `formatted_output` command results into terminal/renderable content and retain exit status semantics.
  - [ ] Convert bounded MCP `result` content blocks and `error` values into renderable content.
  - [ ] Preserve existing structured content, file diffs, terminal blocks, and typed document/library metadata.
  - [ ] Apply the existing configurable content budget and valid UTF-8 truncation behavior.
- [ ] Keep non-allowlisted `rawInput` excluded and ensure tokens, command arguments, and file contents are neither promoted nor persisted.
- [ ] Ensure initial calls and later updates correlate by `toolCallId`, including updates with no repeated title/tool name.
- [ ] Add a bounded live-card fallback for supported safe `rawOutput` shapes so live and durable/reloaded cards show equivalent output.
- [ ] Preserve compact history and lazy-load behavior; generic output remains in content, not always-returned compact metadata.
- [ ] Define one reviewed Codex ACP wrapper version and use it consistently in runtime/catalog/container install paths.
- [ ] Add tests:
  - [ ] Go extraction fixtures shaped like maintained wrapper 1.1.2 for command stdout/exit, MCP success, and MCP error.
  - [ ] Go privacy/redaction tests proving non-library raw input and unrelated raw values remain excluded.
  - [ ] Regression tests for structured ACP content, diffs, terminals, and document/library typed-card metadata.
  - [ ] ProjectData compact/reload vertical slice showing call/update merge by `toolCallId`, meaningful lazy-loaded output, and no placeholder-only result.
  - [ ] React tests for live raw-output fallback and persisted normalized output parity.
  - [ ] Install-contract test proving every maintained-wrapper reference uses the single pinned version.
- [ ] Run mandatory mobile and desktop Playwright visual audit for the changed generic tool card.
- [ ] Run full lint, typecheck, test, build, Go tests, and relevant package checks.
- [ ] Complete task, Go, Cloudflare/ProjectData, UI/UX, security/privacy, constitution, and test specialist reviews; address findings.
- [ ] Deploy to staging and provision a real VM-backed Codex session using platform cloud-credential fallback.
  - [ ] Verify VM heartbeat and workspace access.
  - [ ] Produce recognizable shell and MCP output and confirm it appears live.
  - [ ] Reload and confirm the same output remains visible.
  - [ ] Inspect durable session messages and confirm meaningful bounded output, toolCallId correlation, and no sensitive raw input.
  - [ ] Clean up the test workspace and node.
- [ ] Open PR, wait for all CI checks, merge, and monitor production deployment to success.

## Acceptance Criteria

- Codex command and MCP outputs are meaningful and visible live, after reload, and in durable session messages.
- Tool call/update correlation is based on `toolCallId` and tolerates sparse updates.
- Existing structured content, file diffs, terminal content, document cards, compact history, and lazy loading do not regress.
- Non-allowlisted `rawInput`, command arguments, file contents, credentials, and tokens remain excluded/redacted.
- Output normalization is bounded by configurable storage limits and handles malformed/unknown shapes defensively.
- Claude and other ACP agents retain their existing behavior.
- The maintained Codex ACP wrapper is explicitly pinned to one reviewed version everywhere it is installed or invoked.
- Automated Go, ProjectData/reload vertical-slice, React, privacy, regression, and install-contract coverage passes.
- Real staging VM verification, CI, merge, and production deployment monitoring complete successfully.

## References

- SAM idea `01KXG3XNSCH81RGKNH4KYM53B6`
- `packages/vm-agent/internal/acp/message_extract.go`
- `packages/acp-client/src/components/ToolCallCard.tsx`
- `packages/acp-client/src/hooks/useAcpMessages.ts`
- `apps/web/src/components/project-message-view/types.ts`
- `apps/api/src/durable-objects/project-data/row-schemas/messages.ts`
- `.claude/rules/35-vertical-slice-testing.md`
- `tasks/archive/2026-03-10-preserve-raw-tool-call-content.md`
- `tasks/archive/2026-05-06-compact-mode-tool-content-lazy-load.md`
