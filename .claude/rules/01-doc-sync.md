# Documentation Sync & Code Integrity

## Code Is The Source Of Truth

When code and documentation conflict, the CODE is always correct. Documentation drifts; code does not lie.

However, this does NOT excuse stale documentation:

## Mandatory Documentation Sync (Enforced On Every Change)

After writing or modifying ANY code, you MUST update ALL documentation that references the changed behavior IN THE SAME COMMIT. There are NO exceptions and NO deferrals.

This includes but is not limited to:
- `docs/guides/self-hosting.md` — setup instructions, permissions, configuration
- `docs/architecture/` — architecture decisions, credential models
- `specs/` — feature specifications, data models
- `AGENTS.md` — development guidelines, API endpoints, environment variables
- `CLAUDE.md` — active technologies, recent changes
- `README.md` — if user-facing behavior changed

### How To Comply

1. **Before committing**: Search all docs for references to what you changed (grep for function names, endpoint paths, permission names, env vars, etc.)
2. **Update every match**: If a doc says "Read-only" but the code now does "Read and write", fix the doc
3. **Include doc changes in the same commit**: Do NOT create separate "docs update" commits after the fact
4. **If unsure whether a doc is affected**: Read it. It takes seconds. The cost of stale docs is much higher.

### Why This Matters

Stale documentation causes real user-facing failures. Users follow setup guides that reference incorrect permissions, wrong URLs, or outdated configuration — and then things break in ways that are hard to debug.

## No Legacy / Dead Code

This project is pre-production. Do not keep "legacy" code paths that are not used.
- If code, files, routes, scripts, or configs are no longer referenced by the active architecture, remove them in the same change.
- When replacing an implementation, update all related docs and instructions to point only to the current path.

## Documentation & File Naming

- **Location**: Never put documentation files in package roots
  - Ephemeral working notes: `docs/notes/`
  - Permanent documentation: `docs/`
  - Feature specs and design docs: `specs/<feature>/`
- **Naming**: Use kebab-case for all markdown files
  - Good: `phase8-implementation-summary.md`
  - Bad: `PHASE8_IMPLEMENTATION_SUMMARY.md`
- **Exceptions**: Only `README.md`, `LICENSE`, `CONTRIBUTING.md`, `CHANGELOG.md` use UPPER_CASE
