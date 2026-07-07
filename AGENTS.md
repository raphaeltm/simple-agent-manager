# SAM — Agent Supplement

> This file provides agent-specific context that supplements `CLAUDE.md`. Project structure, commands, deployment, architecture, and development guidelines live in `CLAUDE.md` — do not duplicate them here.

## Agent Configuration Cross-Reference

| What                 | Claude Code Location              | Codex Location                                     |
| -------------------- | --------------------------------- | -------------------------------------------------- |
| Project instructions | `CLAUDE.md`                       | `AGENTS.md` (this file)                            |
| Modular rules        | `.claude/rules/*.md`              | Same files (shared)                                |
| Subagents / skills   | `.claude/agents/*/`               | `.agents/skills/*/SKILL.md` + `agents/openai.yaml` |
| Reference skills     | `.claude/skills/*/SKILL.md`       | `.agents/skills/*/SKILL.md`                        |
| Slash commands       | `.claude/commands/*.md`           | `.codex/prompts/*.md`                              |
| Project config       | `.claude/settings.json`           | `.codex/config.toml`                               |
| Constitution         | `.specify/memory/constitution.md` | Same file                                          |
| Feature specs        | `specs/`                          | Same directory                                     |

## Skills

Skills are invoked with `$skill-name` (Codex) or dispatched as subagents (Claude Code). Available in `.agents/skills/`:

### Review / Specialist Skills

- `$cloudflare-specialist` — D1, KV, R2, wrangler config review
- `$constitution-validator` — No hardcoded values compliance
- `$doc-sync-validator` — Documentation matches code
- `$env-validator` — GH* vs GITHUB* consistency
- `$go-specialist` — Go code review (PTY, WebSocket, JWT)
- `$security-auditor` — Credential safety, OWASP, JWT
- `$task-completion-validator` — Planned vs actual work validation (mandatory before archive)
- `$test-engineer` — Test generation and TDD compliance
- `$ui-ux-specialist` — Mobile-first UI, Playwright verification

### Reference Skills

- `$api-reference` — Full API endpoint reference
- `$changelog` — Recent feature changes and history
- `$env-reference` — Full environment variable reference

### Task Execution

- `$do` — End-to-end task executor: research → plan → implement → review → staging → PR
- `$workflow` — Multi-step workflow orchestration with foreground polling

## Operational Guardrails

These are Codex-facing reminders for recurring SAM workflow failures. The durable source of truth remains `CLAUDE.md` and `.claude/rules/*.md`.

| Situation                                                               | Do                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting SAM-managed work                                               | Call the SAM MCP `get_instructions` tool first and apply returned knowledge and policy directives.                                                                                                                                |
| Debugging a live issue Raphaël is seeing                                | Inspect production evidence first unless the issue is explicitly about staging or a branch verification. Use staging for PR validation and new-change verification.                                                               |
| User corrects a production/UI diagnosis                                 | Preserve the exact symptom the user observed, separate evidence from inference, and investigate UI/client-state artifacts when backend records disagree.                                                                          |
| Debugging staging or deployment behavior                                | Query Cloudflare state/logs before guessing or redeploying. Staging deploys are slow; CF API checks are fast.                                                                                                                     |
| User/smoke user has no cloud credential; stuck at cloud-onboarding wizard; zero active workspaces | NOT a blocker. A user cloud credential is NOT required — SAM's enabled platform Hetzner credential (`platform_credentials`, `credential_type='cloud-provider'`, `is_enabled=1`) provisions workspaces/deployment nodes via user→platform fallback. Never report a missing-user-cloud-credential provisioning or staging-verification blocker; verify `platform_credentials` in D1 and provision via the platform path. |
| User asks for "subtasks"                                                | Use SAM `dispatch_task` for visible delegated work.                                                                                                                                                                               |
| User asks for "local subagents"                                         | Use local Claude/Codex subagents for in-session critique, review, or reasoning, not SAM-dispatched tasks.                                                                                                                         |
| User asks for PR status, PR history, task status, a liveness check, or investigation only | Treat it as read-only by default. Use SAM MCP, GitHub, and local evidence in the current session. Do not create task files, branches, commits, PRs, or dispatched SAM subtasks unless the user asks for code/config changes, durable artifacts, or delegation. |
| Dispatching a SAM task                                                  | Verify the task started, the title matches, the requested profile/agent is observable, and critical constraints such as `/do`, branch, `draft PR`, or `do not merge` survived.                                                    |
| Retrying or redispatching after a failed SAM task                       | First inspect the failed task/session and check for active duplicate work with the same prompt, output branch, branch, or title. Do not blindly submit the same prompt again after no-workspace/startup failures or transient provider failures. |
| Reviewing previous sessions or conversation history                     | Keep SAM MCP searches bounded. If `search_messages` fails with a pattern-complexity error, retry with narrower terms or read known sessions directly; see `.claude/rules/09-task-tracking.md`.                                      |
| Draft PR / do-not-merge request                                         | Preserve the constraint in task state and PR wording. Stop at the draft/open PR unless Raphaël later authorizes readiness or merge.                                                                                               |
| Deployment setup/config changes                                         | Prefer generated Pulumi-managed platform secrets with explicit override paths. Do not add manual GitHub Environment prerequisites for deployment-owned keys or values SAM can safely create during deployment.                    |
| Profile/default-profile work                                            | Fresh installs should not seed multiple provider-specific built-in agent profiles. Prefer a setup wizard, templates, or at most one conversational default so users learn profiles intentionally instead of inheriting clutter.   |
| Incidental bug found                                                    | If it is not blocking and not a small adjacent fix, file a backlog task with reproduction/evidence and continue the assigned work.                                                                                                |

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
