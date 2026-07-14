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

- [x] Add a focused, agent-agnostic ACP output normalizer at the VM-agent extraction boundary for recognized safe output shapes.
  - [x] Convert bounded `formatted_output` command results into terminal/renderable content and retain exit status semantics.
  - [x] Convert bounded MCP `result` content blocks and `error` values into renderable content.
  - [x] Preserve existing structured content, file diffs, terminal blocks, and typed document/library metadata.
  - [x] Apply the existing configurable content budget and valid UTF-8 truncation behavior.
- [x] Keep non-allowlisted `rawInput` excluded and ensure tokens, command arguments, and file contents are neither promoted nor persisted.
- [x] Ensure initial calls and later updates correlate by `toolCallId`, including updates with no repeated title/tool name.
- [x] Add a bounded live-card fallback for supported safe `rawOutput` shapes so live and durable/reloaded cards show equivalent output.
- [x] Preserve compact history and lazy-load behavior; generic output remains in content, not always-returned compact metadata.
- [x] Define one reviewed Codex ACP wrapper version and use it consistently in runtime/catalog/container install paths.
- [x] Add tests:
  - [x] Go extraction fixtures shaped like maintained wrapper 1.1.2 for command stdout/exit, MCP success, and MCP error.
  - [x] Go privacy/redaction tests proving non-library raw input and unrelated raw values remain excluded.
  - [x] Regression tests for structured ACP content, diffs, terminals, and document/library typed-card metadata.
  - [x] ProjectData compact/reload vertical slice showing call/update merge by `toolCallId`, meaningful lazy-loaded output, and no placeholder-only result.
  - [x] React tests for live raw-output fallback and persisted normalized output parity.
  - [x] Install-contract test proving every maintained-wrapper reference uses the single pinned version.
- [x] Run mandatory mobile and desktop Playwright visual audit for the changed generic tool card.
- [x] Run full lint, typecheck, test, build, Go tests, and relevant package checks.
- [x] Complete task, Go, Cloudflare/ProjectData, UI/UX, security/privacy, constitution, and test specialist reviews; address findings.
- [x] Record staging status and explicit user waiver after local/contract validation.
  - [x] Staging deployment workflow, migrations, health, and smoke checks passed.
  - [x] User explicitly waived the remaining real-VM/browser staging checks on 2026-07-14 in favor of documentation, local experiments, and high-quality tests.
  - [x] Stop the authoritative staging validator before it changed credentials or provisioned another VM.
- [x] Open PR, wait for all CI checks, merge, and monitor production deployment to success.

## Validation Evidence

- PR #1580 passed every CI, SonarCloud, VM-agent E2E/integration, smoke, Playwright, build, lint, typecheck, and test gate; squash-merged as `b438270c3ebe37c7492ba93a8cf157319fc52d66`.
- Production deployment workflow `29337644219` completed successfully, including VM-agent artifact publication, D1 backup/migration integrity, API/web deployment, and health checks; production API and web endpoints returned HTTP 200.
- Focused Go extraction/privacy tests pass for real Codex ACP 1.1.2 command, MCP result/error, sparse update, structured-content, terminal-reference, bounded/cyclic, and sensitive-object cases.
- Shared install-contract, ACP React rendering, ProjectData compact/lazy reload, and web call/update merge tests pass.
- Repository lint has no errors (existing warnings only), TypeScript typecheck passes, and the repository test/build pipeline completed without feature errors.
- Broad `go test ./internal/acp/...` exposes two crash-recovery callback timing failures that reproduce unchanged on clean `main`; tracked separately in `tasks/backlog/2026-07-14-stabilize-codex-crash-recovery-reporting-tests.md`. The focused extraction suite passes.
- Mobile 375×667 and desktop 1280×800 Playwright audits pass with no overflow or interaction regression.
- Specialist verdicts:
  - Task completion: implementation complete; lifecycle remains open through staging, PR, merge, and production monitoring.
  - Go: PASS after bounded deterministic unknown-object rendering.
  - Security/privacy: PASS after pre-serialization bounds and sensitive-key redaction.
  - Cloudflare/ProjectData: PASS; no schema/migration/binding changes, compact/lazy semantics preserved.
  - UI/UX: PASS; live and reloaded presentation is consistent on mobile and desktop.
  - Constitution: PASS; wrapper version is a centralized protocol compatibility pin and existing content budgets are reused.
  - Test engineering: PASS; required unit, contract, regression, privacy, and vertical-slice categories are represented.
- Staging deploy workflow `29330080419` succeeded, including VM-agent artifact upload, migrations/data-integrity checks, health check, and smoke tests.
- Staging D1 confirms enabled Hetzner platform credential `01KNY6DC06C9QCYQM0389NAGNT` for cloud-provider fallback.
- A supplementary staging run (`01KXG7WZVZ5WQ3PM9DXF4FXBM4`) exercised a real Codex VM and confirmed meaningful shell and actual MCP output in durable non-compact messages, sparse `toolCallId` correlation, compact/lazy loading, privacy, heartbeat/workspace access, and cleanup. Its cloud node used a user credential, so it is supplementary rather than proof of platform fallback.
- Two corrective platform-fallback attempts proved the staging Hetzner node attribution and heartbeat path but could not start Codex for the credentialless secondary user because that user had no OpenAI agent key. Failed resources were stopped/cleaned by the validators.
- Authoritative validator `01KXGASVD9WZTBDFMSFPZKXSR8` was stopped before credential mutation or VM provisioning when the user explicitly waived the remaining real-VM/browser staging checks on 2026-07-14.

## Acceptance Criteria

- Codex command and MCP outputs are meaningful and visible live, after reload, and in durable session messages.
- Tool call/update correlation is based on `toolCallId` and tolerates sparse updates.
- Existing structured content, file diffs, terminal content, document cards, compact history, and lazy loading do not regress.
- Non-allowlisted `rawInput`, command arguments, file contents, credentials, and tokens remain excluded/redacted.
- Output normalization is bounded by configurable storage limits and handles malformed/unknown shapes defensively.
- Claude and other ACP agents retain their existing behavior.
- The maintained Codex ACP wrapper is explicitly pinned to one reviewed version everywhere it is installed or invoked.
- Automated Go, ProjectData/reload vertical-slice, React, privacy, regression, and install-contract coverage passes.
- Automated/local compatibility verification, CI, merge, and production deployment monitoring complete successfully; the remaining real-VM/browser staging checks were explicitly waived by the user on 2026-07-14.

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
