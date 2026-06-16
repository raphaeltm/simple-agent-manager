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

## Operational Guardrails

These are Codex-facing reminders for recurring SAM workflow failures. The durable source of truth remains `CLAUDE.md` and `.claude/rules/*.md`.

| Situation | Do |
| --------- | -- |
| Starting SAM-managed work | Call the SAM MCP `get_instructions` tool first and apply returned knowledge and policy directives. |
| Debugging a live issue Raphaël is seeing | Inspect production evidence first unless the issue is explicitly about staging or a branch verification. Use staging for PR validation and new-change verification. |
| Debugging staging or deployment behavior | Query Cloudflare state/logs before guessing or redeploying. Staging deploys are slow; CF API checks are fast. |
| Liveness, status, or read-only investigation prompts | Answer from the current session with evidence lookup as needed. Do not create branches, task files, PRs, or SAM subtasks unless Raphaël asks for durable changes or delegation. |
| User asks for "subtasks" | Use SAM `dispatch_task` for visible delegated work. |
| User asks for "local subagents" | Use local Claude/Codex subagents for in-session critique or reasoning, not SAM-dispatched tasks. |
| Dispatching a SAM task | Verify the task started, the title matches, the requested profile/agent is observable, and critical constraints such as `/do`, branch, `draft PR`, or `do not merge` survived. |
| Draft PR / do-not-merge request | Preserve the constraint in task state and PR wording. Stop at the draft/open PR unless Raphaël later authorizes readiness or merge. |
| Incidental bug found | If it is not blocking and not a small adjacent fix, file a backlog task with reproduction/evidence and continue the assigned work. |

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
- **Architecture docs**: `apps/www/src/content/docs/docs/architecture/overview.md`

## CLI Package Quality

`packages/cli` is a user-facing Go package. Codex and Claude Code agents must follow `.claude/rules/36-cli-quality.md` for every CLI change: keep command parsing simple, inject external boundaries, address SonarCloud findings, generate Go coverage, and write scenario-driven tests that verify command behavior, API payloads, runner checks, and secret redaction.

## Active Technologies

- TypeScript 5.x (Worker/Web), Go 1.24+ (VM Agent), Go 1.25+ (CLI)
- Hono (API framework), Drizzle ORM (D1), React 19 + Vite (Web)
- Cloudflare Workers SDK (Durable Objects, D1, KV, R2)
- Tailwind CSS v4 (Web), Astro + Starlight (Marketing site)
- @mastra/core (AI agent orchestration), workers-ai-provider (Workers AI bridge)
