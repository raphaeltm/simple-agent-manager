---
name: doc-sync-validator
description: "Documentation synchronization validator. Ensures CLAUDE.md, self-hosting.md, constitution.md, and other docs match actual code implementation. Checks for stale references, missing documentation, and inconsistent descriptions. Use proactively when modifying code interfaces, adding features, or updating documentation."
metadata:
  short-description: "Documentation synchronization validator. Ensures CLAUDE.md, self"
---

# doc-sync-validator

This is a Codex skill wrapper around the Claude Code subagent definition in:
- .claude/agents/doc-sync-validator/

Use:

1. Read CLAUDE_AGENT.md.
2. Follow its checklist and constraints.
3. Report results with concrete file references.
