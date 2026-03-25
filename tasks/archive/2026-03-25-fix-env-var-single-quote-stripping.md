# Fix Environment Variable Single-Quote Stripping

## Problem

Project runtime environment variables set via the Settings UI arrive inside the container with literal single-quote characters wrapping the value. For example, setting `API_KEY` to `sk-abc123` results in the agent seeing `'sk-abc123'` (with quotes as part of the value), which breaks tool authentication.

## Root Cause

Quote-style mismatch between the writer and reader:

1. **Writer** — `packages/vm-agent/internal/bootstrap/bootstrap.go:1979` calls `shellSingleQuote()` to write env vars to `/etc/sam/project-env`:
   ```
   export API_KEY='sk-abc123'
   ```

2. **Reader** — `packages/vm-agent/internal/acp/process.go:69-70` (`parseEnvExportLines()`) only strips **double quotes**, not single quotes:
   ```go
   if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
       value = value[1 : len(value)-1]
   }
   ```

3. The quoted value is then passed via `docker exec -e "KEY='value'"` into the container, so the agent sees literal quotes in the env var.

## Research Findings

- `shellSingleQuote()` at `bootstrap.go:2032` wraps values in single quotes and escapes embedded single quotes via `'` → `'"'"'`
- `parseEnvExportLines()` at `process.go:52` parses the export lines but only handles double-quote stripping
- `ReadContainerEnvFiles()` at `process.go:38` uses `parseEnvExportLines()` to read both `/etc/sam/env` and `/etc/sam/project-env`
- Existing tests in `gateway_test.go` cover double-quoted values, unquoted values, comments, blank lines, and malformed lines — but no single-quoted cases

## Implementation Checklist

- [x] Update `parseEnvExportLines()` in `process.go` to handle single-quoted values
  - Add `else if` branch detecting single quotes as delimiters
  - Strip outer single quotes
  - Reverse `shellSingleQuote` escaping (`'"'"'` → `'`)
- [x] Update function doc comment to mention single-quote support
- [x] Add test cases to `TestParseEnvExportLines` in `gateway_test.go`:
  - Simple single-quoted value
  - Single-quoted value with embedded single quote
  - Full project-env file format (matching `buildProjectRuntimeEnvScript()` output)
- [ ] Run all Go tests and confirm passing
- [ ] Add preflight evidence to PR description
- [ ] Run specialist reviews (go-specialist, test-engineer)
- [ ] Deploy to staging and verify
- [ ] Update PR with proper template and merge

## Acceptance Criteria

- [ ] `parseEnvExportLines()` correctly strips single quotes from values
- [ ] Embedded single quotes (escaped as `'"'"'`) are correctly restored
- [ ] All existing tests continue to pass (no regressions)
- [ ] New tests cover the single-quote scenarios
- [ ] PR passes all CI checks including Preflight Evidence

## References

- `packages/vm-agent/internal/acp/process.go` — the fix location
- `packages/vm-agent/internal/acp/gateway_test.go` — test location
- `packages/vm-agent/internal/bootstrap/bootstrap.go:2032` — `shellSingleQuote()` writer
