# SAM — Agent Configuration

This file provides pointers for non-Claude Code agents (Codex, etc.). For Claude Code, see `CLAUDE.md` and `.claude/rules/`.

## Project

Simple Agent Manager (SAM) — a serverless monorepo platform for ephemeral AI coding agent environments on Cloudflare Workers + Hetzner Cloud VMs.

## Agent Configuration Locations

| What | Where |
|------|-------|
| Claude Code project instructions | `CLAUDE.md` |
| Claude Code modular rules | `.claude/rules/*.md` |
| Claude Code subagents | `.claude/agents/*/` |
| Claude Code skills (on-demand reference) | `.claude/skills/*/SKILL.md` |
| Codex-compatible skills | `.agents/skills/*/SKILL.md` (symlink to `.claude/agents/`) |
| Project constitution | `.specify/memory/constitution.md` |
| Feature specifications | `specs/` |
| Architecture docs | `docs/architecture/` |

## Quick Start for Agents

```bash
pnpm install && pnpm build && pnpm test
```

Build order: `shared` -> `providers` -> `cloud-init` -> `api` / `web`

## Key Rules

All behavioral rules for agents are in `.claude/rules/`:
- `01-doc-sync.md` — Mandatory documentation sync on every code change
- `02-quality-gates.md` — Testing requirements, CI procedure, post-deployment verification
- `03-constitution.md` — No hardcoded values (Principle XI)
- `04-ui-standards.md` — Mobile-first UI, Playwright verification (path-scoped to UI dirs)
- `05-preflight.md` — Agent preflight behavior before code edits
- `06-technical-patterns.md` — General code patterns
- `06-api-patterns.md` — Hono/API patterns (path-scoped to `apps/api/`)
- `06-vm-agent-patterns.md` — Go VM agent patterns (path-scoped to `packages/vm-agent/`)
- `07-env-and-urls.md` — Environment variable naming, URL construction
- `08-architecture.md` — Architecture research requirements
- `09-task-tracking.md` — Task tracking system
