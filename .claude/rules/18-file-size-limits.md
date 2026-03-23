# File Size Limits

## Rule: No Single File Should Exceed 500 Lines

When creating or modifying a file, check its line count. If a file exceeds **500 lines** (excluding tests), it is a candidate for splitting. If a file exceeds **800 lines**, splitting is **mandatory** before merging.

Test files are exempt from this rule — a 1,000-line test file covering a complex module is acceptable.

### Why This Rule Exists

Large files degrade both human and AI agent productivity:
- Agents must load the entire file into context to work on any part of it, wasting context window and increasing error rates
- Code review becomes superficial — reviewers skim 2,000-line files instead of reading them
- Merge conflicts increase proportionally with file size
- State interactions between unrelated concerns become invisible

The March 2026 code audit found 27 files over 500 lines and 8 files over 1,500 lines. Several of these (`mcp.ts` at 2,638 lines, `project-data.ts` at 2,478 lines) had grown incrementally — each individual addition was reasonable, but no one enforced a ceiling.

### How to Split Files

Choose the strategy that fits the file type:

| File Type | Split Strategy | Example |
|-----------|---------------|---------|
| **Route file** | Directory with one file per resource/action group + `index.ts` barrel | `routes/mcp.ts` → `routes/mcp/session-tools.ts`, `routes/mcp/idea-tools.ts`, `routes/mcp/index.ts` |
| **Durable Object** | Extract method groups into internal modules, DO delegates | `project-data.ts` imports from `project-data/messaging.ts`, `project-data/sessions.ts` |
| **React page/component** | Extract logical sections into child components | `Workspace.tsx` → `WorkspaceTerminal.tsx`, `WorkspaceAgentPanel.tsx` |
| **Type file** | Domain-specific modules re-exported from index | `types.ts` → `types/workspace.ts`, `types/project.ts`, `types/index.ts` |
| **API client** | Split by resource domain | `api.ts` → `api/nodes.ts`, `api/projects.ts`, `api/index.ts` |
| **Service file** | Extract helper functions or sub-concerns | `tts.ts` → `tts.ts` + `tts-voices.ts` |

### Barrel File Rules

When splitting a file into a directory with multiple modules:

1. **Create an `index.ts`** that re-exports the public API — consumers should not need to change their imports
2. **Keep barrel files thin** — only `export { ... } from './module'` statements, no logic
3. **Prefer named re-exports** over `export *` — explicit exports are easier to trace and better for tree-shaking

### When Adding to an Existing Large File

If you need to add functionality to a file that is already over 500 lines:

1. **Check the line count first**: `wc -l <file>`
2. **If over 500 lines**: Split the file as part of your change. Do the split in a separate commit before your feature commit so the diff is reviewable.
3. **If your addition would push it over 500**: Split proactively in the same PR.
4. **Never rationalize**: "It's just 20 more lines" is how files reach 2,000 lines. The ceiling is the ceiling.

### Pre-Commit Check

Before committing, verify no source file exceeds the limit:

```bash
find apps/ packages/ -name '*.ts' -o -name '*.tsx' -o -name '*.go' | \
  grep -v node_modules | grep -v dist | grep -v '.test.' | grep -v '.spec.' | grep -v '_test.go' | \
  xargs wc -l | sort -rn | awk '$1 > 500 {print}'
```

If any files appear, either split them or document why the exception is justified (e.g., database schema files, generated code).

### Exceptions

These file types may exceed 500 lines with justification:
- **Database schema** (`schema.ts`) — splitting a schema across files creates import complexity without meaningful benefit
- **Generated code** — machine-generated files should not be manually split
- **Test files** — comprehensive test coverage sometimes requires long files

All exceptions must be documented in a comment at the top of the file:
```typescript
// FILE SIZE EXCEPTION: Database schema — splitting creates import complexity. See .claude/rules/18-file-size-limits.md
```
