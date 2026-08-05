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
- [ ] Run required local reviews: `test-engineer`, `security-auditor`, `go-specialist`, and `task-completion-validator`; address findings.

## Acceptance Criteria

- Bash command text and write/edit file content are not present in transcript events or transcript JSON.
- Transcript `tool_call` events retain `id`, `name`, and a `params` field, with safe per-parameter metadata including byte length and SHA-256 hash for redacted string values.
- Tool execution behavior is unchanged: registered tools receive original raw params and produce the same tool result content as before.
- Realistic canary secrets do not appear in transcript JSON/log outputs.
- `go test ./...` passes in `packages/harness`.
- PR is opened against `main`, CI evidence is recorded, and the PR remains open/unmerged per explicit instruction.

## References

- `packages/harness/agent/loop.go`
- `packages/harness/transcript/log.go`
- `packages/harness/tools/bash.go`
- `packages/harness/tools/write_file.go`
- `packages/harness/tools/edit_file.go`
- `tasks/archive/2026-06-06-harden-harness-tool-boundaries.md`
- `tasks/archive/2026-06-25-bash-process-group-cleanup.md`
