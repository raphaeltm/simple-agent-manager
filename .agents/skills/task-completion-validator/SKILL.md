---
name: task-completion-validator
description: "Task completion validator. Cross-references task file research findings, implementation checklist, and acceptance criteria against the actual git diff and test suite. Catches planned work that was never executed. Mandatory before archiving any task."
metadata:
  short-description: "Task completion validator. Cross-references planned vs actual work"
---

# task-completion-validator

This is a Codex skill wrapper around the Claude Code subagent definition in:
- .claude/agents/task-completion-validator/

Use:

1. Read TASK_COMPLETION_VALIDATOR.md.
2. Follow its validation procedure and five checks (A through E).
3. Report results with the structured output format, including the verdict table and all findings.
