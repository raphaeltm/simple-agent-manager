# SAM — Agent Supplement

> This file provides agent-specific context that supplements `CLAUDE.md`. Project structure, commands, deployment, architecture, and development guidelines live in `CLAUDE.md` — do not duplicate them here.

## Agent Configuration Cross-Reference

| What                 | Claude Code Location              | Codex Location                                  |
| -------------------- | --------------------------------- | ----------------------------------------------- |
| Project instructions | `CLAUDE.md`                       | `AGENTS.md` (this file)                         |
| Modular rules        | `.claude/rules/*.md`              | Same files (shared)                             |
| Subagents / skills   | `.claude/agents/*/`               | `.agents/skills/*/SKILL.md` + `agents/openai.yaml` |
| Reference skills     | `.claude/skills/*/SKILL.md`       | `.agents/skills/*/SKILL.md`                     |
| Slash commands       | `.claude/commands/*.md`           | `.codex/prompts/*.md`                           |
| Project config       | `.claude/settings.json`           | `.codex/config.toml`                            |
| Constitution         | `.specify/memory/constitution.md` | Same file                                       |
| Feature specs        | `specs/`                          | Same directory                                  |

## Skills

Skills are invoked with `$skill-name` (Codex) or dispatched as subagents (Claude Code). Available in `.agents/skills/`:

### Review / Specialist Skills

- `$cloudflare-specialist` — D1, KV, R2, wrangler config review
- `$constitution-validator` — No hardcoded values compliance
- `$doc-sync-validator` — Documentation matches code
- `$env-validator` — GH_ vs GITHUB_ consistency
- `$go-specialist` — Go code review (PTY, WebSocket, JWT)
- `$security-auditor` — Credential safety, OWASP, JWT
- `$task-completion-validator` — Planned vs actual work validation (mandatory before archive)
- `$test-engineer` — Test generation and TDD compliance
- `$ui-ux-specialist` — Mobile-first UI, Playwright verification

### Reference Skills

- `$api-reference` — Full API endpoint reference
- `$changelog` — Recent feature changes and history
- `$env-reference` — Full environment variable reference

### Strategy Skills

- `$business-strategy` — Market sizing, pricing, business model, GTM
- `$competitive-research` — Competitor profiles, feature matrices, SWOT
- `$content-create` — Social posts, blog outlines, changelogs, launch copy
- `$engineering-strategy` — Roadmap, tech radar, tech debt, build-vs-buy
- `$marketing-strategy` — Positioning, messaging, gap analysis, channel strategy

### Task Execution

- `$do` — End-to-end task executor: research → plan → implement → review → staging → PR
- `$workflow` — Multi-step workflow orchestration with foreground polling

## Prompts

Workflow prompts in `.codex/prompts/` (Codex) and `.claude/commands/` (Claude Code):

- `do` — End-to-end task execution (7-phase workflow)
- `workflow` — Multi-step workflow orchestration
- `speckit.specify` — Create/update feature spec
- `speckit.clarify` — Identify underspecified areas
- `speckit.plan` — Create implementation plan
- `speckit.tasks` — Generate task list from plan
- `speckit.taskstoissues` — Convert tasks to GitHub issues
- `speckit.implement` — Execute implementation plan
- `speckit.analyze` — Cross-artifact consistency analysis
- `speckit.checklist` — Generate custom checklist
- `speckit.constitution` — Constitution management

## Durable Object Patterns

Per-project data (chat sessions, messages, activity events) is stored in a `ProjectData` Durable Object with embedded SQLite:

- **Access**: `env.PROJECT_DATA.idFromName(projectId)` → deterministic DO stub
- **Service layer**: `apps/api/src/services/project-data.ts` — typed wrapper for all DO RPC calls
- **DO class**: `apps/api/src/durable-objects/project-data.ts` — extends `DurableObject`, constructor runs migrations
- **Migrations**: `apps/api/src/durable-objects/migrations.ts` — append-only, tracked in `migrations` table
- **WebSocket**: Hibernatable WebSockets for real-time event streaming
- **D1 sync**: `scheduleSummarySync()` debounces summary updates to D1
- **ADR**: `docs/adr/004-hybrid-d1-do-storage.md`

## CLI Package Quality

`packages/cli` is a user-facing Go package. Codex and Claude Code agents must follow `.claude/rules/36-cli-quality.md` for every CLI change: keep command parsing simple, inject external boundaries, address SonarCloud findings, generate Go coverage, and write scenario-driven tests that verify command behavior, API payloads, runner checks, and secret redaction.

## Active Technologies

- TypeScript 5.x (Worker/Web), Go 1.24+ (VM Agent), Go 1.25+ (CLI)
- Hono (API framework), Drizzle ORM (D1), React 19 + Vite (Web)
- Cloudflare Workers SDK (Durable Objects, D1, KV, R2)
- Tailwind CSS v4 (Web), Astro + Starlight (Marketing site)
- @mastra/core (AI agent orchestration), workers-ai-provider (Workers AI bridge)
