# Post-Mortem: Environment Variable Single-Quote Stripping

**Date**: 2026-03-25

## What Broke

Project runtime environment variables set via the Settings UI arrived inside containers with literal single-quote characters wrapping the value. For example, `API_KEY` set to `sk-abc123` appeared as `'sk-abc123'` (with quotes as part of the value), breaking tool authentication and any downstream integration relying on exact env var values.

## Root Cause

Quote-style mismatch between the writer and reader in `packages/vm-agent/`:

- **Writer** (`bootstrap.go:2032`): `shellSingleQuote()` wraps values in single quotes: `export KEY='value'`
- **Reader** (`process.go:69-70`): `parseEnvExportLines()` only stripped double quotes, not single quotes

The reader was written assuming double-quoted `export KEY="value"` format, but the writer was later changed (or always used) single-quote shell escaping. The mismatch was never caught because all existing tests used double-quoted values.

## Timeline

- **Unknown**: `shellSingleQuote()` writer established as the env var serialization format
- **Unknown**: `parseEnvExportLines()` added with double-quote-only stripping
- **2026-03-25**: Bug discovered — env vars have spurious quotes in containers

## Why It Wasn't Caught

1. **No cross-component test**: There was no test that exercised the full round-trip: `shellSingleQuote()` → write to file → `parseEnvExportLines()` → inject into container
2. **Test data didn't match production**: All `TestParseEnvExportLines` test cases used double-quoted values (`export KEY="value"`), not the single-quoted format that the actual writer produces
3. **No integration test**: The only way to catch this in automated tests would be to test the actual env file content produced by `buildProjectRuntimeEnvScript()` against `parseEnvExportLines()`

## Class of Bug

**Writer/reader contract mismatch** — Two functions that form a serialize/deserialize pair were not tested together. The writer's format evolved independently from the reader's parser, and no round-trip test kept them in sync.

## Process Fix

No process rule change needed — existing rules already require:
- Round-trip integrity tests (`.claude/rules/02-quality-gates.md`, Template Output Verification)
- Cross-component capability tests (`.claude/rules/10-e2e-verification.md`)

The gap was that these rules weren't applied to this specific writer/reader pair. The fix is the round-trip test case added in this PR (the "project runtime env file format" test case that uses the actual format `buildProjectRuntimeEnvScript()` produces).
