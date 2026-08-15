# Curated Architecture Workspace

SAM's agent- and human-readable system model lives in `architecture/`. It is a
curated explanation of boundaries, runtime choices, flows, and lifecycles — not
an automatically generated import graph.

## When to read it

- Before planning or explaining a change that crosses clients, packages,
  services, Durable Objects, storage, or runtime boundaries.
- When a smaller agent needs bounded context instead of a repository-wide code
  search.
- When investigating a source path that may participate in a documented flow or
  lifecycle.

Start with compact queries:

```bash
pnpm --silent architecture:summary -- --json
pnpm --silent architecture:show -- <element-id> --json
pnpm --silent architecture:inbox -- --json
```

Use `pnpm architecture:serve` only when a human needs the interactive viewer or
file-backed review thread workflow.

## Maintenance contract

1. Run architecture impact analysis for changed implementation paths:

   ```bash
   pnpm architecture:impact -- <repo-relative-path> [...paths]
   ```

2. Update the workspace in the same PR when the change alters a modeled
   boundary, relationship, ordered flow, state, transition, or source anchor.
   Ordinary internal edits do not require ceremonial architecture churn.
3. Cite repository-relative source paths for behavioral claims. Use present
   tense only for behavior supported by the cited implementation.
4. Run `pnpm architecture:validate` after every workspace or thread edit.
5. Keep stable semantic IDs. Do not store canvas coordinates or other browser
   presentation state in canonical files.
6. Generated AST/LSP/import/runtime evidence may suggest changes but must never
   silently overwrite curated records.
7. Questions and replies belong in separate append-oriented files under
   `architecture/threads/`; inspect `architecture:inbox` when a task concerns
   architecture review feedback.

If a model and implementation disagree, treat that as a diagnostic: verify the
code path, then correct the stale side rather than assuming either is true.
