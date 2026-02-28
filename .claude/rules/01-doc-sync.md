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
- `AGENTS.md` — agent configuration pointers
- `CLAUDE.md` — project instructions for Claude Code
- `README.md` — if user-facing behavior changed

### How To Comply

1. **Before committing**: Search all docs for references to what you changed (grep for function names, endpoint paths, permission names, env vars, etc.)
2. **Update every match**: If a doc says "Read-only" but the code now does "Read and write", fix the doc
3. **Include doc changes in the same commit**: Do NOT create separate "docs update" commits after the fact
4. **If unsure whether a doc is affected**: Read it. It takes seconds. The cost of stale docs is much higher.

### Why This Matters

Stale documentation causes real user-facing failures. Users follow setup guides that reference incorrect permissions, wrong URLs, or outdated configuration — and then things break in ways that are hard to debug.

## Spec Documentation Edit Scope

Spec files are historical records tied to a specific feature context. Apply these scope rules on every task:

1. **Working within a specific spec**: You MAY update docs under that active spec directory (e.g., `specs/014-multi-workspace-nodes/*`).
2. **Working within a specific spec**: You MUST NOT edit docs under any other spec directory.
3. **Working outside spec context**: You MUST NOT edit `specs/` documentation at all.

## Behavioral Claims Must Cite Code Paths

When writing documentation that describes what the system **does** (flow maps, architecture docs, system analysis), every behavioral claim must cite a specific code path.

### Rules

1. **Never write "X happens" without citing the function that does X.** If you cannot find the function, the behavior may not be implemented.
   - Good: "The VM agent starts Claude Code (`session_host.go:SelectAgent()`)"
   - Bad: "The VM agent starts Claude Code"

2. **Mark claims as verified or intended.** Use present tense only for behavior you have confirmed exists in code. Use future tense or explicit markers for planned behavior.
   - Verified: "The task runner creates an agent session (`task-runner.ts:handleAgentSession()`, verified)"
   - Intended: "The VM agent WILL send the initial prompt (not yet implemented — see issue #XX)"

3. **Never mix aspirational and factual claims** in the same section without clear markers. A reader must be able to distinguish "this is what the code does today" from "this is what we want the code to do."

### Why This Matters

The TDF post-mortem (`docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`) showed that flow maps and analysis documents containing uncited aspirational claims were treated as ground truth by downstream work. Eight tasks and seven PRs built on the assumption that "the VM agent starts an ACP session" because a document said so — but no code existed for it.

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
