---
name: env-validator
description: "Environment variable consistency validator. Checks GH_* vs GITHUB_* naming conventions, validates documentation matches code, and ensures deployment scripts correctly map secrets. Use proactively when modifying environment variables, updating CLAUDE.md, editing configure-secrets.sh, or changing the Env interface."
metadata:
  short-description: "Environment variable consistency validator. Checks GH_* vs GITHU"
---

# env-validator

This is a Codex skill wrapper around the Claude Code subagent definition in:
- .claude/agents/env-validator/

Use:

1. Read CLAUDE_AGENT.md.
2. Follow its checklist and constraints.
3. Report results with concrete file references.
