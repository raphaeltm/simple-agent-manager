---
name: test-engineer
description: 'Test generation specialist for TDD compliance and coverage enforcement. Generates comprehensive tests following Vitest patterns for TypeScript and Go testing conventions. Use proactively during TDD phases, when implementing critical paths, or when coverage needs improvement.'
metadata:
  short-description: 'Test generation specialist for TDD compliance and coverage enfor'
---

# test-engineer

This is a Codex skill wrapper around the Claude Code subagent definition in:

- `.claude/agents/test-engineer/TEST_ENGINEER.md`

Use:

1. Read `.claude/agents/test-engineer/TEST_ENGINEER.md`.
2. Follow its checklist and constraints.
3. For any test that crosses system boundaries, follow the vertical slice testing rule in `.claude/rules/35-vertical-slice-testing.md`.
4. Report results with concrete file references.
