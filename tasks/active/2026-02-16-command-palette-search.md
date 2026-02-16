# Command Palette: File & Tab Search with Fuzzy Matching

**Created**: 2026-02-16
**Status**: Active
**Branch**: `feat/command-palette-search`

## Summary

Enhance the existing command palette (Cmd+K / Ctrl+K) with VS Code-style fuzzy file search and tab switching, using camelCase-aware matching with space-skipping.

## Completed

- [x] Create `fuzzy-match.ts` utility with camelCase boundary detection, word boundary scoring, consecutive bonuses, space-skipping
- [x] Write 22 fuzzy-match unit tests (camelCase, paths, spaces, scoring, edge cases)
- [x] Add `GET /workspaces/:id/files/find` VM agent endpoint (recursive flat file index, noise exclusion)
- [x] Add `getFileIndex()` API client function
- [x] Rewrite `CommandPalette.tsx` with categorized results (Tabs, Files, Commands), fuzzy matching, `HighlightedText`
- [x] Wire palette in `Workspace.tsx` (lazy file index loading, tab selection + focus, file selection)
- [x] Write 19 CommandPalette unit tests (tabs, files, commands, fuzzy matching, keyboard nav, loading state, backward compatibility)
- [x] Update CLAUDE.md and AGENTS.md (endpoint, env vars, recent changes)
- [x] All checks pass: typecheck, lint, tests (302), build

## Files Changed

| File | Action |
|------|--------|
| `apps/web/src/lib/fuzzy-match.ts` | New |
| `apps/web/tests/unit/lib/fuzzy-match.test.ts` | New |
| `packages/vm-agent/internal/server/files.go` | Modified |
| `packages/vm-agent/internal/config/config.go` | Modified |
| `packages/vm-agent/internal/server/server.go` | Modified |
| `apps/web/src/lib/api.ts` | Modified |
| `apps/web/src/components/CommandPalette.tsx` | Rewritten |
| `apps/web/src/pages/Workspace.tsx` | Modified |
| `apps/web/tests/unit/CommandPalette.test.tsx` | Rewritten |
| `CLAUDE.md` | Modified |
| `AGENTS.md` | Modified |
