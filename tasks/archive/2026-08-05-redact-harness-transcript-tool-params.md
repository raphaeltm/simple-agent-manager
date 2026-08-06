# Redact harness transcript tool params

## Problem Statement

`packages/harness/agent/loop.go` currently appends raw LLM tool parameters to transcript `tool_call` events. For tools such as `bash`, `write_file`, and `edit_file`, those parameters can contain command text or file content with credentials, tokens, private keys, or other secrets. Transcripts and JSON/log outputs must be safe by construction without changing tool execution behavior.

## Research Findings

- `packages/harness/agent/loop.go` logs raw `call.Params` as `tool_call.data.params` before dispatching the tool.
- Tool execution flows through `registry.Dispatch(ctx, call)` and must continue to receive the original `call.Params`.
- `packages/harness/transcript/log.go` provides additive JSON transcript serialization; compatibility is best preserved by retaining `id`, `name`, and a `params` field while changing the persisted value to a redacted summary object.
- Sensitive tool parameters:
  - `bash.command` can include inline tokens, auth headers, env assignments, and shell-expanded secret values.
  - `write_file.content` can persist arbitrary file content.
  - `edit_file.old_string` and `edit_file.new_string` can persist existing or replacement secret-bearing content.
- Safe debugging value can be retained with length and deterministic hash metadata for redacted values; no raw command or file/edit content needs to be stored.
- Existing harness security tasks (`tasks/archive/2026-06-06-harden-harness-tool-boundaries.md`, `tasks/archive/2026-06-25-bash-process-group-cleanup.md`) emphasize boundary safety, deterministic tests, and preserving existing execution behavior.

## Implementation Checklist

- [x] Add a transcript-side tool parameter summarizer/redactor in `packages/harness` that never stores raw bash command or write/edit file content.
- [x] Preserve raw tool params for execution and LLM tool-result flow.
- [x] Preserve additive transcript compatibility by keeping tool call `id`, `name`, and `params`, and adding safe length/hash metadata.
- [x] Add realistic canary-secret regression tests proving transcript JSON excludes secrets for bash, write_file, and edit_file parameters.
- [x] Add tests proving tool execution still receives raw params and output behavior remains unchanged.
- [x] Add or update log-output tests proving canaries are absent from JSON serialization.
- [x] Run `gofmt` and focused Go tests for `packages/harness`.
- [x] Run required local reviews: `test-engineer`, `security-auditor`, `go-specialist`, `task-completion-validator`, `constitution-validator`, and `doc-sync-validator`; address findings.

## Acceptance Criteria

- Bash command text and write/edit file content are not present in transcript events or transcript JSON.
- Unsupported/custom/cyclic parameter values are summarized with opaque non-reversible metadata and never via user-controlled `String`/`GoString`/formatting methods.
- Transcript `tool_call` events retain `id`, `name`, and a `params` field, with safe per-parameter metadata including byte length and SHA-256 hash for redacted string values.
- Tool execution behavior is unchanged: registered tools receive original raw params and produce the same tool result content as before.
- Realistic canary secrets do not appear in transcript JSON/log outputs.
- `go test ./...` passes in `packages/harness`.
- Existing PR is updated against `main`, CI evidence is recorded, and the PR is merged after explicit authorization.

## References

- `packages/harness/agent/loop.go`
- `packages/harness/transcript/log.go`
- `packages/harness/tools/bash.go`
- `packages/harness/tools/write_file.go`
- `packages/harness/tools/edit_file.go`
- `tasks/archive/2026-06-06-harden-harness-tool-boundaries.md`
- `tasks/archive/2026-06-25-bash-process-group-cleanup.md`


## Validation Evidence

- `go test ./transcript` passed in `packages/harness` after replacing the unsafe marshal-failure fallback.
- `go test ./...` passed in `packages/harness`.
- `go vet ./...` passed in `packages/harness`.
- `go test -race ./...` passed in `packages/harness`.
- `git diff --check` passed.
- Regression tests cover unsupported custom values, nested array/map values, cyclic maps, deterministic summaries, non-invocation of `String`/`GoString`, and absence of canary secrets from summary/transcript JSON.
- Staging verification: intentionally skipped by Raphaël’s explicit instruction because this is an experimental, Go-only `packages/harness` change; staging was not deployed to or mutated.

## Specialist Review Evidence

| Reviewer | Status | Outcome |
|---|---|---|
| go-specialist | PASS | Scoped Go review passed: `summarizeToolParamValue` preserves normal string/JSON behavior, replaces marshal-failure fallback with deterministic opaque metadata, uses idiomatic `errors.As` and `reflect.TypeOf`, and `go test`/`go vet`/`go test -race` pass. |
| security-auditor | PASS | Security review passed: unsupported/custom/cyclic values no longer call user-controlled formatting or copy raw content before hashing; canary-bearing `String`/`GoString` methods are not invoked; transcript JSON remains canary-free. |
| test-engineer | PASS | Test review passed: regressions cover realistic unsupported custom values, nested arrays/maps, cyclic maps, deterministic behavior, normal string/JSON summaries, and transcript JSON canary absence. |
| task-completion-validator | PASS | Completion validation passed against the SAM task description and actual diff: requested unsafe fallback fix is implemented; acceptance criteria map to automated tests; UI/backend and multi-resource checks are N/A. |
| constitution-validator | PASS | Principle XI review passed: no deployment/business URLs, timeouts, limits, env vars, or configurable identifiers added; new failure strings are fixed schema markers and canaries are test-only. |
| doc-sync-validator | PASS | Doc sync review passed: no public API/UI/env/deployment contract changed; archive and PR evidence were updated for the new fallback hardening. |

## PR / Merge Constraint

PR #1739 is updated on existing branch `sam/redact-harness-tool-parameters-09wycj`. The earlier do-not-merge constraint was explicitly lifted for the authorized backlog cleanup; merge after current local reviews, required Go/race tests, and CI pass.
