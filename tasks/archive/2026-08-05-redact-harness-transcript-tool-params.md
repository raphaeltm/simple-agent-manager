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
- [x] Run required local reviews: `test-engineer`, `security-auditor`, `go-specialist`, and `task-completion-validator`; address findings.

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


## Validation Evidence

- `go test ./...` passed in `packages/harness`.
- `go vet ./...` passed in `packages/harness`.
- `go test -race ./...` passed in `packages/harness`.
- `go test -cover ./...` passed in `packages/harness` with transcript package coverage at 97.1% and agent package coverage at 86.8%.
- Staging verification: not run. This is a Go-only `packages/harness` transcript serialization change with no deployed API/UI/infrastructure behavior.

## Specialist Review Evidence

| Reviewer | Status | Outcome |
|---|---|---|
| test-engineer | FAILED/TIMED OUT | Local subagent did not return after extended waits and was closed. Manual checklist review passed: capability-level test executes `write_file`, `edit_file`, and `bash` with realistic canary params, proves raw side effects occurred, then proves transcript JSON excludes canaries and includes redacted metadata. PR must carry `needs-human-review`. |
| security-auditor | FAILED/TIMED OUT | First local subagent blocked on cancelled SAM bootstrap; replacement did not return and was closed. Manual security review passed: raw tool params are summarized before transcript persistence; tool execution receives original params; tool-result redaction intentionally unchanged to keep R4 finding 3 scope. PR must carry `needs-human-review`. |
| go-specialist | FAILED/TIMED OUT | Local subagent did not return after extended waits and was closed. Manual Go review passed: helper is deterministic, has no I/O/resource ownership, uses SHA-256 over raw bytes without retaining values, and does not mutate `call.Params`. PR must carry `needs-human-review`. |
| task-completion-validator | FAILED/TIMED OUT | Local subagent did not return after extended waits and was closed. Manual validation passed: findings map to checklist items, checked items map to diff, and acceptance criteria map to automated tests. PR must carry `needs-human-review`. |

## PR / Merge Constraint

Open a targeted PR and do not merge it. Because required local reviewer subagents timed out/failed, label the PR `needs-human-review` under `.claude/rules/25-review-merge-gate.md`.
