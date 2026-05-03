# Harness Phase 1: Capable Coding Agent

## Context

The Go harness spike (`packages/harness/`) has a working agent loop with 4 tools (read_file, write_file, edit_file, bash), a mock LLM provider, and an OpenAI-compatible proxy provider. It completes toy evaluation tasks but lacks the tools and intelligence for real coding work.

This task extends the spike into a harness that can complete non-trivial coding tasks — editing real files, navigating real codebases, managing git workflows — at a quality comparable to existing coding agents.

See idea `01KQM8JT6CPHGS16Y91XJF67FS` "Revised Architecture and Phase Plan (2026-05-03)" for full context. This is Track D1.

## Acceptance Criteria

### New Coding Tools

- [ ] `grep` tool — recursive search with regex support, context lines, file type filtering. Output includes file paths, line numbers, and matched content formatted for LLM comprehension (like ripgrep output).
- [ ] `glob` tool — find files matching a pattern (e.g., `**/*.ts`, `src/**/test*`). Returns file paths relative to working directory.
- [ ] `git_status` tool — shows changed/staged/untracked files.
- [ ] `git_diff` tool — shows diff for working tree or between refs. Accepts optional path filter.
- [ ] `git_log` tool — recent commit history with configurable count, optional path filter.
- [ ] `git_commit` tool — stages specified files (or all) and commits with a message.
- [ ] `git_branch` tool — create, list, or switch branches.
- [ ] All new tools have path containment validation (same security model as existing tools).
- [ ] All new tools have unit tests with deterministic fixtures (no network).

### Tree-Sitter Integration

- [ ] Go tree-sitter bindings integrated (e.g., `github.com/smacker/go-tree-sitter`).
- [ ] TypeScript/JavaScript grammar compiled in.
- [ ] Go grammar compiled in.
- [ ] `RepoMap(dir) -> string` function that walks a directory, parses files with tree-sitter, and produces a compressed representation: file paths + function/class/method signatures (no bodies).
- [ ] Repo map output fits in ~2-4k tokens for a medium project (~200 files).
- [ ] Repo map is injected into the system prompt or first message so the agent can navigate the project.

### Context Management

- [ ] Token counting: estimate token usage for the current conversation using a tiktoken-compatible counter (or character-based estimate with a known ratio).
- [ ] Conversation compaction: when approaching a configurable context limit (e.g., 80% of max), summarize older turns into a condensed "conversation so far" block and replace them.
- [ ] Smart file reading: new `read_file` option to read line ranges (e.g., lines 50-100) instead of always reading the full file. The existing tool already supports this but the agent needs to be prompted to use it.
- [ ] The agent's system prompt instructs it to use the repo map for navigation and to read only relevant sections of large files.

### Evaluation

- [ ] At least 5 new evaluation tasks beyond the 3 existing mock fixtures, exercising:
  1. Multi-file edit across a real-ish project structure
  2. Bug fix guided by grep/test output
  3. Refactoring with git commit
  4. Navigating a large codebase (50+ files) using repo map + grep
  5. Handling a failing test (read error, find cause, fix, verify)
- [ ] Evaluations runnable with both the mock provider (deterministic) and a real model (gpt-4.1-mini via SAM AI proxy).
- [ ] At least one evaluation compared side-by-side with Claude Code output quality on the same task (manual comparison, documented in evaluation notes).

## Technical Notes

- Tree-sitter grammars are compiled into the Go binary via CGO or the pure-Go wasm approach. If CGO causes issues with static compilation (`CGO_ENABLED=0`), use the wasm-based tree-sitter bindings or a pure-Go parser. The static binary requirement (for Sandbox deployment) is non-negotiable.
- The harness binary must remain statically compilable. No dynamic library dependencies.
- Context management should be model-aware: different models have different context limits. Accept `--max-context-tokens` flag (default: 128000 for gpt-4.1-mini).
- Repo map generation should be fast (<2s for a 500-file project).
- Git tools should work in both clean and dirty working directories.

## Out of Scope

- MCP client (that's Phase 2 / Track D2)
- Sandbox integration (that's Phase 3 / Track D3)
- LSP integration (that's Phase 4)
- ACP protocol / VM agent integration (that's Phase 4)
- Multi-model prompt templates (that's Phase 5)

## References

- Existing harness: `packages/harness/`
- Idea: `01KQM8JT6CPHGS16Y91XJF67FS`
- Architecture learnings: library file `sam-harness-architecture-learnings.md`
- Aider repo-map approach: https://aider.chat/docs/repomap.html
- Go tree-sitter: https://github.com/smacker/go-tree-sitter

Execute this task using the /do skill.
