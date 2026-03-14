# Migrate Subagents to Claude Code Skills

**Created**: 2026-02-22
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Medium

## Context

We currently maintain 8 specialist subagents defined across 3 separate file structures:

1. `.claude/agents/<name>/<NAME>.md` — Claude Code subagent definitions (the actual knowledge/instructions)
2. `.agents/skills/<name>/SKILL.md` — Codex-compatible wrapper that points to the subagent
3. `.agents/skills/<name>/agents/openai.yaml` — UI metadata for Codex skill lists

Claude Code has since unified slash commands and skills into a single system (`.claude/skills/`). Our subagents can be reimplemented as native Claude Code skills, reducing per-agent file count from 3 to 1 and gaining auto-discovery, slash command invocation, and cross-tool compatibility via the Agent Skills open standard.

## Agents to Migrate

| Agent | Type | Current Tools | Fork? |
|-------|------|---------------|-------|
| constitution-validator | Read-only validator | Read, Grep, Glob, Bash | Yes |
| env-validator | Read-only validator | Read, Grep, Glob, Bash | Yes |
| doc-sync-validator | Read-only validator | Read, Grep, Glob, Bash | Yes |
| security-auditor | Read-only validator | Read, Grep, Glob, Bash | Yes |
| go-specialist | Read-only reviewer | Read, Grep, Glob, Bash | Yes |
| cloudflare-specialist | Read-only advisor | Read, Grep, Glob, Bash | Yes |
| test-engineer | Read-write (generates tests) | Read, Edit, Write, Bash, Grep, Glob | Yes |
| ui-ux-specialist | Read-write (modifies UI) | Read, Edit, Write, Bash, Grep, Glob | Yes |

## Trade-off Analysis

### Gains

- **Unified system**: 1 file per skill (`SKILL.md` + optional supporting files) instead of 3 files across 2 directories
- **Auto-discovery**: Skills loaded into context based on `description` field — Claude sees what's available without hardcoded `subagent_type` list
- **Slash command invocation**: Users and Claude can invoke `/constitution-validator` directly
- **`context: fork` for isolation**: Skills with `context: fork` run in a subagent context, preserving isolation
- **Supporting files**: Skills can bundle scripts, templates, references in their directory
- **Cross-tool compatibility**: Agent Skills open standard works across multiple AI tools
- **Dynamic context injection**: `!`command`` syntax injects live data (e.g., `git diff`) before skill runs
- **Elimination of `.agents/skills/` directory**: Remove Codex-specific wrappers entirely

### Losses

- **No `disallowedTools`**: Skills have `allowed-tools` (whitelist) but no explicit deny list. Read-only constraint relies on instructions ("do NOT modify files") rather than a hard tool block for tools not in the allowed list
- **Weaker proactive triggering**: Current subagents have strong system-prompt directives ("Use proactively when..."). Skills use description-based auto-discovery which is softer. Mitigated by `.claude/rules/` files
- **`context: fork` loses conversation history**: Forked skills don't see the conversation. Current subagents receive an explicit prompt with relevant context from the main agent
- **Context budget pressure**: Skill descriptions consume ~2% of context window (~16K chars). With 8 skills, descriptions compete for space. Current subagents don't consume context until invoked
- **Less granular auto-trigger control**: No equivalent to "always in context but only auto-invoke in certain situations"

## Implementation Plan

### Phase 1: Create Skill Structure

- [ ] Create `.claude/skills/` directory
- [ ] For each of the 8 agents, create `.claude/skills/<name>/SKILL.md` with:
  - Frontmatter: `name`, `description`, `context: fork`, `allowed-tools`, `model`
  - Body: The full instructions from the current `.claude/agents/<name>/<NAME>.md`
- [ ] For read-only validators, set `allowed-tools: Read, Grep, Glob, Bash`
- [ ] For read-write agents, set `allowed-tools: Read, Edit, Write, Bash, Grep, Glob`
- [ ] Extract long reference material into supporting files (e.g., `reference.md`, `checklist.md`)

### Phase 2: Configure Invocation Control

- [ ] Set `user-invocable: true` for all skills (users should be able to invoke any of them)
- [ ] Leave `disable-model-invocation` as `false` (default) so Claude can auto-invoke
- [ ] Review `.claude/rules/` files to ensure they reference skill invocation (e.g., "invoke `/constitution-validator`") rather than Task tool subagents
- [ ] Add explicit CLAUDE.md guidance: "After modifying env vars, invoke `/env-validator`" etc.

### Phase 3: Strengthen Proactive Triggering

- [ ] Update `.claude/rules/03-constitution.md` to reference `/constitution-validator` skill
- [ ] Update `.claude/rules/05-preflight.md` to reference skill invocation
- [ ] Consider adding `.claude/rules/10-skill-triggers.md` with explicit trigger conditions mapping (file patterns -> skills)
- [ ] Test auto-discovery by making changes in relevant areas and verifying Claude invokes the right skills

### Phase 4: Cleanup

- [ ] Remove `.claude/agents/` directory (all 8 subagent definitions)
- [ ] Remove `.agents/skills/` directory (all Codex wrappers + openai.yaml files)
- [ ] Update CLAUDE.md to document the new skill system
- [ ] Update `.claude/rules/` to remove any references to `.claude/agents/` or Task tool subagents

### Phase 5: Validation

- [ ] Verify all 8 skills appear in `What skills are available?`
- [ ] Verify slash command invocation works for each (`/constitution-validator`, etc.)
- [ ] Verify auto-discovery triggers for representative scenarios
- [ ] Verify `context: fork` isolation works (skills don't pollute main context)
- [ ] Verify read-only skills don't modify files
- [ ] Run `/context` to check skill descriptions fit within context budget
- [ ] Test that `.claude/rules/` proactive triggers still fire correctly

## Affected Files

| File/Directory | Action |
|---------------|--------|
| `.claude/skills/<name>/SKILL.md` (x8) | Create |
| `.claude/agents/<name>/<NAME>.md` (x8) | Delete |
| `.agents/skills/<name>/` (x8) | Delete |
| `.claude/rules/03-constitution.md` | Update references |
| `.claude/rules/05-preflight.md` | Update references |
| `CLAUDE.md` | Update agent/skill documentation |

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Proactive triggering less reliable | Strengthen `.claude/rules/` with explicit `/skill-name` invocation instructions |
| Read-only not enforced by tool restriction | `allowed-tools` whitelist + strong instructions in SKILL.md body |
| Context budget exceeded with 8 skills | Keep descriptions concise; move detail to supporting files loaded on demand |
| Conversation context lost in forked skills | For skills that need conversation context, consider inline mode (no fork) at the cost of context pollution |
| Breaking change for team workflows | Phase migration — keep old agents during testing, remove after validation |

## Constitution Compliance

- No hardcoded values introduced (skills are configuration, not business logic)
- All existing constitution checks preserved in migrated skill content
- Trigger conditions remain configurable via `.claude/rules/` files

## Open Questions

- Should any skills run inline (no fork) to retain conversation context? E.g., `test-engineer` may benefit from seeing what code was just written
- Should we set `SLASH_COMMAND_TOOL_CHAR_BUDGET` explicitly to ensure all 8 skills fit?
- Should we create a new `.claude/rules/10-skill-triggers.md` or update existing rules individually?
