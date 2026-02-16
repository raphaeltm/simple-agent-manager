# Wire agent settings through ACP protocol (SetSessionModel + SetSessionMode)

**Created**: 2026-02-16
**Status**: backlog

## Problem

Agent settings (model selection, permission mode) are saved to the DB and fetched by the VM agent, but never applied via the ACP protocol:

- **Model**: `ANTHROPIC_MODEL` env var is set, which adds the model to the available list, but `SetSessionModel()` is never called — so the agent stays on its default model.
- **Permission mode**: Stored on the Gateway struct and logged, but `SetSessionMode()` is never called — the agent always runs in `default` mode.
- **Missing modes**: The agent supports 5 modes (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`) but our UI only exposes 3.

## Root Cause

Verified via local ACP test harness (`packages/vm-agent/cmd/test-acp-model/`):
- `ANTHROPIC_MODEL` env var adds to available models but doesn't auto-select
- `SetSessionModel("sonnet")` after `NewSession()` correctly switches the model
- `SetSessionMode("bypassPermissions")` after `NewSession()` correctly switches the mode

## Solution

### 1. gateway.go — Add ACP protocol calls after session creation

Add `applySessionSettings()` helper that calls:
- `SetSessionModel(sessionId, modelId)` when settings.Model is non-empty
- `SetSessionMode(sessionId, modeId)` when settings.PermissionMode is non-empty and != "default"

Call after both `NewSession()` and `LoadSession()` succeed.

Both calls are non-fatal (log and continue on failure) — consistent with existing graceful degradation pattern.

### 2. shared constants/types — Add plan and dontAsk modes

- `packages/shared/src/constants.ts` — Add to `VALID_PERMISSION_MODES`
- `packages/shared/src/types.ts` — Update `AgentPermissionMode` type

### 3. Tests

- Update gateway tests for SetSessionModel/SetSessionMode calls
- Verify calls happen with correct params when settings provided
- Verify calls are skipped when settings are empty/default

### 4. Docs

- Update `CLAUDE.md` + `AGENTS.md` Recent Changes
- Remove old `scripts/test-model-setting.sh` (replaced by Go test harness)

### 5. Cleanup

- Check if debug commit `50b36a9` has leftover debug-only code to remove

## Checklist

- [ ] Implement `applySessionSettings()` in gateway.go
- [ ] Call after NewSession and LoadSession paths
- [ ] Add lifecycle reporting for SetSessionModel/SetSessionMode
- [ ] Add `plan` and `dontAsk` to shared constants/types
- [ ] Update/add gateway unit tests
- [ ] Delete `scripts/test-model-setting.sh`
- [ ] Update CLAUDE.md + AGENTS.md (Recent Changes, sync)
- [ ] Verify with test harness locally
- [ ] Push, CI green, merge, verify prod
