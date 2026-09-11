# Claude Instruction Context Optimization

## Problem

Claude sessions in SAM are loading too much repository instruction context. In the parent session, Claude identified the main pressure points, then got stuck compacting while trying to apply the fixes. The always-loaded context includes a long `CLAUDE.md` Recent Changes section and dozens of root `.claude/rules/*.md` files, many of which apply only to a specific package, app, or specialist workflow.

## Research Findings

- Parent session `39705895-bd03-4aa6-b089-c2a5605fa1a1` ended after Raphaël said "Do all of it"; the assistant then repeatedly emitted compaction messages before durable edits.
- Root `CLAUDE.md` still contains a long `Recent Changes` block. Raphaël explicitly said agents should not use `CLAUDE.md` as the recent-change source; use the changelog skill or project knowledge instead.
- Root `.claude/rules` has 72 markdown files totaling about 9,100 lines. The repo's doc-sync validator describes these as auto-loaded Claude Code behavioral rules.
- Several app/package `AGENTS.md` files already summarize scoped rules, but those files do not reduce Claude's root `.claude/rules` load.
- Existing path-scoped `AGENTS.md` files cover `apps/api`, `apps/web`, `apps/www`, `apps/tail-worker`, `packages/shared`, `packages/providers`, `packages/cloud-init`, `packages/acp-client`, `packages/terminal`, `packages/ui`, and `packages/vm-agent`.
- External best-practice check after initial PR creation: OpenAI Codex docs recommend short practical `AGENTS.md`, nested/local guidance, and skills for progressive disclosure; Anthropic docs recommend deliberate compaction/context management, avoiding context bloat, and keeping skill references shallow.

## Implementation Checklist

- [x] Replace `CLAUDE.md` Recent Changes with a short pointer to the changelog skill.
- [x] Preserve recent-change detail in the changelog skill instead of root `CLAUDE.md`.
- [x] Move domain-specific Claude rules into path-scoped `.claude/rules` directories.
- [x] Leave a compact root routing index for scoped rules.
- [x] Consolidate overlapping root rule guidance where practical.
- [x] Update task and workflow state as changes land.
- [x] Add explicit context-loading policy to Claude and Codex steering docs.
- [x] Run focused validation for markdown links, moved references, and git cleanliness.
- [x] Add a measurement command for startup and scoped-rule instruction surfaces.
- [x] Update `/do` command and Codex do skill text to route through selective scoped-rule loading.

## Implementation Notes

- Root `CLAUDE.md` plus direct root `.claude/rules/*.md` dropped from 9,419 lines before the change to 2,823 lines after consolidation and follow-up context-loading policy.
- Added `apps/*/.claude/rules/` and `packages/*/.claude/rules/` scoped copies for UI, API/DO/Cloudflare, VM agent, provider, cloud-init, shared model catalog, ACP client, terminal, UI package, and CLI rules.
- Preserved the full historic quality-gate body at `.agent-instructions/reference/rules/02-quality-gates-full.md` and replaced root `02-quality-gates.md` with a compact summary.
- Preserved full staging/debugging/cross-boundary testing rules in `.agent-instructions/reference/rules/*-full.md` and replaced the root copies with compact summaries.
- Added `.claude/rules/00-rule-routing.md` to explain scoped rule locations.
- Added `pnpm quality:agent-context-budget`, which measures Codex startup docs, Claude root surface, root rule stubs, `apps/api/AGENTS.md`, and worst-case API scoped-rule bulk loads. Latest measurement: `apps/api/AGENTS.md` is ~417-477 estimated tokens; bulk-loading all API scoped rules is ~52.9k-60.4k estimated tokens.
- Updated `.claude/commands/do.md` and `.agents/skills/do/SKILL.md` so `/do` tells agents to use `00-rule-routing.md` and only load scoped rules for changed paths.
- Moved detailed recent-change content from root `CLAUDE.md` into `.claude/skills/changelog/SKILL.md`.
- Validation: checked 365 markdown files for missing `.claude` markdown references; none found.

## Acceptance Criteria

- Root `CLAUDE.md` no longer embeds long recent-change narratives.
- Root `.claude/rules` line count is materially reduced while preserving the moved rule files.
- Path-scoped rules exist under the app/package directory they apply to.
- Root instructions explain where to find scoped rules without loading all of them.
- Claude and Codex steering docs explicitly direct agents to load scoped instructions, skills, and exact references instead of bulk-reading broad context.
- No references point to missing files after the move.
- Agent context-budget changes are measurable with `pnpm quality:agent-context-budget`.
- `/do` no longer instructs agents to bulk-read `.claude/rules/`.
