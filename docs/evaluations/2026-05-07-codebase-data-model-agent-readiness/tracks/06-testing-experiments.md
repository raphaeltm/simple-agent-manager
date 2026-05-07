# Track 6: Testing & Experiment Infrastructure

Status: **Complete** (2026-05-07)

---

## Executive Summary

SAM has a large, multi-layered testing infrastructure (523 test files across TypeScript and Go) with strong foundations: Miniflare-backed Durable Object tests, realistic provider fetch mocks, Go tests with real crypto/HTTP libraries, and 30 Playwright visual audit specs. CI enforces 18 jobs including specialized quality gates for migration safety, file sizes, and source-contract test detection.

However, several structural gaps weaken confidence in critical paths: no coverage thresholds are enforced, TaskRunner and NodeLifecycle DOs lack Miniflare integration tests (the two most important state machines), the Go race detector is not enabled in CI, and 8 of 36 post-mortem regression tests are partial or missing. The experiment infrastructure is rudimentary — only one runtime-toggleable feature flag exists (trials kill-switch via KV), agent profiles are not versioned, and no A/B testing framework is present.

**Key metrics:**
- 523 total test files (455 TypeScript + 68 Go)
- 11 Miniflare-backed DO/route tests in `apps/api/tests/workers/`
- 30 Playwright visual audit specs
- 36 post-mortems, 28 with full/strong regression tests (78%), 4 with no regression test
- 0 coverage thresholds enforced in any vitest config
- 0 `go test -race` invocations in CI
- 1 runtime feature flag via KV (trials kill-switch), 17 env-var-based kill switches

---

## 6.1 Test Coverage & Quality

### 6.1.1 Test File Distribution by Package

| Package | Test Files | Test Types | Notes |
|---------|-----------|------------|-------|
| `apps/api` | 237 | Unit (226+), Workers/Miniflare (11), Integration (~10) | Largest suite; Workers tests are the highest-fidelity |
| `apps/web` | 158 | Unit/RTL (128), Playwright visual (30) | Good component coverage; Playwright specs are visual audit only |
| `packages/vm-agent` (Go) | 68 | Unit, Integration (build tag), E2E (build tag) | Strong Go testing patterns; integration/E2E gated by build tags |
| `packages/acp-client` | 19 | Unit (components + hooks) | Good coverage for shared UI components |
| `packages/providers` | 9 | Unit + Contract | Realistic fetch mock factories in `tests/fixtures/` |
| `packages/shared` | 8 | Unit | Constants, model validation |
| `packages/ui` | 7 | Unit | Design system primitives |
| `infra` | 5 | Unit | Pulumi resource tests |
| `packages/terminal` | 3 | Unit | Terminal protocol + hooks |
| `packages/cloud-init` | 1 | Unit | Single test file covering 547 lines of source |
| `apps/tail-worker` | ~1 | Unit | Minimal |

### 6.1.2 Test Type Distribution

```
Unit tests:         ~85% (mocked service/component tests)
Miniflare Workers:   ~2% (real D1/KV/DO integration)
Go integration/E2E:  ~3% (real Docker, build-tag gated)
Playwright visual:   ~6% (mock-data UI screenshots)
Contract tests:      ~1% (provider HTTP contracts)
Quality scripts:     ~3% (AST checks, migration safety, file sizes)
```

**Assessment**: The distribution is heavily skewed toward unit tests with mocks. The 11 Miniflare-backed tests provide high-fidelity DO coverage for ProjectData, AdminLogs, SamSession, and route auth validation, but the two most critical state machines — **TaskRunner DO** and **NodeLifecycle DO** — have zero Miniflare integration tests. These are tested only with vi.mock() unit tests that cannot exercise real D1 transactions, DO alarm scheduling, or multi-step state machine flows.

### 6.1.3 Coverage Thresholds

**Finding**: No vitest config in the entire monorepo enforces coverage thresholds. Every package has `coverage` configured for V8 provider output, but no `thresholds` block exists in any config.

**Reference**: The backlog task `tasks/backlog/2026-03-03-improve-test-infrastructure.md` already identifies this gap and proposes `{ lines: 70, functions: 70, branches: 60, statements: 70 }` as a starting threshold.

### 6.1.4 Post-Mortem Regression Test Coverage

Of 36 post-mortems in `docs/notes/`, regression test coverage breaks down as:

| Category | Count | Percentage |
|----------|-------|-----------|
| Full/strong regression test | 22 | 61% |
| Partial regression test | 10 | 28% |
| No regression test | 4 | 11% |

**Post-mortems with NO regression test:**

| Post-Mortem | Description | Gap Reason |
|------------|-------------|------------|
| `2026-03-30-duplicate-settings-controls-postmortem.md` | Two UI controls managing same API field | UI deduplication not testable with current infrastructure |
| `2026-03-31-pr568-premature-merge-postmortem.md` | PR merged while reviewers still running | Process/policy issue, not a code regression |
| `2026-04-21-pulumi-state-removal-postmortem.md` | Pulumi stack removed despite failed destroy | Workflow state management, not code |
| `2026-03-25-env-var-single-quote-stripping-postmortem.md` | Env var writer used single quotes | Round-trip quote test may be missing |

**Post-mortems with PARTIAL regression tests (notable gaps):**

| Post-Mortem | What's Missing |
|------------|----------------|
| `2026-03-30-r2-cors-upload-failure-postmortem.md` | No CORS-specific test; routing/auth aspects only partially covered |
| `2026-04-22-chat-idle-cleanup-message-activity-postmortem.md` | Missing "cleanup-during-persist" scenario test |
| `2026-03-08-mcp-token-revocation-postmortem.md` | Missing multi-call sequence test proving token survives beyond task scope |
| `2026-03-17-mcp-token-ttl-too-short-postmortem.md` | Missing cross-constant validation (TTL < max execution time) |

---

## 6.2 Agent Experiment Loop

### 6.2.1 Local Iteration Speed

| Command | Scope | Approximate Duration | Notes |
|---------|-------|---------------------|-------|
| `pnpm test` (turbo) | All packages | ~60-90s | Parallelized via Turbo |
| `pnpm --filter api test` | API unit tests | ~30-45s | Excludes Workers tests |
| `pnpm --filter api test:workers` | Miniflare DO tests | ~15-30s | 11 test files |
| `pnpm --filter web test` | Web unit tests | ~20-30s | 128+ RTL tests |
| `go test ./...` (vm-agent) | Go unit tests | ~10-20s | Fast, parallel |
| `pnpm build` | Full monorepo build | ~60-120s | Build-order dependent |
| `pnpm typecheck` | All packages | ~30-60s | TSC, no emit |
| Full CI pipeline | All jobs | ~7-15 min | 18 parallel jobs |
| Staging deploy + verify | Deploy + Playwright | ~10-15 min | Manual trigger, 7-min deploy |

**Assessment**: Local iteration speed is **good for unit tests** — agents can run per-package tests in under a minute. The staging feedback loop (~15 min from push to verified result) is acceptable but cannot be shortened without infrastructure changes. The CI pipeline is well-parallelized.

### 6.2.2 Test Isolation

Tests can be run per-package without building the full monorepo, with one caveat:

- `pnpm --filter @simple-agent-manager/api test` works independently
- `pnpm --filter @simple-agent-manager/web test` works independently
- `go test ./...` in `packages/vm-agent/` is fully independent
- **Caveat**: packages that depend on `@simple-agent-manager/shared` need `shared` built first. The build order (`shared` → `providers` → `cloud-init` → `api/web`) is documented in CLAUDE.md.

### 6.2.3 Visual Testing Infrastructure

**Playwright config** (`apps/web/playwright.config.ts`):
- 3 viewport projects: iPhone SE (375x667), iPhone 14 (390x844), Desktop (1280x800)
- Dark color scheme by default, 2x device scale factor
- Local Vite preview server on port 4173
- Screenshots output to `.codex/tmp/playwright-screenshots/` (gitignored)
- Single worker, no retries (deterministic)
- 30 visual audit spec files covering major UI surfaces

**Assessment**: The visual testing setup is **well-designed** for agent use. Mock data factories are defined inline in each spec, allowing diverse data scenarios (empty, long text, many items, errors). The overflow detection assertion pattern (`scrollWidth > innerWidth`) is documented in rule 17 and consistently applied.

**Gap**: Playwright tests run against a self-contained Vite preview build with mock API routes. There are no Playwright tests that run against the real staging API. Staging verification is done ad-hoc by agents following rule 13, not via a reusable Playwright test suite.

### 6.2.4 Staging Feedback Loop

The staging verification flow documented in `.claude/rules/13-staging-verification.md`:

1. `gh workflow run deploy-staging.yml --ref <branch>` (~7 min deploy)
2. Authenticate via `POST /api/auth/token-login` with `SAM_PLAYWRIGHT_PRIMARY_USER`
3. Navigate `app.sammy.party` and exercise features
4. Evidence captured as screenshots/observations

**Gap**: There is no **reusable staging smoke test suite**. Each agent writes ad-hoc Playwright scripts for staging verification. A standard `staging-smoke.spec.ts` that covers the regression checklist from rule 13 would eliminate repeated work and provide more consistent verification.

### 6.2.5 Self-Verifying Task Commands

| Work Type | Minimal Local Verification | Stronger Verification | Staging Required? |
|-----------|---------------------------|----------------------|-------------------|
| API route | `pnpm --filter api test` | `pnpm --filter api test:workers` (if DO-touching) | Yes, for auth/DNS |
| UI component | `pnpm --filter web test` | Playwright visual audit spec | Only for real data |
| DO migration | `pnpm quality:do-migration-safety` | Miniflare test with migration applied | Yes, for persistence |
| D1 migration | `pnpm quality:migration-safety` | Manual D1 query via CF API | Yes, for data |
| VM agent (Go) | `go test ./...` | `go test -tags integration ./...` | Yes, for real VM |
| Cloud-init template | `pnpm --filter cloud-init test` | Parse YAML output + round-trip PEM | Yes, for provisioning |
| Docs only | N/A | N/A | No |

**Assessment**: Verification commands are documented in CLAUDE.md ("Common Commands" section) but not organized by work type. An agent must know to run `test:workers` separately from `test` for the API package. The quality scripts are powerful but not all are referenced from a single "verify locally" entry point.

### 6.2.6 Fixture and Mock Discoverability

**Centralized fixtures found:**
- `packages/providers/tests/fixtures/` — `scaleway-mocks.ts`, `hetzner-mocks.ts` with factory functions (`createMockScalewayServer`, `createScalewayFetchMock`)
- `apps/web/tests/setup.ts` — Global test setup with `matchMedia`, `IntersectionObserver` mocks

**Missing centralization:**
- `apps/api/tests/` has no shared `test-helpers.ts` or `fixtures/` directory. Helper factories like `createNode()`, `createWorkspace()` are **redefined inline in each test file**.
- `InMemorySqlStorage` mock is defined identically in two files: `apps/api/tests/integration/project-data.test.ts` and `apps/api/tests/integration/chat-session-lifecycle.test.ts`.
- No shared mock factory registry or README listing available fixtures.

**Agent discoverability**: An agent looking for "how to mock a workspace in tests" has no single entry point. They must grep for `createWorkspace` or `createMockWorkspace` across test files and hope one of the results has a reusable factory.

### 6.2.7 Failure Reproduction Path

For production bugs documented in post-mortems, the reproduction path varies:

- **Good**: The TLS YAML indentation bug (`2026-03-12`) has a clear reproduction test in `packages/cloud-init/tests/generate.test.ts` with realistic multi-line PEM data and YAML parsing.
- **Good**: The migration cascade data loss (`2026-04-25`) has a CI quality gate (`check-migration-safety.ts`) that catches the class of bug automatically.
- **Weak**: The R2 CORS upload failure (`2026-03-30`) has no local reproduction — CORS is only exercisable in a real browser against a real R2 bucket.
- **Weak**: Chat session leakage bugs (`2026-03-07`) required multiple tests across 4 different files to cover; no single "reproduce the leak" command exists.

---

## 6.3 Configuration for Experimentation

### 6.3.1 Feature Flags

**Runtime-toggleable (KV-backed):**

| Flag | KV Key | File | Notes |
|------|--------|------|-------|
| Trials enabled | `trials:enabled` | `apps/api/src/services/trial/kill-switch.ts:1-62` | 30s in-memory cache, fail-closed, only KV-backed flag |

**Env-var-based kill switches (17 found in `apps/api/src/env.ts`):**

| Flag | Env Var | Default |
|------|---------|---------|
| Smoke test auth | `SMOKE_TEST_AUTH_ENABLED` | disabled |
| Task title generation | `TASK_TITLE_GENERATION_ENABLED` | enabled |
| TTS | `TTS_ENABLED` | enabled |
| Codex refresh proxy | `CODEX_REFRESH_PROXY_ENABLED` | enabled |
| Analytics | `ANALYTICS_ENABLED` | true |
| Analytics ingest | `ANALYTICS_INGEST_ENABLED` | true |
| Analytics forwarding | `ANALYTICS_FORWARD_ENABLED` | false |
| Compute quota enforcement | `COMPUTE_QUOTA_ENFORCEMENT_ENABLED` | true |
| Cron sweep | `CRON_SWEEP_ENABLED` | enabled |
| Trigger execution cleanup | `TRIGGER_EXECUTION_CLEANUP_ENABLED` | enabled |
| AI proxy | `AI_PROXY_ENABLED` | enabled |
| Cost monitoring | `COST_MONITORING_ENABLED` | true |
| SAM FTS5 search | `SAM_FTS_ENABLED` | true |
| Sandbox routes | `SANDBOX_ENABLED` | false |
| Artifacts | `ARTIFACTS_ENABLED` | varies |

**Assessment**: Env-var kill switches require a redeploy to toggle. Only the trials kill-switch can be toggled at runtime via KV (using the CF API `PUT /kv/values/trials:enabled`). An agent experimenting with features must redeploy to toggle most flags.

**Gap**: No general-purpose runtime feature flag system exists. The trials kill-switch pattern (`kill-switch.ts`) is well-designed (KV + cache + fail-closed) but not generalized into a reusable `FeatureFlag` utility.

### 6.3.2 Configurable Constants (Constitution Principle XI Compliance)

The codebase **comprehensively follows Principle XI**. Key constant files:

- `packages/shared/src/constants/defaults.ts` (109 lines) — All system limits with `DEFAULT_*` constants
- `packages/shared/src/constants/ai-services.ts` (200+ lines) — Model IDs, timeouts, retry counts
- `packages/shared/src/constants/missions.ts` — Mission/orchestration limits
- `packages/shared/src/constants/policies.ts` — Policy limits with `resolvePolicyLimits(env)` helper
- `apps/api/src/env.ts` (598+ lines) — Comprehensive env var interface with inline documentation

**Pattern**: Nearly every limit follows `DEFAULT_X` constant + `env.X` override with `parseInt`/string fallback.

**Remaining hardcoded values** (minor): The `DEVCONTAINER_CONFIG_NAME_REGEX` and `VALID_WORKSPACE_PROFILES` arrays in `defaults.ts` are intentionally static (schema constraints, not tunable parameters).

### 6.3.3 A/B Testing Capability

**Current state: No A/B testing infrastructure exists.**

What's present:
- Agent profiles table (`agent_profiles` in D1) allows different model/prompt/timeout/VM configurations
- Analytics Engine tracks 13 core feature events with per-user, per-project attribution
- Weekly retention cohort analysis exists in admin analytics

What's missing:
- No variant assignment table (users/projects to experiment cohorts)
- No experiment definition or lifecycle management
- No event tagging by experiment/variant
- No statistical significance testing
- No comparison API for profile outcomes

### 6.3.4 Agent Profile Experimentability

**Schema** (`apps/api/src/db/schema.ts:760-815`):

The `agent_profiles` table has rich configuration fields: `agentType`, `model`, `permissionMode`, `systemPromptAppend`, `maxTurns`, `timeoutMinutes`, `vmSizeOverride`, `workspaceProfile`, `devcontainerConfigName`.

**Limitations:**
- **No versioning**: Profiles have a single `id` with no version history. Modifying a profile overwrites the previous configuration with no audit trail.
- **No outcome attribution**: Tasks reference `agentProfileHint` (text field on the tasks table) but there's no structured link between profile version and task outcome metrics.
- **No comparison tooling**: No API endpoint or admin UI view compares task success rates, execution times, or costs across different profile configurations.

### 6.3.5 Trace Durability

| Trace Type | Storage | Durability | Searchable? |
|-----------|---------|-----------|------------|
| Task status transitions | D1 `task_status_events` table | Permanent, D1-backed | Yes, indexed by (taskId, createdAt) |
| Chat messages + tool calls | ProjectData DO SQLite | Per-project, DO lifetime | Yes, FTS5 full-text search |
| Tool call metadata | ProjectData DO `tool_metadata` JSON column | Per-project, DO lifetime | Partial (lazy-loaded, not FTS-indexed) |
| Compute usage | D1 `compute_usage` table | Permanent, soft FK (survives resource deletion) | Yes, indexed by user + period |
| Agent prompts | Embedded in initial chat message | Per-project, DO lifetime | Via message search |
| Errors (structured) | D1 `OBSERVABILITY_DATABASE` | Permanent | Yes, admin error dashboard |
| Worker logs (historical) | CF Workers Observability API | 7-day retention | Yes, via admin log viewer |
| Analytics events | CF Analytics Engine | Rolling window | Yes, via SQL API |
| VM agent logs | journald on VM | VM lifetime only | Via SSH or debug package |

**Assessment**: Trace durability is **good for chat messages and task status** but has gaps:
- VM agent logs are lost when a node is destroyed (no durable archival)
- Tool call metadata is stored as JSON blobs, not structured columns — agents cannot efficiently query "show me all tasks where tool X was called"
- Worker logs have only 7-day retention via the CF Observability API
- No unified trace query across all trace types (chat + status + compute + errors)

---

## Findings

### [HIGH] TaskRunner and NodeLifecycle DOs Lack Miniflare Integration Tests

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: `apps/api/tests/workers/` (missing files)
**Category**: testing

**Finding**: The two most critical Durable Objects — TaskRunner (orchestrates task execution: node selection, workspace creation, agent session lifecycle) and NodeLifecycle (manages warm pool: active → warm → destroying state machine with alarm-driven timeouts) — have zero Miniflare integration tests. They are tested only with `vi.mock()` unit tests that cannot exercise real D1 transactions, DO alarm scheduling, or multi-step state transitions.

**Impact**: These state machines are the backbone of task execution. Mocked unit tests hide integration issues — the exact failure mode documented in `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md` where "828 component tests passed while the core feature did not work end-to-end." A bug in alarm scheduling, D1 query ordering, or DO state persistence would not be caught by current tests.

**Recommendation**: Add Miniflare integration tests in `apps/api/tests/workers/`:
- `task-runner-do.test.ts`: Create task → alarm fires → state transitions through execution steps → asserts D1 task status and DO internal state
- `node-lifecycle-do.test.ts`: Mark idle → alarm fires → state transitions to destroying → asserts cleanup

**Implementation Owner**: `apps/api` (cloudflare-specialist)
**Effort**: M

---

### [HIGH] No Coverage Thresholds Enforced

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: `apps/api/vitest.config.ts`, `apps/web/vitest.config.ts`, all package vitest configs
**Category**: testing

**Finding**: Every vitest config enables V8 coverage reporting but no config sets `coverage.thresholds`. Coverage can silently regress to any level without CI failing.

**Impact**: Without thresholds, new features can ship with 0% test coverage. Coverage drift is invisible until a production incident reveals an untested path. The backlog task `tasks/backlog/2026-03-03-improve-test-infrastructure.md` (created 2026-03-03) already identifies this gap — it has been open for over 2 months.

**Recommendation**: Add thresholds to all vitest configs:
```typescript
coverage: {
  thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 }
}
```
Start with the proposed thresholds and ratchet upward as coverage improves. Run `pnpm test:coverage` to establish baselines first.

**Implementation Owner**: Root config + all packages
**Effort**: S

---

### [HIGH] Go Race Detector Not Enabled in CI

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: `.github/workflows/ci.yml` (vm-agent-test job)
**Category**: testing

**Finding**: The `vm-agent-test` CI job runs `go test ./...` without the `-race` flag. The Go race detector is the primary tool for catching concurrent access bugs in the VM agent, which manages PTY sessions, WebSocket connections, Docker containers, and ACP message serialization — all concurrent workloads.

**Impact**: Race conditions in the VM agent are invisible to CI. The post-mortem `docs/notes/2026-03-04-chat-session-cross-contamination-postmortem.md` notes that "the race exists at the SQLite layer, not in Go memory, so `go test -race` could not detect it" — but that was a specific exception. Most Go races (shared maps, unsynchronized state) ARE detectable by `-race`.

**Recommendation**: Change `go test ./...` to `go test -race ./...` in the `vm-agent-test` CI job. Accept the ~2-3x slowdown (still within the 15-min timeout). Also already identified in `tasks/backlog/2026-03-03-improve-test-infrastructure.md:18`.

**Implementation Owner**: `.github/workflows/ci.yml`
**Effort**: S

---

### [MEDIUM] No Shared Test Fixtures or Mock Factory Registry

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: `apps/api/tests/` (no shared helpers directory)
**Category**: testing

**Finding**: The API test suite (237 files) has no shared fixture directory or mock factory registry. Common mock objects (workspace, node, project, task, user) are redefined inline in each test file. The `InMemorySqlStorage` mock is duplicated identically in `apps/api/tests/integration/project-data.test.ts` and `apps/api/tests/integration/chat-session-lifecycle.test.ts`.

**Impact**: Agents writing new tests must grep for existing patterns and copy-paste. When a shared type changes (e.g., `Workspace` gains a field), every inline mock must be updated independently — some will be missed, creating type mismatches that real mocks would have caught. The backlog task `tasks/backlog/2026-03-03-improve-test-infrastructure.md:25-28` already proposes shared factories.

**Recommendation**: Create `apps/api/tests/test-helpers.ts` with typed factory functions: `createMockWorkspace(overrides)`, `createMockNode(overrides)`, `createMockProject(overrides)`, `createMockTask(overrides)`. Each factory returns a complete typed object with sensible defaults and merge-friendly overrides (following the pattern in `packages/providers/tests/fixtures/scaleway-mocks.ts`).

**Implementation Owner**: `apps/api`
**Effort**: M

---

### [MEDIUM] Cloud-Init Package Has Minimal Test Coverage

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: `packages/cloud-init/tests/generate.test.ts`
**Category**: testing

**Finding**: The cloud-init package (547 lines of source across `generate.ts` and `template.ts`) has exactly 1 test file. While that test file is well-written (parses YAML output, uses realistic multi-line PEM data per the TLS post-mortem), it cannot cover the full template surface: Neko browser sidecar config, devcontainer variations, lightweight vs full profiles, Docker auth, git credential injection, and provider-specific cloud-init fragments.

**Impact**: Cloud-init bugs are among the most expensive to debug — they only manifest on real VMs during provisioning, requiring a full staging deploy cycle. The TLS YAML indentation bug (`docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`) was caught only after production impact because unit tests used unrealistic 3-line PEM data.

**Recommendation**: Expand test coverage to include:
- Neko browser sidecar template generation (NEKO_IMAGE, NEKO_SCREEN_RESOLUTION params)
- Lightweight vs full workspace profile differences
- Docker auth injection when registry credentials are present
- All optional variable combinations (TLS cert present/absent, devcontainer config present/absent)

**Implementation Owner**: `packages/cloud-init`
**Effort**: M

---

### [MEDIUM] Partial Post-Mortem Regression Tests for Critical Bugs

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: Various (see table above)
**Category**: testing

**Finding**: 10 of 36 post-mortems have only partial regression tests. Notable gaps:
- R2 CORS upload failure: No CORS-specific test exists (CORS is only exercisable in a real browser)
- Chat idle cleanup during persist: No test proves that `persistMessage()` extends the cleanup deadline
- MCP token revocation: No multi-call sequence test proves the token survives beyond task completion
- MCP token TTL vs max execution time: No cross-constant validation test

**Impact**: Partial regression tests create false confidence. An agent reviewing the post-mortem might assume the class of bug is fully covered when it isn't. The "env-var single-quote stripping" post-mortem has no regression test at all for the round-trip quote handling.

**Recommendation**: For each partial regression test, add the specific missing scenario described in the post-mortem's "what test would have caught this" section. Prioritize the MCP token and chat idle cleanup gaps as they affect the critical task execution path.

**Implementation Owner**: `apps/api` (test-engineer)
**Effort**: M

---

### [MEDIUM] No Reusable Staging Smoke Test Suite

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: `.claude/rules/13-staging-verification.md` (process rule, no automation)
**Category**: testing

**Finding**: Staging verification is performed ad-hoc by agents writing one-off Playwright scripts. The regression checklist in rule 13 (app loads, dashboard renders, navigation works, settings page loads, no console errors, health endpoint responds) is well-defined but not codified into a reusable test suite. Each agent reinvents the same login + navigate + screenshot flow.

**Impact**: Staging verification quality depends entirely on the agent's diligence. Rushed or compacted agents may skip checklist items. A standard smoke test could be run in under 2 minutes and would provide consistent evidence.

**Recommendation**: Create `apps/web/tests/playwright/staging-smoke.spec.ts` with:
- Token-login authentication flow
- Dashboard load + project card visibility assertion
- Settings page load assertion
- API health endpoint check
- Console error collection assertion
- Parameterized for staging (`sammy.party`) and production (`simple-agent-manager.org`)

**Implementation Owner**: `apps/web`
**Effort**: M

---

### [MEDIUM] Only One Runtime Feature Flag — No General-Purpose Flag System

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: `apps/api/src/services/trial/kill-switch.ts:1-62`
**Category**: testing

**Finding**: The trials kill-switch is the only feature flag that can be toggled at runtime via KV without redeploying. All other 17 `_ENABLED` flags are env-var-based, requiring a full staging or production deploy to toggle. The kill-switch pattern (KV read + 30s in-memory cache + fail-closed) is well-designed but not generalized.

**Impact**: Agents cannot quickly enable/disable experimental features during testing iterations. Every flag toggle costs a 7-minute deploy cycle. For experiment infrastructure, this is the single biggest bottleneck — an agent testing an AI proxy configuration must redeploy for every toggle.

**Recommendation**: Extract the kill-switch pattern into a generic `FeatureFlag` utility:
```typescript
class FeatureFlag {
  constructor(private kv: KVNamespace, private key: string, private defaultValue: boolean, private cacheTtlMs = 30000) {}
  async isEnabled(): Promise<boolean> { /* cached KV read, fail to default */ }
}
```
Migrate the most frequently toggled flags (AI_PROXY_ENABLED, SANDBOX_ENABLED, ARTIFACTS_ENABLED) to KV-backed flags.

**Implementation Owner**: `apps/api/src/services/`
**Effort**: M

---

### [LOW] Agent Profile Versioning Absent

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: `apps/api/src/db/schema.ts:760-815`
**Category**: testing

**Finding**: Agent profiles have no version history. When a profile's `model`, `systemPromptAppend`, or `maxTurns` is updated, the previous configuration is overwritten. There is no way to compare task outcomes between profile versions.

**Impact**: Agents experimenting with prompt tuning or model selection cannot conduct controlled experiments. They can create a new profile, but cannot track which version of which profile produced which task outcomes. This limits the "meta-evaluation loop" architecture preference documented in the knowledge graph.

**Recommendation**: Add a `profile_versions` table or `version` column + `previous_version_id` FK to enable profile history. Link tasks to specific profile versions (not just profile IDs) for outcome attribution.

**Implementation Owner**: `apps/api/src/db/schema.ts`
**Effort**: M

---

### [LOW] No A/B Testing Framework

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: N/A (does not exist)
**Category**: testing

**Finding**: No experiment assignment, cohort tracking, or outcome comparison infrastructure exists. Agent profiles provide the configuration surface for experiments, and Analytics Engine provides the event tracking, but there is no glue connecting them: no way to assign users/projects to experiment variants, tag events with variant IDs, or compute statistical differences.

**Impact**: The project's strategy calls for harness experimentation (comparing model/prompt configurations) and the knowledge graph notes interest in a "durable meta-evaluation loop." Without A/B infrastructure, experiments must be conducted manually with ad-hoc analysis.

**Recommendation**: Phase 1: Add `experiments` and `experiment_assignments` D1 tables. Phase 2: Tag analytics events with experiment/variant. Phase 3: Admin dashboard for experiment results with confidence intervals.

**Implementation Owner**: `apps/api` + `apps/web`
**Effort**: L

---

### [LOW] Playwright Visual Tests Not Integrated into CI

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: `.github/workflows/ci.yml`, `apps/web/playwright.config.ts`
**Category**: testing

**Finding**: The 30 Playwright visual audit specs in `apps/web/tests/playwright/` are not run in CI. The CI `test` job runs `pnpm test:coverage` which invokes `vitest run` — this executes unit tests (`.test.ts` files) but not Playwright specs (`.spec.ts` files). Playwright specs are only run manually by agents during the `/do` workflow Phase 3.

**Impact**: Visual regressions (overflow, clipping, broken layouts) are only caught if the agent remembers to run Playwright tests. If an agent skips this step (or context-compacts past it), visual bugs ship to staging/production.

**Recommendation**: Add a CI job that runs Playwright visual tests against a Vite preview build with mock data. This catches layout regressions automatically without requiring staging access.

**Implementation Owner**: `.github/workflows/ci.yml` + `apps/web`
**Effort**: M

---

### [INFO] Miniflare Test Env Bindings Diverge from Production Defaults

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: `apps/api/vitest.workers.config.ts:54-80`
**Category**: testing

**Finding**: The Miniflare test configuration defines 30+ environment variable bindings inline with hardcoded test values (JWT secrets, token TTLs, rate limits). These are not derived from `packages/shared/src/constants/defaults.ts` or `apps/api/src/env.ts`. If a default value changes in production, the test environment may not reflect it.

**Impact**: Low — test values are intentionally different from production (shorter TTLs, lower limits for faster tests). However, if a new env var is added to production and forgotten in the test config, Miniflare tests may use `undefined` instead of the expected default.

**Recommendation**: Extract shared test defaults into a `test-env-defaults.ts` file that references `packages/shared/src/constants/defaults.ts` where appropriate, overriding only values that need to differ for testing.

**Implementation Owner**: `apps/api`
**Effort**: S

---

### [INFO] Source-Contract Tests Appropriately Scoped

**Track**: 6 — Testing & Experiment Infrastructure
**Location**: `apps/api/tests/unit/recovery-resilience.test.ts:8-28`, `apps/api/tests/integration/task-runner-do-infra.test.ts:7-38`, `apps/web/tests/unit/lib/theme-tokens.test.ts:1-44`
**Category**: testing

**Finding**: The codebase contains a small number of `readFileSync`-based source-contract tests, but all are **appropriately scoped** to infrastructure/configuration verification (wrangler bindings, import contracts, CSS token definitions). None are used for behavioral component testing, which is banned by `.claude/rules/02-quality-gates.md`. The CI quality gate `pnpm quality:source-contract-tests` enforces this rule.

**Impact**: None — this is a positive finding. The source-contract test ban is being enforced correctly.

**Recommendation**: No action needed. The existing quality gate is sufficient.

**Implementation Owner**: N/A
**Effort**: N/A

---

## Test Health Report by Package

| Package | Test Files | Miniflare? | Coverage Threshold? | Mock Realism | Critical Gap? | Grade |
|---------|-----------|-----------|-------------------|-------------|---------------|-------|
| `apps/api` | 237 | Yes (11) | No | Good (mocks shaped, Miniflare for DOs) | TaskRunner/NodeLifecycle DOs untested in Miniflare | B |
| `apps/web` | 158 | N/A | No | Good (RTL + Playwright visual) | No staging smoke suite | B |
| `packages/vm-agent` | 68 | N/A | N/A (Go) | Excellent (real crypto, httptest) | No `-race` in CI | B+ |
| `packages/providers` | 9 | N/A | No | Excellent (route-based fetch mocks) | — | A- |
| `packages/acp-client` | 19 | N/A | No | Good | — | B+ |
| `packages/shared` | 8 | N/A | No | Good | — | B |
| `packages/ui` | 7 | N/A | No | Good | — | B |
| `packages/cloud-init` | 1 | N/A | No | Good (YAML parse + realistic PEM) | Minimal coverage for 547 LOC | C |
| `packages/terminal` | 3 | N/A | No | Good | — | B |
| `infra` | 5 | N/A | No | Good | Non-standard `__tests__/` dir | B |

---

## Experiment Readiness Scorecard

| Capability | Score (1-5) | Notes |
|-----------|------------|-------|
| **Feature flag toggleability** | 2/5 | Only 1 of 18 flags is runtime-toggleable; rest require redeploy |
| **Configurable constants** | 5/5 | Comprehensive env-var-with-default pattern throughout; Principle XI well-followed |
| **Agent profile experimentability** | 2/5 | Rich configuration surface but no versioning, no outcome attribution, no comparison |
| **A/B testing capability** | 1/5 | No infrastructure exists; profiles + analytics provide building blocks only |
| **Trace durability** | 3/5 | Good for chat/status/compute; gaps in VM logs (ephemeral), tool-call structure (JSON blobs), and cross-trace queries |
| **Local iteration speed** | 4/5 | Per-package tests run in <1 min; staging loop is 15 min (acceptable) |
| **Test isolation** | 4/5 | Per-package test runs work well; shared build dependency is minor friction |
| **Fixture discoverability** | 2/5 | No centralized fixtures for API tests; agents must grep for patterns |
| **Failure reproduction** | 3/5 | Good for template/migration bugs; weak for CORS/cross-origin and multi-component races |

**Overall experiment readiness: 2.9/5** — Strong foundations in configurable constants and local iteration, but runtime experimentation is bottlenecked by env-var-only flags and absent A/B infrastructure.

---

## Implementation-Ready Follow-Up Task Packets

### P0: TaskRunner and NodeLifecycle Miniflare Integration Tests

**Priority**: P0 (most critical state machines lack integration tests)
**Effort**: M (2-3 days)
**Owner**: cloudflare-specialist

**Description**: Add Miniflare integration tests for TaskRunner DO and NodeLifecycle DO in `apps/api/tests/workers/`. Tests must use real D1 + DO bindings (no vi.mock), exercise the full state machine including alarm scheduling, and assert both DO internal state and D1 side effects.

**Acceptance Criteria**:
- [ ] `task-runner-do.test.ts`: Task created → alarm fires → transitions through pending → provisioning → workspace_ready → agent_session → completed
- [ ] `node-lifecycle-do.test.ts`: Node enters warm state → alarm fires at timeout → transitions to destroying
- [ ] Both tests use real Miniflare D1/DO bindings, not mocks
- [ ] Tests pass in CI (`pnpm --filter api test:workers`)

---

### P0: Enable Go Race Detector in CI

**Priority**: P0 (trivial change, high safety value)
**Effort**: S (30 minutes)
**Owner**: CI/DevOps

**Description**: Add `-race` flag to the `go test` command in the `vm-agent-test` CI job.

**Acceptance Criteria**:
- [ ] `.github/workflows/ci.yml` `vm-agent-test` job uses `go test -race ./...`
- [ ] CI completes within the existing 15-minute timeout
- [ ] No existing tests fail with race detector enabled (fix any discovered races)

---

### P1: Add Coverage Thresholds to All Vitest Configs

**Priority**: P1
**Effort**: S (1 day)
**Owner**: test-engineer

**Description**: Add `coverage.thresholds` to every vitest config. Run `pnpm test:coverage` first to establish baselines, then set thresholds at or slightly below current levels (ratchet strategy).

**Acceptance Criteria**:
- [ ] Every vitest config has `thresholds` in the `coverage` block
- [ ] `pnpm test:coverage` passes with all thresholds
- [ ] Baseline coverage numbers documented

---

### P1: Create Shared API Test Fixtures

**Priority**: P1
**Effort**: M (2 days)
**Owner**: test-engineer

**Description**: Create `apps/api/tests/test-helpers.ts` with typed mock factory functions for the core entities (workspace, node, project, task, user, session). Migrate the duplicated `InMemorySqlStorage` mock to this shared location.

**Acceptance Criteria**:
- [ ] `apps/api/tests/test-helpers.ts` exists with `createMockWorkspace()`, `createMockNode()`, `createMockProject()`, `createMockTask()`, `createMockUser()`
- [ ] `InMemorySqlStorage` extracted to shared location
- [ ] At least 10 existing test files migrated to use shared factories
- [ ] Each factory returns a properly typed object with sensible defaults and merge-friendly overrides

---

### P1: Expand Cloud-Init Test Coverage

**Priority**: P1
**Effort**: M (2 days)
**Owner**: test-engineer

**Description**: Add tests for cloud-init template generation covering Neko browser sidecar, lightweight profiles, Docker auth injection, and all optional variable combinations.

**Acceptance Criteria**:
- [ ] Tests cover Neko browser sidecar template (nekoImage, nekoPrePull variables)
- [ ] Tests cover lightweight vs full workspace profile differences
- [ ] Tests cover Docker auth injection when registry credentials are present
- [ ] Tests cover all optional variable combinations (TLS present/absent, devcontainer present/absent)
- [ ] All tests parse YAML output (no string containment checks per TLS post-mortem)

---

### P1: Close Partial Post-Mortem Regression Test Gaps

**Priority**: P1
**Effort**: M (3 days)
**Owner**: test-engineer

**Description**: Add the specific missing regression test scenarios for the 4 highest-risk partial regression tests: MCP token revocation multi-call sequence, chat idle cleanup during persist, MCP token TTL cross-constant validation, and R2 CORS (document as staging-only if not locally testable).

**Acceptance Criteria**:
- [ ] MCP token test proves token survives beyond single task scope in multi-call sequence
- [ ] Chat idle cleanup test proves `persistMessage()` extends cleanup deadline
- [ ] MCP token TTL test validates TTL > max execution time as an invariant
- [ ] R2 CORS gap documented as staging-only verification requirement (or Miniflare test if feasible)
