# Harden harness tool filesystem boundaries

## Problem

`packages/harness/tools` exposes file, search, edit, and shell tools to harness agents. The current path checks are lexical and the output/search behavior is under-specified, which leaves symlink escape, nondeterministic ordering, and unbounded-output risks in a core harness primitive.

## Research Findings

- `safePath()` in `write_file.go` compares absolute lexical paths but does not canonicalize `WorkDir` or target paths through symlinks.
- `ReadFile`, `EditFile`, and `Grep` can read through a symlink file inside the workspace to content outside it.
- `Glob` has a custom `**` matcher that does not handle middle `**` segments reliably.
- `Bash`, `ReadFile`, and `Grep` need explicit output/resource limits and clear truncation/error messages.
- `Registry.Definitions()` and `Registry.Names()` are map-backed and need deterministic ordering.

## Implementation Checklist

- [x] Add a central filesystem boundary helper for canonical workdir/path validation.
- [x] Apply the helper to read, write, edit, grep, and glob tools.
- [x] Skip or reject symlinks consistently for read/search/edit/glob, and reject existing final-path symlinks for writes.
- [x] Replace/harden glob `**` matching and cover middle/root/nested cases.
- [x] Add explicit output/resource limits and truncation messages for read, grep, and bash.
- [x] Sort registry definitions/names and search outputs.
- [x] Add scenario-driven tests for symlink escapes, ordering, truncation, and invalid parameters.
- [x] Run `gofmt`, `go test ./...`, and available Go static checks from `packages/harness`.
- [x] Complete go-specialist and security-auditor reviews before PR/merge.

## Review Results

- go-specialist: PASS after addressing stricter traversal-pattern validation.
- security-auditor: PASS after addressing stricter traversal-pattern validation.
- task-completion-validator: PASS; no uncovered research findings or acceptance criteria.

## Acceptance Criteria

- Symlink escapes cannot leak file content through `read_file`, `edit_file`, `grep`, or `glob`.
- `write_file` does not follow an existing final-path symlink outside the workspace.
- `glob` supports `src/**/test/*.go`, `**/*.go`, `src/**/*.ts`, root-level matches, no-match behavior, and skipped directories.
- Tool outputs and definitions are deterministic.
- Resource limits are explicit and covered by tests.
