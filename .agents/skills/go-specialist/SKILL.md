---
name: go-specialist
description: "Go code review specialist for VM Agent and CLI. Reviews PTY/WebSocket/JWT code, CLI command contracts, static-analysis findings, and Go idioms. Use when working in packages/vm-agent/, packages/cli/, or reviewing Go code changes."
metadata:
  short-description: "Go code review specialist for VM Agent and CLI code."
---

# go-specialist

This is a Codex skill wrapper around the Claude Code subagent definition in:
- .claude/agents/go-specialist/

Use:

1. Read `GO_SPECIALIST.md`.
2. Follow its checklist and constraints.
3. For `packages/cli`, also follow `.claude/rules/36-cli-quality.md`.
4. Report results with concrete file references.
