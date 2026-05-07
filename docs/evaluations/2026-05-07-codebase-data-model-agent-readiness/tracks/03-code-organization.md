# Track 3: Code Organization & Agent Navigability

Status: **Complete** — 2026-05-07

Evaluator: Claude Opus 4.6 (Track 3 specialist)

---

## Executive Summary

The SAM codebase comprises 1,407 source files (TS/TSX/Go) totaling ~178k lines. The monorepo structure is sound — dependency flow is clean (`packages/` → `apps/`), the shared types package prevents duplication, and most features are locatable within 2-3 directory hops. However, **15 files exceed the 800-line hard limit**, **the always-loaded instruction budget is 3,631 lines** (a significant context-window tax), and the Go `server` package has grown into a 9,303-line kitchen-sink that undermines navigability for both humans and agents.

### Key Metrics

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Files > 800 lines (hard limit) | 15 | 0 | FAIL |
| Files > 500 lines (soft limit) | 73 | 0 | FAIL |
| Files > 400 lines (constitution IV) | 128 | 0 | FAIL |
| Always-loaded instruction lines | 3,631 | <1,500 | FAIL |
| Rule files with duplicate numbering | 3 (all #06) | 0 | FAIL |
| Nested AGENTS.md coverage | 3 of 10 packages | 6+ | PARTIAL |
| Average feature discovery hops | ~10 | <6 | NEEDS WORK |

---

## 3.1 File Size & Complexity

### [HIGH] F01 — 15 Files Exceed 800-Line Hard Limit

**Track**: 3 — Code Organization
**Location**: See table below
**Category**: navigability

**Finding**: Rule 18 sets 500 lines as the soft limit and 800 as the mandatory split threshold. 15 non-test source files exceed 800 lines. An existing backlog task (`tasks/backlog/2026-04-03-split-oversized-files.md`) covers 8 of them but is stale — it lists old line counts and misses 7 files that have since crossed the threshold.

| File | Lines | Notes |
|------|-------|-------|
| `packages/vm-agent/internal/bootstrap/bootstrap.go` | 2,828 | +592 since backlog task |
| `packages/vm-agent/internal/acp/session_host.go` | 2,535 | +328 since backlog task |
| `apps/api/src/db/schema.ts` | 1,448 | Exempted (schema file) |
| `packages/vm-agent/internal/acp/gateway.go` | 1,412 | +331 since backlog task |
| `packages/vm-agent/internal/server/server.go` | 1,359 | +72 since backlog task |
| `packages/vm-agent/internal/server/workspaces.go` | 1,231 | +164 since backlog task |
| `apps/api/src/durable-objects/project-data/row-schemas.ts` | 1,023 | NOT in backlog task |
| `apps/api/src/routes/tasks/crud.ts` | 995 | NOT in backlog task |
| `apps/api/src/routes/projects/crud.ts` | 920 | NOT in backlog task |
| `apps/api/src/routes/triggers/crud.ts` | 842 | NOT in backlog task |
| `packages/terminal/src/MultiTerminal.tsx` | 840 | In backlog task |
| `apps/api/src/durable-objects/trial-orchestrator/steps.ts` | 838 | NOT in backlog task |
| `packages/acp-client/src/hooks/useAcpSession.ts` | 821 | In backlog task |
| `apps/api/src/routes/workspaces/runtime.ts` | 814 | NOT in backlog task |
| `apps/api/src/services/project-data.ts` | 808 | NOT in backlog task |

**Impact**: Large files force agents to load 1,000-2,500 lines of context to edit any part of the file. This wastes context budget, increases hallucination risk during edits, and makes merge conflicts more likely when parallel agents touch the same file.

**Recommendation**: Update `tasks/backlog/2026-04-03-split-oversized-files.md` with current line counts and the 7 newly-oversized files. Prioritize the 5 Go files (they are the largest and lack any splitting infrastructure) and the 3 route CRUDs (which can be split by HTTP method group).

**Implementation Owner**: All packages — each file lives in a different domain.
**Effort**: L (15 files, each requires careful extraction + test verification)

### [HIGH] F02 — File Size Distribution Shows Systemic Drift

**Track**: 3 — Code Organization
**Location**: Codebase-wide
**Category**: navigability

**Finding**: Beyond the 15 hard-limit violations, the overall distribution shows drift:

| Size Bracket | Count | % of Source Files |
|-------------|-------|-------------------|
| 0-100 lines | 304 | 36% |
| 101-200 lines | 224 | 27% |
| 201-400 lines | 182 | 22% |
| 401-500 lines | 55 | 7% |
| 501-800 lines | 58 | 7% |
| 800+ lines | 15 | 2% |

73 files (501-800) are in the "warning zone" — one feature addition pushes each past the hard limit. The existing CI quality check (`scripts/quality/check-file-sizes.ts`) uses an allowlist, which permits tracked files to grow without limit.

**Impact**: Without a ratchet mechanism, oversized files grow instead of shrink. The allowlist pattern means the CI gate offers zero resistance to regression.

**Recommendation**: Replace the allowlist with a per-file ceiling ratchet: store each file's current line count as the max allowed, and fail CI if any file exceeds its recorded ceiling. Files can only get smaller, never larger.

**Implementation Owner**: `scripts/quality/`
**Effort**: S

### [HIGH] F03 — Top Functions Exceed 300+ Lines

**Track**: 3 — Code Organization
**Location**: Multiple files (see table)
**Category**: navigability

**Finding**: Constitution Principle IV specifies "Functions under 50 lines." While 50 lines is aspirational for complex orchestration functions, the following functions are extreme outliers:

**Go (top 5)**:

| Function | File | Lines | Concern Mix |
|----------|------|-------|-------------|
| `(*SessionHost).startAgent()` | `acp/session_host.go:911-1354` | 444 | Process launch + ACP init + prompt delivery |
| `(*Server).handleMultiTerminalWS()` | `server/websocket.go:306-661` | 356 | WebSocket mux for terminal sessions |
| `New()` | `server/server.go:241-492` | 252 | All dependency wiring |
| `Load()` | `config/config.go:209-456` | 248 | Env var parsing |
| `(*Server).handleFileUpload()` | `server/file_transfer.go:42-244` | 203 | Multipart upload |

**TypeScript/TSX (top 5)**:

| Function / Component | File | Lines | Concern Mix |
|----------------------|------|-------|-------------|
| `ChatInput` | `apps/web/src/pages/project-chat/ChatInput.tsx` | 426 | Mobile/desktop branching + form + file attachments |
| `WorktreeSelector` | `apps/web/src/components/WorktreeSelector.tsx` | 406 | Popover state + CRUD + modal toggle + branch selection |
| `TaskDetail` | `apps/web/src/pages/TaskDetail.tsx` | 402 | 6 task state views inline + edit forms |
| `useAudioPlayback` | `packages/acp-client/src/hooks/useAudioPlayback.ts` | 389 | Audio + TTS API + buffering + state machine |
| `Workspace` | `apps/web/src/pages/workspace/index.tsx` | 382 | Layout + header + sidebar + routing + resize |

**Impact**: Functions over 200 lines are hard for agents to reason about in a single context window pass. The 444-line `startAgent()` is particularly dangerous — it mixes process lifecycle, ACP protocol, and prompt delivery, making it difficult to safely modify any one concern.

**Recommendation**: For Go: extract `startAgent()` into `launchProcess()`, `initAcpConnection()`, and `deliverPrompt()`. For TS: extract `ChatInput` mobile/desktop variants into separate components; extract `TaskDetail` state-specific views into child components.

**Implementation Owner**: `packages/vm-agent/` (Go), `apps/web/` (TS)
**Effort**: M per function (total: L for all listed functions)

### [MEDIUM] F04 — Deep Nesting in Critical Functions

**Track**: 3 — Code Organization
**Location**: `apps/api/src/routes/ai-proxy.ts`, `apps/api/src/auth.ts`, `apps/api/src/scheduled/stuck-tasks.ts`
**Category**: navigability

**Finding**: 14 functions have 7+ levels of nesting. The worst offender is `translateStreamEvent()` at 10 levels deep (switch cases with nested return objects). `createAuth()` reaches 9 levels, and `recoverStuckTasks()` reaches 9 levels across 329 lines with 5 distinct recovery phases.

**Impact**: Deep nesting makes it hard for agents and humans to follow control flow. Each nesting level compounds the cognitive and context cost of understanding branches.

**Recommendation**: Apply early-return guard clauses to reduce nesting by 4-6 levels in most cases. Extract the 5 phases of `recoverStuckTasks()` into named functions. Extract `translateStreamEvent()` switch-case handlers into a handler map.

**Implementation Owner**: `apps/api/`
**Effort**: S per function

---

## 3.2 Discoverability

### [MEDIUM] F05 — Feature Code Scattered Across 10+ Locations

**Track**: 3 — Code Organization
**Location**: Codebase-wide
**Category**: navigability

**Finding**: An agent searching for a feature's full implementation must visit ~10 locations on average. Tested with 5 features:

| Feature | Route | Service | DO | Component | Types | Tests | Total Hops |
|---------|-------|---------|-----|-----------|-------|-------|------------|
| File Library | `routes/projects/files.ts` | `services/file-library.ts` | `project-data/` | `ProjectLibrary.tsx` | `shared/types/` | scattered | 9-10 |
| Mission Orchestration | `routes/mcp/orchestration-tools.ts` | `services/project-orchestrator.ts` | `project-orchestrator/` | — | `shared/types/mission.ts` | scattered | 8-9 |
| Notification System | `routes/mcp/index.ts` (embedded) | `durable-objects/notification.ts` | (self) | (multiple) | `shared/types/` | scattered | 8-10 |
| AI Proxy | `routes/ai-proxy.ts` + `routes/ai-proxy-anthropic.ts` | `services/ai-billing.ts` + `services/ai-token-budget.ts` + `services/ai-gateway-logs.ts` + `services/ai-proxy-shared.ts` | — | `SettingsComputeUsage.tsx` | scattered | 11+ |
| Trial Orchestrator | `routes/trial/create.ts` + `routes/trial/events.ts` | `services/trial/bridge.ts` + others | `trial-orchestrator/` | (trial page) | scattered | 12+ |

**Impact**: High hop count increases the risk that agents miss a file when making cross-cutting changes. The AI proxy feature is the worst case — its logic is spread across 4+ service files with no shared directory or naming prefix.

**Recommendation**: For multi-file features (AI proxy, trial), consolidate service files into feature directories: `services/ai-proxy/billing.ts`, `services/ai-proxy/budget.ts`, etc. This reduces discovery hops from 11+ to 6-7 by making `ls services/ai-proxy/` sufficient to find all related code.

**Implementation Owner**: `apps/api/src/services/`
**Effort**: M (file moves + import updates)

### [MEDIUM] F06 — MCP Tool Routing Uses Monolithic Switch Statement

**Track**: 3 — Code Organization
**Location**: `apps/api/src/routes/mcp/index.ts:213-389`
**Category**: navigability

**Finding**: The MCP tool routing in `apps/api/src/routes/mcp/index.ts` uses a ~177-case switch statement to dispatch tool calls. Each new MCP tool requires modifying this switch statement. The file is 427 lines total with 104 lines of imperative middleware logic mixed in.

**Impact**: The switch statement is a merge conflict magnet when multiple agents add tools in parallel. Agents cannot add a tool by creating a new file — they must always edit this central switch block. This violates change locality (see F10).

**Recommendation**: Replace the switch with a registry map pattern: `const TOOL_HANDLERS: Record<string, ToolHandler> = { 'add_knowledge': handleAddKnowledge, ... }`. Each tool file can self-register by exporting its handler, and the index file imports and dispatches from the map.

**Implementation Owner**: `apps/api/src/routes/mcp/`
**Effort**: M

### [LOW] F07 — Search Vocabulary Misalignment

**Track**: 3 — Code Organization
**Location**: Codebase-wide
**Category**: navigability

**Finding**: Product vocabulary sometimes differs from code vocabulary, creating search friction:

| Product Term | Code Term | Where to Find |
|-------------|-----------|---------------|
| "Ideas" | `tasks` (D1 table), `ideas` (API route) | `routes/mcp/idea-tools.ts`, but stored in `tasks` table |
| "Chat sessions" | `acp_sessions` + `chat_sessions` | `durable-objects/project-data/acp-sessions.ts` + `sessions.ts` |
| "Knowledge graph" | `knowledge_entities` + `knowledge_observations` | `project-data/knowledge.ts` |
| "Warm pool" | `NodeLifecycle` DO + `warm` status | `durable-objects/node-lifecycle.ts` |
| "Agent profiles" | `agent_profiles` (D1) | `routes/agent-settings.ts` (not `agent-profiles.ts`) |

The "ideas" → "tasks" mapping is the most confusing: the product calls them "ideas" but the primary storage table is `tasks`, while the API routes use `/ideas/`. An agent searching for "idea" won't find the D1 schema; searching for "task" will find task execution, not the ideas feature.

**Impact**: Agents waste search iterations when product terms don't match code names. This is a moderate annoyance, not a blocker.

**Recommendation**: Add a `GLOSSARY.md` or a machine-readable concept-to-code map at the repo root. This is low-cost and high-value for agent discoverability. Example format:

```markdown
## Concept Map
| Product Concept | D1 Table | DO Table | Route File | Service | Component |
|----------------|----------|----------|------------|---------|-----------|
| Ideas | tasks | — | idea-tools.ts | — | IdeaDetailPage.tsx |
```

**Implementation Owner**: Root-level documentation
**Effort**: S

### [INFO] F08 — Barrel File Quality Is Mixed

**Track**: 3 — Code Organization
**Location**: Various `index.ts` files
**Category**: navigability

**Finding**: 35 barrel (index.ts) files were audited. Most are clean, but 3 are problematic:

| Barrel File | Lines | Issue |
|-------------|-------|-------|
| `apps/api/src/index.ts` | 614 | Contains 104 lines of middleware logic (CORS, workspace proxy, health checks) mixed with route registration |
| `apps/api/src/routes/mcp/index.ts` | 427 | Contains 177-case switch + middleware (see F06) |
| `apps/web/src/lib/api/index.ts` | 282 | Re-exports 150+ symbols from 15 files — hard to trace imports |

Good examples: `packages/shared/src/index.ts` (18 lines, named re-exports only), `packages/ui/src/index.ts` (8 lines, clean domain grouping).

**Impact**: Logic in barrel files makes it ambiguous whether to edit the barrel or the source file. The 150+ re-export barrel in `apps/web/` makes import tracing expensive.

**Recommendation**: Extract middleware from `apps/api/src/index.ts` into `middleware/` files. Split `apps/web/src/lib/api/index.ts` into domain-scoped barrels (`admin.ts`, `projects.ts`, etc.) with a thin index re-exporting them.

**Implementation Owner**: `apps/api/`, `apps/web/`
**Effort**: S

### [LOW] F09 — No Dead Code Found (Positive Finding)

**Track**: 3 — Code Organization
**Location**: Codebase-wide
**Category**: navigability

**Finding**: A search for unused exports found no significant dead code. All 57 route files are registered in `apps/api/src/index.ts`. All 51 service files are actively imported. All 142 web components are referenced.

**Impact**: Positive — the "no dead code" rule from CLAUDE.md is being followed effectively.

**Recommendation**: None. This is a strength of the codebase.

**Effort**: N/A

### [MEDIUM] F10 — Change Locality: MCP Tool Addition Requires 4-5 File Edits

**Track**: 3 — Code Organization
**Location**: `apps/api/src/routes/mcp/`
**Category**: navigability

**Finding**: Adding a new MCP tool requires editing:
1. Tool handler file (e.g., `knowledge-tools.ts`) — add handler function
2. Tool definitions file (e.g., `tool-definitions-knowledge-tools.ts`) — add schema
3. `mcp/index.ts` — add to switch statement (F06)
4. `_helpers.ts` or tools array — add to MCP_TOOLS advertisement list
5. `packages/shared/src/types/` — add shared types if needed

Adding a new field to the `projects` table requires 6-7 file edits across 3 packages (schema, migration, route handler, DO logic, shared types, API client, UI form).

Adding a new admin page requires 5-6 edits across 2 packages (API route, API registration, web page, web routing, shared types, optional admin nav).

**Impact**: High edit count increases the chance that agents miss a step. The MCP tool pattern is the worst — the switch statement (F06) is the bottleneck that blocks self-registering tool patterns.

**Recommendation**: Adopt a self-registering pattern for MCP tools where each tool file exports both its handler and its schema definition, and the index file auto-discovers them via dynamic import or static registration array. This reduces new-tool changes from 4-5 files to 1-2 files.

**Implementation Owner**: `apps/api/src/routes/mcp/`
**Effort**: M

---

## 3.3 Instruction Architecture & Context Budget

### [HIGH] F11 — Always-Loaded Instructions Consume 3,631 Lines

**Track**: 3 — Code Organization
**Location**: `CLAUDE.md` + `.claude/rules/*.md`
**Category**: agent-readiness

**Finding**: Every Claude Code session loads:

| Source | Lines | Approx. Tokens |
|--------|-------|-----------------|
| `CLAUDE.md` | 293 | ~2,000 |
| `.claude/rules/` (34 files) | 3,338 | ~22,000 |
| **Total always-loaded** | **3,631** | **~24,000** |

This is ~24k tokens of instruction context consumed before the agent reads any code or receives any task. For comparison, Claude's effective working context (after system prompt + tools) is roughly 150-180k tokens. The instruction payload alone consumes 13-16% of usable context.

Several rules are rarely needed in a given session but are loaded every time:

| Rule | Lines | When Actually Needed |
|------|-------|---------------------|
| `32-cf-api-debugging.md` | 164 | Only when debugging staging |
| `33-staging-feature-validation.md` | 191 | Only during staging validation tasks |
| `29-local-first-debugging.md` | 216 | Only when debugging |
| `13-staging-verification.md` | 247 | Only during /do Phase 6 |
| `12-strategy.md` | 81 | Only during strategy work |
| `31-migration-safety.md` | 116 | Only when writing migrations |
| `28-credential-resolution-fallback-tests.md` | 85 | Only when touching credential code |

These 7 rules total ~1,100 lines that could be moved to on-demand loading (skills or guides) without losing safety, saving ~7k tokens per session.

**Impact**: Every agent session pays a ~24k-token tax. For short tasks (bug fixes, docs changes), this tax is disproportionately large. It also leaves less room for code context when working on large files.

**Recommendation**:
1. Move the 7 rarely-needed rules above into focused guides or skills (e.g., `staging-debugging` skill that loads rules 29, 32, 33 together).
2. Keep universally-applicable rules (01-doc-sync, 02-quality-gates, 03-constitution, 05-preflight, 18-file-size-limits) always-loaded.
3. Target: reduce always-loaded instructions to <2,000 lines (~13k tokens).

**Implementation Owner**: `.claude/rules/`, `.agents/skills/`
**Effort**: M

### [MEDIUM] F12 — Rule 06 Has Three Files With Same Number

**Track**: 3 — Code Organization
**Location**: `.claude/rules/06-*.md`
**Category**: navigability

**Finding**: Three rule files share the `06` prefix:
- `06-api-patterns.md` (93 lines)
- `06-technical-patterns.md` (175 lines)
- `06-vm-agent-patterns.md` (44 lines)

These are also duplicated in nested `AGENTS.md` files (`apps/api/AGENTS.md` mirrors `06-api-patterns.md`, `packages/vm-agent/AGENTS.md` mirrors `06-vm-agent-patterns.md`), creating two sources of truth.

**Impact**: Agents may not know which `06-*` rule applies to their current work. The duplication between rules and nested AGENTS.md files means updates must be made in two places, and they will drift.

**Recommendation**:
1. Renumber to eliminate collision: `06-technical-patterns.md`, `06a-api-patterns.md`, `06b-vm-agent-patterns.md` — or better, move domain-specific patterns into the nested AGENTS.md files and delete the rule-file copies.
2. Establish a clear rule: `.claude/rules/` contains universal rules; domain-specific patterns live in nested AGENTS.md files.

**Implementation Owner**: `.claude/rules/`, nested AGENTS.md files
**Effort**: S

### [MEDIUM] F13 — AGENTS.md and CLAUDE.md Duplicate Material

**Track**: 3 — Code Organization
**Location**: `AGENTS.md`, `CLAUDE.md`
**Category**: agent-readiness

**Finding**: `AGENTS.md` (410 lines) and `CLAUDE.md` (293 lines) share significant overlapping content:
- Repository structure description
- Common commands
- Build order
- Key concepts
- URL construction rules
- Env var naming (GH_ vs GITHUB_)
- Git workflow
- Testing procedures
- Task tracking

The files serve different agent runtimes (AGENTS.md for Codex; CLAUDE.md for Claude Code), but the shared content means updates must be made in both places. Currently, CLAUDE.md is more up-to-date (it has the rules reference section) while AGENTS.md has more detailed constitution and infrastructure guidance.

**Impact**: Content drift between the two files is inevitable. An agent reading AGENTS.md may get stale information that CLAUDE.md has already corrected, or vice versa.

**Recommendation**: Extract shared content into a `docs/guides/agent-common.md` file. Both AGENTS.md and CLAUDE.md should reference it (AGENTS.md can inline it since Codex doesn't have `.claude/rules/`; CLAUDE.md can keep it lean since rules are auto-loaded). The key is one source of truth for shared content.

**Implementation Owner**: Root-level documentation
**Effort**: M

### [LOW] F14 — Nested AGENTS.md Coverage Is Incomplete

**Track**: 3 — Code Organization
**Location**: Nested AGENTS.md files
**Category**: agent-readiness

**Finding**: Only 3 packages have nested AGENTS.md files:
- `apps/api/AGENTS.md` (61 lines) — covers API patterns, error handling, route handler pattern
- `apps/web/AGENTS.md` (52 lines) — covers UI standards, mobile-first requirements
- `packages/vm-agent/AGENTS.md` (34 lines) — covers VM agent lifecycle, systemd gotchas

Missing nested AGENTS.md files for:
- `apps/www/` — Astro/Starlight conventions, blog content structure
- `packages/shared/` — type export conventions, when to add vs. inline types
- `packages/providers/` — provider interface contract, adding new providers
- `packages/cloud-init/` — template generation patterns, YAML testing requirements
- `packages/terminal/` — xterm.js patterns, WebSocket protocol
- `packages/acp-client/` — ACP component patterns, hook conventions
- `packages/ui/` — design token usage, component contribution guide

**Impact**: Agents working in packages without nested AGENTS.md must rely on the root AGENTS.md (which is generic) or infer patterns from existing code. The constitution (Principle VIII) recommends nested AGENTS.md for package-specific context.

**Recommendation**: Create nested AGENTS.md files for at least `packages/shared/`, `packages/providers/`, and `packages/cloud-init/` — these are the packages where agents most frequently make mistakes due to missing context.

**Implementation Owner**: Each package owner
**Effort**: S per file

### [INFO] F15 — CLAUDE.md Recent Changes Section Format

**Track**: 3 — Code Organization
**Location**: `CLAUDE.md` "Recent Changes" section
**Category**: navigability

**Finding**: The "Recent Changes" section in CLAUDE.md uses a dense paragraph format per feature. Each entry is a single block of text with inline code references, making it hard to scan quickly. Example entry for `compact-mode-lazy-load-tool-content` is a single paragraph spanning ~6 lines with 15+ code references.

The section serves as an effective "what changed recently" index, but its density means agents must read the entire block to find a specific piece of information. There is no way to quickly scan for "which file handles X."

**Impact**: Low — the information is present and useful. The format just makes scanning slower than necessary.

**Recommendation**: No immediate action needed. If the section grows much larger, consider a tabular format or a separate `CHANGELOG-AGENT.md` with structured entries.

**Effort**: N/A

---

## 3.4 Go Codebase (VM Agent)

### [HIGH] F16 — `server` Package Is a 9,303-Line Kitchen Sink

**Track**: 3 — Code Organization
**Location**: `packages/vm-agent/internal/server/` (24 files, 63 exports)
**Category**: navigability

**Finding**: The `server` package contains 24 files spanning 9 distinct concern areas:

| Concern Area | Files | Key Files |
|-------------|-------|-----------|
| HTTP server setup | 2 | `server.go` (1,359 lines), `routes.go` |
| Workspace lifecycle | 4 | `workspaces.go` (1,231), `workspace_routing.go` (662), `workspace_provisioning.go`, `workspace_callbacks.go` |
| WebSocket handling | 3 | `websocket.go` (670), `agent_ws.go`, `bootlog_ws.go` |
| File operations | 2 | `files.go`, `file_transfer.go` |
| Git operations | 3 | `git.go` (513), `git_credential.go`, `worktrees.go` |
| System/health | 2 | `health.go`, `system_info.go` |
| Observability | 3 | `logs.go`, `events.go`, `debug_package.go` |
| MCP/ACP | 2 | `mcp_tools.go`, `acp_heartbeat.go` |
| Port proxying | 1 | `ports_proxy.go` |

The `Server` struct constructor (`New()`, 252 lines at `server.go:241-492`) wires all 9 concerns together, indicating the struct has accumulated too many responsibilities.

**Impact**: An agent modifying WebSocket behavior must load the entire `server` package into context. File-level grep for "workspace" returns hits in 6+ files within the same package, making it hard to identify the right edit target.

**Recommendation**: Split into domain sub-packages:
- `server/` — HTTP server setup, middleware, routing
- `server/workspace/` — workspace CRUD, provisioning, callbacks
- `server/agent/` — WebSocket agent sessions, ACP heartbeat
- `server/fileops/` — file upload/download, transfer
- `server/git/` — git operations, credentials, worktrees
- `server/observability/` — logs, events, debug package

Each sub-package gets its own handler struct, reducing the main `Server` struct to a composition of sub-handlers.

**Implementation Owner**: `packages/vm-agent/internal/server/`
**Effort**: XL (24 files, significant refactoring + test updates)

### [HIGH] F17 — `acp/session_host.go` Is 2,535 Lines

**Track**: 3 — Code Organization
**Location**: `packages/vm-agent/internal/acp/session_host.go`
**Category**: navigability

**Finding**: This single file manages 5 concerns:
1. Session lifecycle state machine (pending → running → completed)
2. Agent process communication (stdin/stdout piping)
3. ACP SDK connection management
4. Viewer (WebSocket) multiplexing for live streaming
5. Message buffering and token tracking

The `startAgent()` function alone is 444 lines (`session_host.go:911-1354`).

**Impact**: Any change to session lifecycle, agent communication, or viewer streaming requires loading the entire 2,535-line file. The 444-line `startAgent()` is the riskiest function in the codebase — it mixes process lifecycle, protocol initialization, and prompt delivery in a single call chain.

**Recommendation**: Split into 3 files:
- `session_host.go` — state machine and lifecycle coordination (~600 lines)
- `session_viewers.go` — WebSocket viewer multiplexing (~500 lines)
- `session_agent.go` — agent process launch and communication (~800 lines)

Additionally, decompose `startAgent()` into `launchProcess()`, `initAcpConnection()`, and `deliverPrompt()`.

**Implementation Owner**: `packages/vm-agent/internal/acp/`
**Effort**: L

### [MEDIUM] F18 — Goroutine Leak Risk in SessionManager

**Track**: 3 — Code Organization
**Location**: `packages/vm-agent/internal/auth/session.go:73`
**Category**: navigability (structural concern)

**Finding**: `SessionManager.NewSessionManager()` starts a background cleanup goroutine via `go sm.cleanup()`. The goroutine runs forever, selecting on `sm.stopCleanup` channel. However, `SessionManager` has no `Stop()` or `Close()` method to signal this channel. If the server shuts down gracefully, the cleanup goroutine leaks.

**Impact**: During graceful shutdown, the leaked goroutine prevents clean process exit. In long-running VMs this is low-impact (the process is being killed anyway), but it's a code quality issue that signals missing lifecycle management.

**Recommendation**: Add a `Stop()` method to `SessionManager` that closes the `stopCleanup` channel. Call it from `Server.Stop()`.

**Implementation Owner**: `packages/vm-agent/internal/auth/`
**Effort**: S

### [INFO] F19 — Go Package Cohesion Is Generally Strong

**Track**: 3 — Code Organization
**Location**: `packages/vm-agent/internal/`
**Category**: navigability

**Finding**: Outside of `server` (F16) and `acp` (F17), the remaining 18 Go packages have clear single responsibilities:

| Package | Lines | Exports | Cohesion |
|---------|-------|---------|----------|
| `bootstrap` | 2,828 | 9 | Good (single orchestration concern, oversized) |
| `config` | 831 | 7 | Good (config loading only) |
| `logreader` | 880 | 15 | Good (journald streaming) |
| `pty` | 838 | 10 | Good (PTY lifecycle) |
| `ports` | 682 | 13 | Good (port scanning) |
| `sysinfo` | 700 | 19 | Good (system info collection) |
| `messagereport` | 689 | 6 | Good (message batching + delivery) |
| `persistence` | 493 | 5 | Good (SQLite storage) |
| `auth` | 466 | 8 | Good (JWT + session mgmt) |
| `provision` | 441 | 5 | Good (provisioning status) |
| `agentsessions` | 262 | 4 | Good (session registry) |
| `errorreport` | 252 | 4 | Good (error batching) |
| `resourcemon` | 228 | 3 | Good (metrics loop) |
| `eventstore` | 202 | 3 | Good (event persistence) |
| `container` | 165 | 3 | Good (Docker discovery) |
| `bootlog` | 156 | 3 | Good (boot logging) |
| `callbackretry` | 148 | 5 | Good (retry logic) |
| `logging` | 79 | 4 | Good (slog setup) |

Error handling is consistent: 68% of files use `fmt.Errorf("...: %w", err)` for context wrapping. slog structured logging is used in 41 of 42 source files. These are strong positives.

**Impact**: Positive — the codebase has good foundations. The server and acp packages are the exceptions, not the rule.

**Recommendation**: None for the well-structured packages. The server/acp refactoring (F16, F17) will bring them in line.

**Effort**: N/A

---

## 3.5 Navigability Scorecard

### Rating Scale

- **5**: Excellent — agent finds everything on first search, minimal context needed
- **4**: Good — agent finds most things quickly, minor search friction
- **3**: Adequate — agent eventually finds things but wastes some searches
- **2**: Poor — agent frequently misses files or loads unnecessary context
- **1**: Bad — agent cannot reliably navigate without extensive guidance

### Scorecard

| Package/App | Naming Clarity | Structural Predictability | Doc Quality | File Size Compliance | Dead Code Absence | **Average** |
|-------------|---------------|--------------------------|-------------|---------------------|-------------------|-------------|
| `apps/api/` | 4 | 3 | 4 | 2 | 5 | **3.6** |
| `apps/web/` | 4 | 4 | 3 | 3 | 5 | **3.8** |
| `apps/www/` | 4 | 5 | 3 | 5 | 5 | **4.4** |
| `apps/tail-worker/` | 5 | 5 | 4 | 5 | 5 | **4.8** |
| `packages/shared/` | 5 | 5 | 4 | 5 | 5 | **4.8** |
| `packages/providers/` | 4 | 4 | 3 | 4 | 5 | **4.0** |
| `packages/cloud-init/` | 4 | 5 | 4 | 5 | 5 | **4.6** |
| `packages/terminal/` | 3 | 4 | 3 | 2 | 5 | **3.4** |
| `packages/acp-client/` | 4 | 4 | 3 | 2 | 5 | **3.6** |
| `packages/ui/` | 5 | 5 | 4 | 5 | 5 | **4.8** |
| `packages/vm-agent/` | 4 | 2 | 3 | 1 | 5 | **3.0** |
| **Instruction layer** | 3 | 3 | 4 | — | — | **3.3** |

### Narrative Justification

**`apps/api/` (3.6)**: Good naming (routes map to resources), but structural predictability suffers from scattered multi-file features (F05), the MCP switch statement (F06), and 5 files over 800 lines. Dead code absence is excellent.

**`apps/web/` (3.8)**: Components are well-named and organized by page. File size compliance is moderate (several pages over 500 lines but only 1 over 800). Missing nested AGENTS.md for Tailwind/React patterns specific to this app.

**`packages/vm-agent/` (3.0)**: Lowest score due to the `server` kitchen-sink package (F16), `session_host.go` at 2,535 lines (F17), and `bootstrap.go` at 2,828 lines. An agent cannot work on WebSocket handling without loading 9,303 lines of server context. Package-level cohesion outside `server/` is excellent, but the server package drags the score down.

**Instruction layer (3.3)**: Always-loaded context is too large (F11). Rule numbering has collisions (F12). AGENTS.md/CLAUDE.md duplication (F13). Nested coverage is incomplete (F14). The quality of individual rule files is high — the issue is quantity and organization, not content.

---

## Findings Summary

| ID | Severity | Title | Effort |
|----|----------|-------|--------|
| F01 | HIGH | 15 files exceed 800-line hard limit | L |
| F02 | HIGH | File size distribution shows systemic drift | S |
| F03 | HIGH | Top functions exceed 300+ lines | L |
| F04 | MEDIUM | Deep nesting in critical functions | S |
| F05 | MEDIUM | Feature code scattered across 10+ locations | M |
| F06 | MEDIUM | MCP tool routing uses monolithic switch | M |
| F07 | LOW | Search vocabulary misalignment | S |
| F08 | INFO | Barrel file quality is mixed | S |
| F09 | LOW | No dead code found (positive) | N/A |
| F10 | MEDIUM | MCP tool addition requires 4-5 file edits | M |
| F11 | HIGH | Always-loaded instructions consume 3,631 lines | M |
| F12 | MEDIUM | Rule 06 has three files with same number | S |
| F13 | MEDIUM | AGENTS.md and CLAUDE.md duplicate material | M |
| F14 | LOW | Nested AGENTS.md coverage is incomplete | S |
| F15 | INFO | CLAUDE.md Recent Changes section format | N/A |
| F16 | HIGH | `server` package is 9,303-line kitchen sink | XL |
| F17 | HIGH | `acp/session_host.go` is 2,535 lines | L |
| F18 | MEDIUM | Goroutine leak risk in SessionManager | S |
| F19 | INFO | Go package cohesion is generally strong (positive) | N/A |

---

## Follow-Up Task Packets

### P0: File Size Ratchet (Blocks Further Drift)

**Task**: Replace the allowlist-based file size CI check with a per-file ceiling ratchet.

**Files to modify**:
- `scripts/quality/check-file-sizes.ts` — replace allowlist with `max-lines.json` lookup
- `max-lines.json` (new) — records current line count as ceiling for each oversized file

**Acceptance criteria**:
- [ ] CI fails if any source file exceeds its recorded ceiling
- [ ] Ceilings can only decrease (enforced by the script)
- [ ] New files default to the 500-line soft limit
- [ ] Files currently over 500 lines get their current count as the ceiling

**Effort**: S

### P0: Reduce Always-Loaded Instruction Budget (Context Savings)

**Task**: Move 7 rarely-needed rules into on-demand skills/guides.

**Rules to move**:
- `28-credential-resolution-fallback-tests.md` → `credential-patterns` skill
- `29-local-first-debugging.md` → `debugging` skill (loaded during /do workflow or on error)
- `31-migration-safety.md` → `migration-safety` skill (loaded when touching schema/migrations)
- `32-cf-api-debugging.md` → `debugging` skill
- `33-staging-feature-validation.md` → `staging-validation` skill
- `12-strategy.md` → already partially covered by strategy skills
- `13-staging-verification.md` → `staging-verification` skill (loaded during /do Phase 6)

**Acceptance criteria**:
- [ ] Always-loaded instruction total drops below 2,500 lines
- [ ] Each moved rule is accessible via a skill that loads it on demand
- [ ] The /do workflow explicitly loads staging rules during Phase 6
- [ ] No safety regression — critical rules remain always-loaded

**Effort**: M

### P1: Split Go `server` Package

**Task**: Decompose `packages/vm-agent/internal/server/` into domain sub-packages.

**Proposed structure**:
```
internal/server/
├── server.go          (HTTP setup, middleware, routing — ~400 lines)
├── workspace/         (lifecycle, provisioning, callbacks — ~2,500 lines across 4 files)
├── agent/             (WebSocket sessions, ACP heartbeat — ~1,200 lines across 3 files)
├── fileops/           (upload, download, transfer — ~800 lines across 2 files)
├── git/               (operations, credentials, worktrees — ~900 lines across 3 files)
└── observability/     (logs, events, debug package — ~700 lines across 3 files)
```

**Acceptance criteria**:
- [ ] `server.go` is under 500 lines
- [ ] Each sub-package has a clear single responsibility
- [ ] No sub-package exceeds 800 lines per file
- [ ] All existing tests pass with updated imports
- [ ] The `Server` struct composes sub-handler structs

**Effort**: XL

### P1: Split `acp/session_host.go`

**Task**: Decompose the 2,535-line file into 3 focused files.

**Proposed split**:
- `session_host.go` — lifecycle state machine, coordination (~600 lines)
- `session_viewers.go` — WebSocket viewer multiplexing (~500 lines)
- `session_agent.go` — process launch, ACP init, prompt delivery (~800 lines)

Additionally decompose `startAgent()` (444 lines) into:
- `launchProcess()` — OS process creation
- `initAcpConnection()` — ACP SDK handshake
- `deliverPrompt()` — initial prompt delivery with streaming

**Acceptance criteria**:
- [ ] No file exceeds 800 lines
- [ ] `startAgent()` is replaced by 3 sub-functions, each under 150 lines
- [ ] All existing tests pass
- [ ] Session lifecycle state transitions are clearly traceable in one file

**Effort**: L

### P1: MCP Tool Self-Registration Pattern

**Task**: Replace the 177-case switch in `apps/api/src/routes/mcp/index.ts` with a registry pattern.

**Proposed approach**:
1. Each tool file exports a `TOOLS` array of `{ name, schema, handler }` objects
2. `mcp/index.ts` imports all tool files and builds a flat `Map<string, ToolHandler>`
3. Tool dispatch becomes: `const handler = toolMap.get(toolName); if (!handler) throw notFound;`

**Acceptance criteria**:
- [ ] No switch statement in MCP routing
- [ ] Adding a new tool requires only creating a new file (self-contained)
- [ ] All existing MCP tool tests pass
- [ ] Tool advertisement (MCP_TOOLS list) is generated from the registry

**Effort**: M

### P1: Fix Rule 06 Numbering Collision

**Task**: Resolve the triple-06 rule file collision.

**Proposed approach**:
- Keep `06-technical-patterns.md` as the universal technical patterns rule
- Move API-specific patterns from `06-api-patterns.md` into `apps/api/AGENTS.md` (already duplicated there)
- Move VM-agent-specific patterns from `06-vm-agent-patterns.md` into `packages/vm-agent/AGENTS.md` (already duplicated there)
- Delete `06-api-patterns.md` and `06-vm-agent-patterns.md`

**Acceptance criteria**:
- [ ] No duplicate rule numbers
- [ ] Domain-specific patterns live in nested AGENTS.md (single source of truth)
- [ ] Universal technical patterns remain in `.claude/rules/06-technical-patterns.md`

**Effort**: S

---

## Methodology Notes

### Data Collection

- File sizes measured via `wc -l` across all `.ts`, `.tsx`, `.go` files excluding `node_modules/`, `dist/`, and test files
- Function lengths identified via subagent analysis (Explore agents) reading actual source code
- Instruction sizes measured by line count across all instruction surfaces
- Barrel files audited by reading all `index.ts` files
- Dead code search performed via export/import cross-referencing
- Go package analysis performed by dedicated Go specialist subagent

### Limitations

- Function length analysis relies on heuristic detection (function/method declarations + brace counting). Some inner functions or complex arrow functions may be miscounted by ±10 lines.
- The "discovery hops" metric is subjective — it counts the number of distinct file paths an agent would need to visit, which depends on search strategy.
- Instruction token estimates use a rough 6.5 characters/token ratio; actual token counts vary by model.
