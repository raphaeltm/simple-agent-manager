# SAM CLI (packages/cli)

## Purpose

The `sam` command-line client, written in Go. The entry point is `cmd/sam`; commands,
argument parsing, config and the API client live in `internal/cli`.

## Commands

```bash
make -C packages/cli build   # go build -o bin/sam ./cmd/sam
make -C packages/cli test    # go test -race -coverprofile=coverage.out -covermode=atomic ./...
```

The CLI is held to a high Go and test-quality bar. Read the rule listed below before changing it.

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

- `.claude/rules/36-cli-quality.md`: CLI Quality Bar
- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State

<!-- END GENERATED RULE INDEX -->
