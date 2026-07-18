# Harden provider/ACP boundary behavior

## Problem

Provider and ACP package boundaries need narrow, non-breaking hardening around timeout/error normalization, runtime schema validation, and typed tool-call rendering compatibility. Prior audits identified risks where unsafe/drifty inputs could cross package boundaries with only TypeScript types, provider error bodies could be unbounded or inconsistently normalized, and Codex slash-form MCP tool names could miss typed rendering paths that expect Claude double-underscore names.

## Research findings

- `packages/providers/src/provider-fetch.ts` is the shared HTTP boundary used by provider implementations. Existing provider tests already cover error serialization, classification, and fetch behavior.
- `packages/acp-client/src/runtime-validation.ts` contains runtime JSON helpers used by ACP hooks/components.
- `packages/acp-client/src/hooks/useAcpMessagePayloads.ts` extracts tool names from ACP updates and currently documents Claude-style `mcp__<server>__<tool>` fallback behavior.
- `packages/acp-client/src/components/ToolCallCard.tsx` and related tests are the likely typed tool-call rendering compatibility surface.
- `packages/shared` already contains Zod/Valibot schema patterns for shared package boundaries; any new schema helper should be exported backward-compatibly.
- `packages/harness/tools` has boundary/limit patterns for tool execution, but no broad harness changes should be made unless a concrete tested gap is found.
- Project knowledge states Codex names MCP tool calls as `<server>/<tool>`, while Claude uses `mcp__<server>__<tool>`; typed tool-card matching must handle both.

## Checklist

- [x] Add targeted provider tests proving timeout aborts and long/non-JSON error bodies are safely normalized and bounded.
- [x] Add targeted ACP/shared runtime schema validation tests for malformed boundary payloads.
- [x] Add targeted tool-call normalization tests proving both `sam-mcp/display_from_library` and `mcp__sam-mcp__display_from_library` resolve to the same typed rendering path.
- [x] Implement minimal backward-compatible helpers or checks required for those tests.
- [x] Avoid exported API removals and avoid speculative abstraction.
- [x] Run relevant package tests, lint, typecheck, build as appropriate.
- [x] Run specialist reviews: test-engineer, security-auditor, constitution-validator, and doc-sync-validator if docs/contracts change.
- [ ] Open a PR on `sam/execute-task-using-skill-4vnw0a`; do not merge.

## Acceptance criteria

- Provider HTTP boundary aborts with a bounded, normalized provider error on timeout.
- Provider HTTP boundary error details never expose unbounded response bodies.
- Runtime validation rejects malformed external package-boundary payloads with explicit errors instead of unchecked casts.
- ACP typed tool-call rendering recognizes both slash-form Codex MCP names and double-underscore Claude MCP names.
- Tests fail against the pre-remediation behavior and pass after the fix.
- PR description clearly states this is non-breaking and includes local test evidence.
