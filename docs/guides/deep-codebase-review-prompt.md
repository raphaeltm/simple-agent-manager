# Deep Codebase & Data Model Review Prompt

> **Purpose**: This prompt is designed to be executed by one or more AI coding agents (or human reviewers) to produce a thorough, actionable evaluation of the SAM codebase. It can be run as a single deep session or decomposed into the 9 review tracks below, each dispatched to a specialist agent.
>
> **Output**: Each track produces a structured findings report with severity ratings (CRITICAL / HIGH / MEDIUM / LOW / INFO), specific file:line references, and concrete recommendations. The final deliverable is a unified report with a prioritized action plan.

---

## Context for Reviewers

SAM (Simple Agent Manager) is a serverless monorepo platform for ephemeral AI coding agent environments. The stack is:

- **API**: Cloudflare Worker (Hono framework, TypeScript) with D1 (SQLite), KV, R2, Durable Objects
- **Web UI**: React 19 + Vite + Tailwind CSS v4
- **VM Agent**: Go 1.24+ binary running on Hetzner/Scaleway VMs, managing Docker containers, PTY sessions, WebSocket streams, and ACP (Agent Communication Protocol)
- **Orchestration**: Mission/task DAG system with per-project Durable Objects for state, mailbox messaging, and scheduling
- **Storage**: Hybrid D1 (cross-project relational) + Durable Object SQLite (per-project write-heavy data) + KV (ephemeral tokens, rate limits) + R2 (binaries, file library)

The codebase is primarily operated on by AI coding agents (Claude Code, Codex) — so navigability, discoverability, and structural clarity for LLM context windows are first-class concerns alongside traditional code quality.

### Key Documents to Read First

Before starting any review track, read these for architectural context:

1. `CLAUDE.md` — Project structure, conventions, recent changes
2. `docs/adr/004-hybrid-d1-do-storage.md` — Why data is split between D1 and DOs
3. `.specify/memory/constitution.md` — Core principles (especially XI: No Hardcoded Values, IV: Approachable Code)
4. `docs/architecture/credential-security.md` — BYOC model, encryption
5. `docs/architecture/durable-objects.md` — DO architecture overview
6. `.claude/rules/` — All 33 agent rules (these encode hard-won lessons from production incidents)

### Current Agent-Ready Codebase Research Basis

Use these external references to calibrate the review against current agent-oriented development practice:

- [AGENTS.md](https://agents.md/) frames `AGENTS.md` as a dedicated, predictable "README for agents" and recommends root-level instructions plus nested `AGENTS.md` files for large monorepos where subprojects need tailored guidance.
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices) emphasize that context-window pressure is the core operating constraint for coding agents, and recommend concise persistent instructions, verification commands, scoped prompts, skills for domain workflows, and subagents for isolated investigation.
- [MCP client best practices](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices) recommend progressive tool discovery: expose a small catalog/search layer first, inspect a chosen tool only when needed, then execute. This reduces context load and improves tool selection when many tools are available.
- [Microsoft's Learn MCP Server writeup](https://devblogs.microsoft.com/engineering-at-microsoft/how-we-built-the-microsoft-learn-mcp-server/) shows the practical pattern of exposing agent-friendly search/fetch/code-sample tools backed by trusted, up-to-date source material instead of asking agents to scrape or memorize docs.
- [12 Factor Agents](https://contextqmd.com/libraries/12-factor-agents) highlights agent-specific operational principles that apply to codebase organization: own prompts, own the context window, use structured tool outputs, unify execution state, support launch/pause/resume, compact errors, and prefer small focused agents.
- [The Twelve-Factor App](https://12factor.net/) remains relevant baseline guidance for deployable systems: one codebase, explicit dependencies, environment-based config, strict build/release/run separation, dev/prod parity, logs as event streams, and one-off admin processes.

Treat these as review lenses, not as generic citations. Every recommendation must still be grounded in SAM files, SAM data flows, and SAM operating constraints.

---

## Track 1: Data Model Integrity & Schema Design

**Goal**: Evaluate whether the data model is correctly normalized, consistently structured, efficiently indexed, and resilient to cascading failures.

### 1.1 D1 Schema Review (`apps/api/src/db/schema.ts`)

- **Normalization assessment**: Is every table in at least 3NF? Identify any denormalized fields and evaluate whether the denormalization is deliberate (performance) or accidental (drift).
- **Naming consistency**: Are all tables, columns, and indexes following a consistent convention (snake_case)? Are there any naming outliers?
- **Foreign key CASCADE safety**: Map the full CASCADE dependency tree. For each `ON DELETE CASCADE` relationship, assess: if the parent row is accidentally deleted, what is the blast radius? Are there tables where `ON DELETE RESTRICT` or `ON DELETE SET NULL` would be safer? Reference the cascade data loss incident in `docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md`.
- **Index coverage**: For every foreign key column, verify an index exists. For columns used in WHERE/ORDER BY/GROUP BY in service queries, verify appropriate indexes. Identify missing indexes that could cause full table scans.
- **Nullable vs sentinel patterns**: Are nullable columns used consistently? Are there places where sentinels (e.g., `TRIAL_ANONYMOUS_INSTALLATION_ID`) are used instead of nulls — and is this consistent?
- **Schema evolution safety**: Review the last 10 migrations in `apps/api/src/db/migrations/`. Are they all using safe patterns (ALTER TABLE ADD COLUMN) or are any using dangerous patterns (DROP TABLE, table recreation)?
- **Soft FK audit**: Several relationships use "soft FKs" (no database constraint, just convention). List them all and assess: is each one intentional (surviving resource deletion for billing/audit) or an oversight?
- **JSON column audit**: Identify all JSON-typed columns (e.g., `agentDefaults`, `budgetConfig`, `payload`). For each: is the JSON schema documented? Is there runtime validation? Could any be promoted to proper columns?

### 1.2 Durable Object Schema Review

- **Migration safety**: Review all DO migrations in `apps/api/src/durable-objects/migrations.ts`. Are they all idempotent? Do any use DROP TABLE?
- **FTS5 consistency**: The knowledge graph, chat messages, and SAM conversation all use FTS5 virtual tables. Are sync triggers consistent? Is the fallback (LIKE) behavior tested?
- **Data duplication**: Some data exists in both D1 and DO SQLite (e.g., task status is in D1 `tasks` table AND in DO `activity_events`). Map all intentional duplications and assess: are they kept in sync? What happens when they diverge?
- **DO storage limits**: Each DO SQLite can hold up to 10GB. Are there any tables with unbounded growth that could approach this limit? (e.g., `chat_messages` for very long-running sessions, `activity_events`)
- **Table count per DO**: How many tables does each DO type have? Is the ProjectData DO taking on too many concerns?

### 1.3 KV Usage Review

- **Key naming conventions**: Are KV keys consistently named? Is there a documented namespace convention?
- **TTL policy**: For each KV usage, is there an appropriate TTL? Are there keys that could accumulate without cleanup?
- **Read/write patterns**: KV is eventually consistent. Are there any read-after-write patterns that assume immediate consistency?

### 1.4 Deliverable

A table of every data entity, where it lives (D1 / DO / KV / R2), why it lives there, whether the placement is optimal, and any issues found.

---

## Track 2: Data Flow & Cross-Boundary Communication

**Goal**: Trace the primary data flows through the system and evaluate whether boundaries are clean, contracts are explicit, and communication is efficient.

### 2.1 Primary Flow Traces

For each of these critical user journeys, trace the complete data path from UI input to final output. At every system boundary (Browser → Worker, Worker → DO, Worker → VM Agent, VM Agent → Container), document:
- The exact HTTP method, path, and auth mechanism
- The request/response payload shape
- Whether there is a contract test or shared type ensuring both sides agree
- Where errors are caught and how they propagate

**Flows to trace:**
1. **Task submission**: User submits a task → API creates task → TaskRunner DO provisions node → workspace created → agent session started → agent produces output → messages persisted → UI displays results
2. **Chat message round-trip**: User sends a follow-up message in project chat → message reaches the running agent → agent responds → streaming tokens flow back to UI
3. **Mission orchestration**: SAM creates a mission with dependencies → tasks dispatched → handoff packets flow between completed tasks → orchestrator scheduling loop advances the DAG
4. **Knowledge graph update**: Agent calls `add_knowledge` MCP tool → entity/observation created in DO → retrieved via `get_relevant_knowledge` in next session
5. **Credential resolution**: Task needs an API key → resolve from project override → user credential → platform credential → fail

### 2.2 Contract Alignment

- **Shared types**: Are request/response types shared between the API and web client? Between the API and VM agent? Or are they duplicated?
- **Auth mechanism consistency**: The system uses multiple auth mechanisms (session cookies, JWT callback tokens, MCP tokens, workspace tokens, query parameter tokens). Map every auth mechanism to its consumers and verify consistency.
- **Error shape consistency**: When the API returns an error, is the shape consistent across all routes? When the VM agent returns an error, does it match what the Worker expects?

### 2.3 Efficiency Assessment

- **N+1 query patterns**: Are there routes or service functions that make multiple sequential database queries where a single joined query would suffice?
- **Payload bloat**: The compact mode for chat messages was added to reduce payload sizes by 80-90%. Are there other endpoints that transfer unnecessarily large payloads?
- **Unnecessary round-trips**: Are there places where data is fetched from one service, transformed, then sent to another — when it could be passed directly?
- **DO fan-out**: Cross-project queries require hitting D1. Are there any paths that accidentally fan out to multiple DOs when they should use D1?
- **WebSocket vs polling**: Where does the system use WebSocket (Hibernatable) vs SSE vs polling? Is each choice appropriate for the use case?

### 2.4 Deliverable

A data flow diagram (Mermaid) for each primary flow, annotated with auth mechanisms, payload sizes, and identified inefficiencies.

---

## Track 3: Code Organization & Agent Navigability

**Goal**: Evaluate whether the codebase is structured so that both AI agents and humans can quickly find, understand, and modify code.

### 3.1 File Size & Complexity

- **Oversized files**: Run `find apps/ packages/ -name '*.ts' -o -name '*.tsx' -o -name '*.go' | grep -v node_modules | grep -v dist | grep -v '.test.' | grep -v '.spec.' | xargs wc -l | sort -rn | awk '$1 > 400'`. For every file over 500 lines, assess: can it be split without increasing import complexity? Reference the existing backlog task `tasks/backlog/2026-04-03-split-oversized-files.md`.
- **Function length**: Identify functions over 50 lines (constitution Principle IV). Are they justified, or should they be broken down?
- **Cyclomatic complexity**: Identify the most complex functions (deep nesting, many branches). Are they tested proportionally to their complexity?
- **Single Responsibility**: Does each file/module have a clear, single responsibility? Or are there "kitchen sink" files that accumulate unrelated concerns?

### 3.2 Discoverability

- **Naming clarity**: Can an agent (or human) find a feature by searching for its name? For example, if someone searches for "knowledge graph," do they find `knowledge-tools.ts` easily? Are there misleading or overly generic names?
- **Directory structure predictability**: Given a feature name, can you predict where its code lives? Test with 5 features: notification system, trial orchestrator, AI proxy, file library, mission orchestration. How many hops does it take to find each?
- **Barrel file quality**: Are index.ts re-exports clear and maintained? Or are there barrel files that re-export everything, making it hard to trace imports?
- **Dead code**: Search for exports that have zero consumers. Search for route handlers that are registered but unreachable. Search for components that are imported nowhere.
- **Agent search affordances**: For each major feature, identify the 3-5 search terms an agent would naturally try. Do those terms find the canonical route, service, component, data type, tests, and docs? Note mismatches between product vocabulary, code names, database names, and docs.
- **Change locality**: For common feature edits, how many packages must an agent touch? A well-organized feature should have clear ownership boundaries and predictable cross-package contracts. Identify workflows where small changes require broad, fragile edits.

### 3.3 Documentation Quality (Code-Level)

- **Inline comments**: Are "why" comments present for non-obvious logic? Are there stale comments that describe behavior that no longer exists?
- **Type expressiveness**: Are types used to encode business rules (e.g., branded types for IDs, discriminated unions for status)? Or are they loosely typed (string, any, unknown)?
- **CLAUDE.md accuracy**: Is the "Recent Changes" section in CLAUDE.md up-to-date with the last 5 merged PRs? Are the architecture descriptions still accurate?
- **Instruction entropy**: Compare `AGENTS.md`, `CLAUDE.md`, `.claude/rules/`, `.agents/skills/`, and `.codex/prompts/`. Are rules duplicated, contradictory, stale, or too broad? Are high-risk instructions close to the code they govern?
- **Context budget discipline**: Identify instructions that agents load every session but can infer from code or docs on demand. Recommend what should move from always-loaded instructions into focused skills, guides, or task-specific prompts.

### 3.4 Go Codebase (VM Agent)

- **Package cohesion**: Does each Go package under `packages/vm-agent/internal/` have a clear responsibility? Are there packages with too many exported symbols?
- **Error handling**: Is error wrapping consistent? Are errors propagated with context (`fmt.Errorf("...: %w", err)`)? Are there silent error swallows?
- **Concurrency safety**: Are shared-state accesses protected by mutexes? Are there goroutine leaks (goroutines started without shutdown paths)?
- **slog usage**: Is structured logging consistent across the Go codebase? Are log levels appropriate?

### 3.5 Deliverable

A navigability scorecard rating each package/app on: naming clarity (1-5), structural predictability (1-5), documentation quality (1-5), file size compliance (1-5), and dead code absence (1-5).

---

## Track 4: Coding Standards & Consistency

**Goal**: Evaluate whether the codebase follows consistent patterns and whether the patterns are appropriate for the stack.

### 4.1 TypeScript Patterns

- **Type assertion audit**: Search for `as ` type assertions. How many exist? Are they justified (e.g., framework limitations) or lazy (avoiding proper typing)?
- **Runtime validation**: The project prefers Valibot for validation. Is Valibot actually used at API boundaries? Are there routes that accept unvalidated input?
- **Import organization**: Are imports consistently ordered? (The project uses `eslint-plugin-simple-import-sort`.) Are there violations?
- **`useEffect` audit (React)**: List all `useEffect` calls in the web app. For each, assess: is this the right React primitive? Could it be replaced with an event handler, useMemo, or a custom hook?
- **Error boundary coverage**: Are React error boundaries in place for major page sections? What happens when a component throws?

### 4.2 API Patterns

- **Route handler structure**: Are all route handlers structured consistently? (Input validation → auth check → service call → response formatting)
- **Service layer separation**: Is business logic in service files, or has it leaked into route handlers or DO methods?
- **Response shape consistency**: Do all API responses follow the same envelope pattern? Are error responses consistent?
- **Middleware consistency**: Is auth middleware applied consistently? Are there routes that should require auth but don't?

### 4.3 Go Patterns

- **Interface usage**: Are interfaces defined where they're used (consumer-side), per Go convention? Or are they defined alongside implementations?
- **Context propagation**: Is `context.Context` passed through the call chain consistently? Are there functions that should accept context but don't?
- **Resource cleanup**: Are file handles, HTTP clients, and connections properly closed? (Check for `defer` patterns.)
- **Test isolation**: Do Go tests use `t.Parallel()` where possible? Are there tests that depend on global state?

### 4.4 CSS/Styling

- **Tailwind adoption**: The project migrated to Tailwind CSS v4 (spec 024). Are there lingering CSS-in-JS or raw CSS styles that should be migrated?
- **Design token usage**: Are spacing, colors, and typography using the design system tokens from `packages/ui/`? Or are there hardcoded values?
- **Responsive design**: Is mobile-first design consistently applied? Are there components that break on small viewports?

### 4.5 Deliverable

A coding standards compliance matrix with pass/fail/partial for each category, plus a list of the top 20 most impactful violations to fix.

---

## Track 5: Performance & Cost Efficiency

**Goal**: Evaluate whether the system uses Cloudflare primitives efficiently and whether there are unnecessary costs.

### 5.1 Cloudflare Cost Model Analysis

- **D1 query volume**: Which routes generate the most D1 queries? Are there opportunities to batch or cache?
- **DO duration billing**: DOs are billed for wall-clock time while active. Are there DOs that stay active longer than necessary? Is the WebSocket Hibernation API used everywhere it should be?
- **KV read/write ratio**: KV charges per read and write. Are there hot keys being read on every request that could be cached in-memory?
- **R2 operations**: Are R2 reads/writes batched where possible? Are there unnecessary list operations?
- **Worker CPU time**: Which routes are CPU-intensive? Are there computation-heavy operations that could be moved to Durable Objects or queued?
- **AI Gateway costs**: Is AI Gateway usage optimized? Are there redundant calls? Is caching enabled for repeated prompts?

### 5.2 Query Performance

- **Slow query identification**: Review the most complex SQL queries in `apps/api/src/services/`. Do they use appropriate indexes? Are there joins that could be eliminated?
- **DO SQLite query patterns**: Review queries in the ProjectData DO. Are there sequential queries that could be combined? Are there missing indexes on frequently-queried columns?
- **Pagination**: Are all list endpoints paginated? Are there endpoints that return unbounded result sets?

### 5.3 Frontend Performance

- **Bundle size**: What is the current bundle size for `apps/web/`? Are there large dependencies that could be lazy-loaded?
- **Render efficiency**: Are there components that re-render unnecessarily? (Check for missing `useMemo`, `useCallback`, or React.memo where appropriate.)
- **Data fetching**: Is data fetched at the right granularity? Are there pages that over-fetch? Is there any client-side caching?
- **Image optimization**: Are images optimized? Are there SVGs that should be inlined vs loaded as assets?

### 5.4 VM Agent Performance

- **Binary size**: What is the compiled VM agent binary size? Are there unnecessary dependencies?
- **Memory usage**: Are there memory leaks in long-running processes (PTY sessions, WebSocket connections)?
- **Docker operations**: Are Docker API calls efficient? Are container operations batched where possible?

### 5.5 Deliverable

A cost model estimate (monthly) for a typical workload (10 users, 50 tasks/day, 5 concurrent workspaces) broken down by Cloudflare service. Identify the top 5 cost reduction opportunities.

---

## Track 6: Testing & Experiment Infrastructure

**Goal**: Evaluate whether the testing infrastructure supports confident iteration and whether agents can effectively run experiments.

### 6.1 Test Coverage & Quality

- **Coverage gaps**: Run `pnpm test -- --coverage` across all packages. Identify modules with <80% coverage, especially in critical paths (task execution, credential resolution, session lifecycle).
- **Test type distribution**: What is the ratio of unit tests to integration tests to E2E tests? Is it appropriate for the system's architecture?
- **Mock realism**: Review the most complex test files. Are mocks realistic, or do they hide real integration issues? (Reference the post-mortem in `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md` about mocks hiding a completely broken feature.)
- **Miniflare coverage**: Are all D1 queries, KV operations, and DO interactions tested with Miniflare? Or are some tested with in-memory mocks that don't replicate real behavior?
- **Regression test existence**: For every post-mortem in `docs/notes/`, verify that a corresponding regression test exists.

### 6.2 Agent Experiment Loop

- **Local iteration speed**: How long does `pnpm test` take? How long does `pnpm build` take? How long does a full CI run take? Are these fast enough for tight agent iteration loops?
- **Test isolation**: Can an agent run tests for a single package without building the entire monorepo?
- **Visual testing**: Is the Playwright visual audit setup (`.claude/rules/17-ui-visual-testing.md`) functional and producing useful results?
- **Staging feedback loop**: How long from code push to staging deploy to verified result? Can this be shortened?
- **Self-verifying tasks**: For each major work type (API route, UI component, DO migration, VM agent change, docs-only change), is there a documented minimal verification command and a stronger pre-PR verification path? Agents should not have to infer the right checks from CI.
- **Fixture and mock discoverability**: Can agents find realistic fixtures quickly? Are mock data builders named by domain concepts, or hidden in test files with ad hoc shapes?
- **Failure reproduction path**: For production bugs and post-mortems, is there a clear command or test that reproduces the issue locally before the fix?

### 6.3 Configuration for Experimentation

- **Feature flags**: Are feature flags used for experimental features? Can an agent enable/disable features via KV without redeploying?
- **Configurable constants**: The constitution requires all limits/timeouts/thresholds to be configurable via environment variables. Audit compliance: are there hardcoded values that should be configurable?
- **A/B testing capability**: Can the system run A/B experiments (e.g., different agent prompts, different VM sizes) and measure outcomes?
- **Agent profile experimentability**: Are prompts, skills, model/tool profiles, VM sizes, and workspace setup parameters versioned and attributable to task outcomes? Can an agent compare two profile versions without mixing state?
- **Trace durability**: Are prompts, tool calls, command outputs, errors, test results, and resource usage persisted in a way that future agents can search and learn from?

### 6.4 Deliverable

A test health report showing coverage by package, test type distribution, mock realism scores, and a list of untested critical paths. Plus an "experiment readiness" scorecard for agent iteration.

---

## Track 7: Security & Multi-Tenant Isolation

**Goal**: Evaluate credential handling, multi-tenant isolation, and OWASP compliance.

### 7.1 Credential Security

- **Encryption audit**: All user credentials should be AES-256-GCM encrypted. Verify: are there any credentials stored unencrypted? Are IVs unique per encryption operation?
- **Key management**: How are encryption keys managed? Is key rotation supported? What happens if `ENCRYPTION_KEY` is compromised?
- **Credential resolution**: Review the 3-tier credential resolution (project → user → platform). Is the "inactive project credential blocks fallback" invariant tested? (Reference `.claude/rules/28-credential-resolution-fallback-tests.md`.)
- **Token lifecycle**: Map all token types (session tokens, callback tokens, MCP tokens, OAuth tokens). For each: what is the lifetime? How is it revoked? What is the blast radius if compromised?
- **Secret exposure**: Are there any code paths that could leak credentials in logs, error messages, or API responses?

### 7.2 Multi-Tenant Isolation

- **User isolation at DB level**: Are all D1 queries properly scoped to `userId`? Is there a defense-in-depth check after query (row.userId === callerUserId)?
- **Project isolation at DO level**: Each project gets its own DO. But can a user access another user's project DO? Is ownership verified at the API layer before forwarding to the DO?
- **VM isolation**: Different users must never share a node. Verify this constraint is enforced in node selection and provisioning logic.
- **Cross-tenant data leak audit**: For each list endpoint, verify it only returns the authenticated user's data. Pay special attention to admin endpoints — do they properly check admin role?

### 7.3 Input Validation & Injection

- **SQL injection**: Are all D1 queries parameterized? Are there any string-concatenated queries?
- **Path traversal**: File upload/download paths — are they validated against traversal attacks?
- **XSS**: Are user-provided strings properly escaped in the React UI? Are there `dangerouslySetInnerHTML` usages?
- **Command injection**: The VM agent runs Docker and shell commands. Are user inputs ever interpolated into commands without sanitization?
- **CORS**: Review all CORS configurations. Do any use wildcard origins with credentials?

### 7.4 Deliverable

A security findings report with severity ratings, specific vulnerable code paths, and remediation recommendations.

---

## Track 8: Architecture Alignment & Technical Debt

**Goal**: Evaluate whether the current architecture matches the project's trajectory and identify strategic debt.

### 8.1 Architecture Decision Alignment

- **ADR currency**: Review all ADRs in `docs/adr/`. Are they still accurate? Are there architectural decisions that have drifted from their original intent?
- **Spec vs reality**: For the 5 most recent specs in `specs/`, compare the specified architecture with the implemented architecture. Where have they diverged?
- **Constitution compliance**: Run a systematic check of constitution Principle XI (No Hardcoded Values) across all service files. List all violations.

### 8.2 Technical Debt Inventory

- **Known debt**: Review all backlog tasks in `tasks/backlog/`. Categorize them by: security, performance, code quality, UX, infrastructure. Which categories have the most items?
- **Unknown debt**: Based on your review across all tracks, what debt exists that isn't captured in backlog tasks?
- **Debt hotspots**: Which files/modules have accumulated the most debt? (Correlate: file size + number of post-mortems referencing that file + number of backlog tasks referencing that file.)

### 8.3 Evolutionary Architecture Assessment

- **Plugin readiness**: The business strategy calls for a plugin architecture to separate open-source core from billing. How feasible is this today? What coupling exists that would need to be broken?
- **Provider abstraction**: The provider system (Hetzner, Scaleway, GCP) — is the abstraction clean enough to add new providers easily? Or is Hetzner-specific logic leaking into shared code?
- **Cloudflare Containers readiness**: There's interest in using Cloudflare Containers for SAM agents. What would need to change in the current architecture to support this?
- **Scalability bottlenecks**: If the system scales to 100 users / 1000 tasks per day, what breaks first? D1 write throughput? DO count? VM provisioning rate? AI Gateway rate limits?

### 8.4 Deliverable

A strategic debt map: a prioritized list of architectural changes needed, sized by effort (S/M/L/XL) and impact (low/medium/high/critical), with a recommended sequence.

---

## Track 9: Agent-Ready Repository Architecture

**Goal**: Evaluate whether the repository is organized as an effective working environment for coding agents, not just as a conventional human-maintained monorepo. This track focuses on how agents load context, discover capabilities, verify work, coordinate subtasks, and preserve useful knowledge across sessions.

### 9.1 Instruction Architecture

- **Root instruction audit**: Review `AGENTS.md`, `CLAUDE.md`, and any equivalent agent entry points. Do they contain only durable, broadly applicable rules? Identify content that should move to a focused guide or skill because it is long, specialized, or rarely needed.
- **Nested instruction opportunity**: For each major surface (`apps/api`, `apps/web`, `apps/www`, `packages/vm-agent`, `packages/ui`, `packages/providers`), decide whether a nested `AGENTS.md` would reduce context load or prevent mistakes. Recommend exact sections for each nested file: commands, local gotchas, relevant tests, ownership boundaries, and examples.
- **Instruction precedence**: Document how instructions should resolve when root, nested, skill, task, and user instructions conflict. Verify the repo's current files do not create ambiguous precedence.
- **Rule deduplication**: Identify repeated rules across `.claude/rules/`, `AGENTS.md`, `CLAUDE.md`, skills, and prompts. Recommend a single source of truth and link strategy.
- **Human vs agent docs split**: Confirm README and public docs stay human-oriented while `AGENTS.md` and skills carry agent-specific operational detail.

### 9.2 Context Map & Code Discovery

- **Feature index**: Determine whether the repo has a machine-readable or easily searchable map from product concepts to routes, services, storage tables, components, tests, and docs. If not, propose one.
- **Boundary index**: For every cross-boundary contract (Browser/API, API/DO, API/VM Agent, MCP/API, worker/provider), identify the canonical type/schema/test file an agent should start from.
- **Search vocabulary alignment**: Compare user-facing names, route names, database table names, task names, and doc headings. Flag concepts where agents are likely to search the wrong term.
- **Ownership markers**: Check whether directories expose clear ownership and risk markers: security-sensitive, infra-sensitive, migration-sensitive, UI visual-test required, staging-verification required.
- **Generated vs authored code**: Verify generated files, build artifacts, migrations, and hand-authored files are clearly distinguished so agents edit the right source.

### 9.3 Tool & MCP Surface Design

- **Tool catalog size**: Count available SAM MCP tools and deferred tools. Are agents forced to load too many tool schemas up front, or is there progressive discovery through search/inspect/execute style tools?
- **Tool naming and descriptions**: Are tool names action-oriented and domain-specific? Do descriptions mention side effects, auth scope, required IDs, and output shape?
- **Structured outputs**: Do tool outputs return compact structured data that can be composed by agents, or verbose prose that wastes context and is hard to validate?
- **Error compactness**: Are tool and API errors concise but actionable, with stable error codes, admin-only detail where appropriate, and copy-paste-ready debugging context?
- **Tool-to-code traceability**: For every MCP tool, can an agent quickly find the API route/service/DO method it wraps? Add references where missing.

### 9.4 Verification Affordances

- **Check matrix**: Build a matrix from change type to minimal local verification, stronger local verification, and staging verification. Example rows: D1 migration, ProjectData DO change, Hono route, React UI, VM agent WebSocket, cloud-init template, docs-only.
- **Fast-path commands**: Are package-specific commands documented so agents can avoid expensive whole-repo checks during iteration while still running full gates before PR?
- **Deterministic fixtures**: Are there stable fixtures for common project/workspace/task/session states, including failure states and high-volume data?
- **Visual baselines**: For UI surfaces, can agents run mock-data screenshots without auth or live API dependency?
- **Contract tests**: Are inter-service HTTP and WebSocket contracts testable without provisioning real VMs unless the behavior genuinely requires staging?

### 9.5 Agent Coordination & Knowledge Persistence

- **Task decomposition readiness**: Can review or implementation work be split into independent tasks with clear write ownership? Identify packages where coupling prevents parallel work.
- **Handoff packet quality**: Are agent handoffs structured enough for another agent to continue without replaying the whole session? Evaluate task files, PR descriptions, and SAM session summaries.
- **Persistent knowledge hygiene**: Are durable learnings captured in the right place (knowledge graph, policy, rule, doc, backlog task) instead of being trapped in chat history?
- **Decision records**: Are architecture decisions, experiment results, model/tool profile changes, and staging failures preserved with enough evidence for later agents to trust or revise them?
- **Review specialization**: Are specialist skills/subagents aligned with actual code ownership and risk surfaces? Identify missing specialists or overly broad ones.

### 9.6 Deliverable

An agent-readiness report containing:

1. A repository context map showing which files an agent should read first for each major work type
2. A proposed nested `AGENTS.md` layout for the monorepo, with exact content recommendations
3. A tool/MCP surface scorecard covering discoverability, schema quality, side-effect clarity, and output compactness
4. A verification matrix by change type
5. A prioritized list of repository changes that would most improve agent speed, correctness, and reviewability

---

## Execution Guide

### Running as a Single Deep Review

If executing this prompt as a single agent session:

1. Start with Track 1 (Data Model) and Track 3 (Code Organization) — these inform all other tracks
2. Then Track 2 (Data Flow) and Track 4 (Coding Standards)
3. Then Track 5 (Performance), Track 6 (Testing), Track 7 (Security)
4. Run Track 9 (Agent-Ready Repository Architecture) after Track 3 and Track 6 have produced initial findings
5. Finish with Track 8 (Architecture Alignment) — this synthesizes findings from all other tracks, including Track 9
6. Produce the unified report with the prioritized action plan

### Running as Parallel Agent Tasks

If decomposing into subtasks via SAM's `dispatch_task`:

- Tracks 1, 3, 5, 6, and 7 can run independently in parallel
- Track 2 benefits from Track 1 results but can start concurrently
- Track 4 benefits from Track 3 results but can start concurrently
- Track 9 benefits from Track 3 and Track 6 results but can start concurrently if focused on instruction/tool/documentation architecture
- Track 8 MUST run last — it synthesizes findings from all other tracks

Each agent should use the `/do` skill and produce findings in the report format below.

### Report Format

Each finding should follow this structure:

```markdown
### [SEVERITY] Finding Title

**Track**: N — Track Name
**Location**: `file/path.ts:line_number` (or range)
**Category**: data-model | data-flow | navigability | standards | performance | testing | security | architecture | agent-readiness

**Finding**: What was observed.

**Impact**: What happens if this isn't addressed.

**Recommendation**: What should be done, with specific code changes if applicable.

**Effort**: S / M / L / XL
```

### Severity Definitions

| Severity | Definition | Action |
|----------|-----------|--------|
| **CRITICAL** | Data loss risk, security vulnerability, or production-breaking issue | Fix immediately |
| **HIGH** | Significant performance issue, missing isolation, or broken contract | Fix within current sprint |
| **MEDIUM** | Code quality issue, missing test, or inconsistency that increases risk | Fix within next 2 sprints |
| **LOW** | Style issue, minor optimization, or documentation gap | Fix opportunistically |
| **INFO** | Observation or recommendation with no immediate risk | Consider for roadmap |

---

## Success Criteria

The review is complete when:

1. Every track has been evaluated with specific file references
2. All CRITICAL and HIGH findings have been identified and categorized
3. The data model has been fully mapped (every table, every relationship, every storage location)
4. At least 5 primary data flows have been traced end-to-end with boundary documentation
5. Agent-readiness has been evaluated for instruction architecture, context maps, MCP/tool surfaces, verification affordances, and knowledge persistence
6. A prioritized action plan exists with effort estimates
7. The findings are actionable — an agent could pick up any finding and implement the fix without ambiguity
