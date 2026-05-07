# Track 4: Coding Standards & Consistency

Status: Complete
Date: 2026-05-07

---

## Executive Summary

The SAM codebase demonstrates strong foundations in several areas — strict TypeScript configuration, exemplary Go code quality, complete Tailwind v4 adoption, and a well-designed design token system. However, significant gaps exist in runtime validation at API boundaries (~60% of mutation routes lack Valibot validation), React error boundary coverage (single global boundary with no feature-level isolation), and responsive design consistency (only 16 of ~100+ component files use Tailwind breakpoint modifiers). The Go VM agent is the most consistently high-quality surface in the codebase.

### Overall Grade: B

| Area | Grade | Key Issue |
|------|-------|-----------|
| TypeScript Patterns | B | Moderate type assertions in prod code; major validation gap |
| API Patterns | B+ | Clean structure with some oversized files and inline logic |
| Go Patterns | A | Exemplary across all categories |
| CSS/Styling | B- | Tailwind complete but hardcoded colors and sparse responsiveness |

---

## 4.1 TypeScript Patterns

### Coding Standards Compliance Matrix

| Standard | Status | Evidence |
|----------|--------|----------|
| Strict mode enabled | PASS | `tsconfig.json:8` — `"strict": true` |
| noUncheckedIndexedAccess | PASS | `tsconfig.json:22` |
| noUnusedLocals / noUnusedParameters | PASS | `tsconfig.json:19-20` |
| no-explicit-any (ESLint) | PARTIAL | `.eslintrc.cjs:22` — set to `warn`, not `error` |
| consistent-type-imports | PASS | `.eslintrc.cjs:23-27` — enforced as `error` |
| simple-import-sort | PASS | `.eslintrc.cjs:29-30` — enforced as `error` |
| no-non-null-assertion | PARTIAL | `.eslintrc.cjs:28` — set to `warn`, not `error` |
| React hooks rules | PASS | `.eslintrc.cjs:47` — `react-hooks/recommended` |
| jsx-a11y | PARTIAL | `.eslintrc.cjs:48` — enabled but as `warn` only |
| no-console (API) | PASS | `.eslintrc.cjs:36-42` — enforced in `apps/api/src/` |
| Valibot at API boundaries | FAIL | ~60% of mutation routes lack validation |
| ErrorBoundary coverage | FAIL | Single global boundary only |

### Type Assertion Audit

**Total `as` type assertions: ~2,435** across apps/ and packages/ (excluding test files).

The heaviest production files:

| File | Count | Justification |
|------|-------|---------------|
| `apps/api/src/durable-objects/sam-session/agent-loop.ts` | 35 | Mastra/AI SDK integration — framework type gaps |
| `apps/api/src/durable-objects/sam-session/tools/index.ts` | 29 | MCP tool handler dispatch — schema type widening |
| `apps/api/src/routes/mcp/dispatch-tool.ts` | ~20 | JSON-RPC parameter extraction |

Most test-file assertions (top files have 30-68 each) are for mock construction and are acceptable. Production assertions cluster around AI SDK/MCP integration points where external libraries provide loose types. These are largely justified but represent a maintenance risk — upstream type improvements could eliminate many.

### [HIGH] F01 — Runtime Validation Gap at API Boundaries

**Track**: 4 — Coding Standards
**Location**: Multiple routes in `apps/api/src/routes/`
**Category**: standards

**Finding**: Of ~45 route files with mutation endpoints (POST/PUT/PATCH/DELETE), only 26 use `jsonValidator()` for request body validation. The remaining ~19 route files accept unvalidated input, relying on TypeScript types (compile-time only) or manual ad-hoc checks.

Routes with mutations but NO Valibot validation:
- `apps/api/src/routes/knowledge.ts` — POST/PATCH for knowledge entities
- `apps/api/src/routes/policies.ts` — POST/PATCH for policies
- `apps/api/src/routes/library.ts` — POST/PUT/PATCH for file library
- `apps/api/src/routes/orchestrator.ts` — POST for mission operations
- `apps/api/src/routes/notifications.ts` — POST for notification actions
- `apps/api/src/routes/chat.ts` — 3 of 4 POST routes (only `CreateChatSessionSchema` validated)
- `apps/api/src/routes/analytics-ingest.ts` — POST for analytics events
- `apps/api/src/routes/ai-proxy.ts` — POST for LLM requests
- `apps/api/src/routes/ai-proxy-anthropic.ts` — POST for Anthropic proxy
- `apps/api/src/routes/ai-proxy-passthrough.ts` — POST for passthrough proxy
- `apps/api/src/routes/admin-ai-proxy.ts` — PUT/PATCH for AI proxy config
- `apps/api/src/routes/admin-quotas.ts` — PUT for quota management
- `apps/api/src/routes/admin-sandbox.ts` — POST for sandbox operations
- `apps/api/src/routes/codex-refresh.ts` — POST for token refresh
- `apps/api/src/routes/tts.ts` — POST for text-to-speech
- `apps/api/src/routes/transcribe.ts` — POST for transcription
- `apps/api/src/routes/bootstrap.ts` — POST for initial project setup

**Impact**: Malformed input can reach business logic unchecked, causing unpredictable errors, potential injection vectors, or silent data corruption. The project owner explicitly stated: "Wants runtime validation on API inputs, not just TypeScript types. Prefers Valibot."

**Recommendation**: Create Valibot schemas for every mutation route. Prioritize external-facing routes (knowledge, policies, chat) and proxy routes (ai-proxy, anthropic proxy) first. The existing `jsonValidator()` wrapper in `apps/api/src/schemas/_validator.ts` makes adoption trivial — it's a single middleware addition per route.

**Implementation Owner**: `apps/api`
**Effort**: M (schema definitions are straightforward; ~19 routes to cover)

---

### [MEDIUM] F02 — `no-explicit-any` Set to Warn, Not Error

**Track**: 4 — Coding Standards
**Location**: `.eslintrc.cjs:22`
**Category**: standards

**Finding**: The `@typescript-eslint/no-explicit-any` rule is set to `warn`. With 448 total `any` usages across the codebase (heavily concentrated in test files), the warning is non-blocking in CI. Production code has very few `any` usages (only 3 in `apps/api/src/`), but the `warn` level permits gradual drift.

**Impact**: New `any` usages can be introduced without CI failure. Over time, this erodes type safety.

**Recommendation**: Escalate to `error` for production code paths. Keep `warn` for test files via an ESLint override:
```javascript
overrides: [
  { files: ['apps/api/src/**/*.ts', 'apps/web/src/**/*.tsx'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
  { files: ['**/*.test.*', '**/*.spec.*'], rules: { '@typescript-eslint/no-explicit-any': 'warn' } },
]
```

**Implementation Owner**: Root ESLint config
**Effort**: S

---

### [MEDIUM] F03 — useEffect Concentration Without Effect-Interaction Tracing

**Track**: 4 — Coding Standards
**Location**: `apps/web/src/pages/project-chat/useProjectChatState.ts` (10 effects), `apps/web/src/components/project-message-view/useConnectionRecovery.ts` (9 effects), `apps/web/src/components/ChatSession.tsx` (8 effects)
**Category**: standards

**Finding**: 412 `useEffect` calls across the web app, with heavy concentration in state management hooks. The project has a documented rule (`.claude/rules/06-technical-patterns.md` "React Interaction-Effect Analysis") requiring forward-tracing through effects when modifying click handlers. However, there is no automated enforcement — no lint rule, no doc comment convention, and no test requirement for effect-interaction traces.

Files with 5+ useEffect calls (high risk for interaction-effect conflicts):
- `useProjectChatState.ts` — 10 effects
- `useConnectionRecovery.ts` — 9 effects
- `ChatSession.tsx` — 8 effects
- `useWorkspaceCore.ts` — 7 effects
- `workspace/index.tsx` — 7 effects
- `FilePreviewModal.tsx` — 6 effects
- `GlobalCommandPalette.tsx` — 6 effects

The project owner noted: "Skeptical of React useEffect — instinct when seeing React bugs is 'probably a poor use of useEffect.'"

**Impact**: High-effect-count components are fragile to modification. New handlers can silently conflict with existing effects (documented in `docs/notes/2026-03-01-new-chat-button-postmortem.md`).

**Recommendation**:
1. Audit the top 7 files above for effects that can be replaced with event handlers, `useMemo`, or `useSyncExternalStore`.
2. Consider a custom ESLint rule or comment convention (`// EFFECT-DEPS: sessionId, status — interacts with handleNewChat`) for high-effect files.
3. Require behavioral tests for any component with 5+ effects.

**Implementation Owner**: `apps/web`
**Effort**: L

---

### [MEDIUM] F04 — Single Global Error Boundary

**Track**: 4 — Coding Standards
**Location**: `apps/web/src/components/ErrorBoundary.tsx:20-84`, `apps/web/src/App.tsx:74`
**Category**: standards

**Finding**: The entire React app is wrapped in a single `ErrorBoundary` at the root level (`App.tsx:74`). There are no intermediate boundaries for individual pages, panels, or feature sections. An unhandled error in any component (e.g., the file browser, terminal, settings drawer) crashes the entire application back to the recovery screen.

**Impact**: Users lose all in-progress work across all panels when any single component fails. Chat messages being composed, terminal sessions, and settings changes are all lost.

**Recommendation**: Add feature-level error boundaries around:
1. Chat message view / project chat (highest risk — complex streaming + effects)
2. Terminal panel (WebSocket failures can throw)
3. Settings drawer (form state)
4. File browser / file viewer panels
5. Admin pages (isolated from main user experience)

Each boundary should show a localized error message and "Retry" button rather than a full-app crash.

**Implementation Owner**: `apps/web`
**Effort**: M

---

## 4.2 API Patterns

### Compliance Matrix

| Standard | Status | Evidence |
|----------|--------|----------|
| Route handler structure (validate → auth → service → respond) | PASS | `apps/api/src/routes/activity.ts` exemplifies; most routes follow |
| Service layer separation | PARTIAL | Large routes have inline query logic |
| Response shape consistency | PASS | Central error handler in `apps/api/src/middleware/error.ts` |
| Auth middleware coverage | PASS | All user-facing routes protected; gaps are intentional (trials, bootstrap, callbacks) |
| Structured logging | PASS | `apps/api/src/lib/logger.ts` — consistent event-based structured JSON |
| no-console enforcement | PASS | `.eslintrc.cjs:36-42` — enforced via ESLint for `apps/api/src/` |
| File size compliance (500 lines) | FAIL | 5+ route files exceed 800 lines |

### [HIGH] F05 — Oversized Route Files Exceed 500-Line Limit

**Track**: 4 — Coding Standards
**Location**: `apps/api/src/routes/tasks/crud.ts` (995 lines), `apps/api/src/routes/projects/crud.ts` (920 lines), `apps/api/src/routes/triggers/crud.ts` (842 lines), `apps/api/src/routes/workspaces/runtime.ts` (814 lines), `apps/api/src/routes/mcp/dispatch-tool.ts` (685 lines), `apps/api/src/routes/chat.ts` (655 lines), `apps/api/src/routes/credentials.ts` (682 lines)
**Category**: standards

**Finding**: Seven route files exceed the project's own 500-line limit (`.claude/rules/18-file-size-limits.md`). The largest (`tasks/crud.ts` at 995 lines) is nearly double the limit. These files accumulate multiple CRUD operations, complex query builders, and inline validation logic that should be in services.

**Impact**: Agents must load the entire file to modify any single route. Review quality degrades for 800+ line files. Merge conflicts increase proportionally.

**Recommendation**: Split each file using the directory pattern from Rule 18:
- `tasks/crud.ts` (995 lines) → `tasks/list.ts`, `tasks/create.ts`, `tasks/detail.ts`, `tasks/status.ts`
- `projects/crud.ts` (920 lines) → `projects/list.ts`, `projects/create.ts`, `projects/detail.ts`, `projects/update.ts`
- Similar splits for `triggers/crud.ts`, `workspaces/runtime.ts`, `credentials.ts`

**Implementation Owner**: `apps/api`
**Effort**: M (mechanical refactor, no behavior change)

---

### [MEDIUM] F06 — Business Logic Leaking Into Route Handlers

**Track**: 4 — Coding Standards
**Location**: `apps/api/src/routes/tasks/crud.ts:186-200`, `apps/api/src/routes/mcp/dispatch-tool.ts:41-160`
**Category**: standards

**Finding**: Some route handlers contain inline database query construction and complex validation logic that belongs in the service layer. Examples:
- `tasks/crud.ts` lines 186-200: Complex WHERE/ORDER BY query building for task listing
- `mcp/dispatch-tool.ts` lines 41-160: 120+ lines of parameter validation and config resolution
- `knowledge.ts:36-39`: Inline env var parsing with type casting (`env as unknown as Record<string, string | undefined>`)

**Impact**: Business logic scattered across routes is harder to test, harder to reuse, and harder for agents to find. Route files should be thin HTTP-to-service adapters.

**Recommendation**: Extract query builders and validation chains into service functions. The `knowledge.ts` env-var parsing pattern at line 37 (`(env as unknown as Record<string, string | undefined>)[key]`) is particularly problematic — it bypasses TypeScript's type safety entirely. Use the existing `Env` interface instead.

**Implementation Owner**: `apps/api`
**Effort**: M

---

### [LOW] F07 — Inconsistent Error Response Enrichment

**Track**: 4 — Coding Standards
**Location**: `apps/api/src/routes/chat.ts:100-115`
**Category**: standards

**Finding**: The central error handler (`middleware/error.ts`) provides consistent `{ error, message }` envelopes. However, some routes add custom diagnostic fields (e.g., `chat.ts` adds `requestId`, `phase`, `details` for admin users). This pattern is useful but not standardized — other routes with similarly complex error paths don't provide the same richness.

**Impact**: Low — the core envelope is consistent. The enrichment gap affects debuggability, not correctness.

**Recommendation**: Standardize diagnostic enrichment by adding optional `requestId` and `details` fields to the `AppError` class. Routes can populate them; the global handler includes them when the user is admin.

**Implementation Owner**: `apps/api/src/middleware/error.ts`
**Effort**: S

---

## 4.3 Go Patterns

### Compliance Matrix

| Standard | Status | Evidence |
|----------|--------|----------|
| Interfaces at consumption point | PASS | `internal/acp/gateway.go:24-96` — 9 interfaces defined where consumed |
| Context.Context propagation | PASS | Comprehensive; minor untracked goroutines mitigated by context cancellation |
| Resource cleanup (defer) | PASS | HTTP bodies, DB rows, timers all properly deferred |
| Error wrapping with context | PASS | 47+ instances of `fmt.Errorf("...: %w", err)` |
| No silent error swallows | PASS | All errors propagated, logged, or explicitly swallowed with `_ = ...` |
| Structured logging (slog) | PASS | No bare `log.Printf` or `fmt.Printf` in production code |
| Test parallelization | PASS | 363 instances of `t.Parallel()` |
| Test isolation | PASS | Temporary SQLite databases, proper cleanup via `defer` |

### [INFO] F08 — Fire-and-Forget Goroutines in ACP Gateway

**Track**: 4 — Coding Standards
**Location**: `packages/vm-agent/internal/acp/gateway.go:376, 403`
**Category**: standards

**Finding**: Two goroutines are launched without explicit tracking:
```go
go g.host.SelectAgent(ctx, selectMsg.AgentType)  // line 376
go g.host.HandlePrompt(ctx, rpcMsg.ID, rpcMsg.Params, g.viewerID)  // line 403
```
These pass the gateway's context, so they will be cancelled when `SessionHost.Stop()` fires (`session_host.go:886`). The pattern is safe but untracked — there's no `sync.WaitGroup` or channel confirming completion.

**Impact**: Minimal — context cancellation provides safety. However, if the goroutines need to complete work before shutdown (e.g., flushing output), the lack of tracking could cause data loss on rapid shutdown.

**Recommendation**: Consider adding a `sync.WaitGroup` to track outstanding operations if clean shutdown guarantees are needed. Current pattern is acceptable for the use case.

**Implementation Owner**: `packages/vm-agent`
**Effort**: S

---

### [INFO] F09 — Go Code Quality is Exemplary

**Track**: 4 — Coding Standards
**Location**: `packages/vm-agent/internal/` (entire tree)
**Category**: standards

**Finding**: The VM agent codebase demonstrates consistently high Go code quality:
- **Interface design**: All 9+ interfaces defined at consumption point (`gateway.go:24-96`), enabling flexible implementation without coupling
- **Nil-safe implementations**: Methods on optional reporters check `if r == nil { return }` (`bootlog/reporter.go:54-56`)
- **Lock ordering documentation**: `messagereport/reporter.go:43-46` comments document mutex acquisition order
- **SQLite outbox pattern**: Reliable message delivery with retry, batching, and idempotency (`messagereport/reporter.go`)
- **Error handling**: Every error is either wrapped with context (`fmt.Errorf`), logged at the appropriate level (`slog.Error/Warn`), or explicitly discarded with a comment explaining why

**Impact**: Positive — this is the reference implementation for code quality in the monorepo.

**Recommendation**: Document the Go patterns (interface-at-consumer, nil-safe methods, lock ordering comments) as the standard for any future Go packages in the repo.

**Implementation Owner**: Documentation
**Effort**: S

---

## 4.4 CSS / Styling

### Compliance Matrix

| Standard | Status | Evidence |
|----------|--------|----------|
| Tailwind CSS v4 adoption | PASS | `apps/web/vite.config.ts:3` — `@tailwindcss/vite` plugin |
| No CSS-in-JS | PASS | Zero styled-components, emotion, or CSS modules found |
| Design token system | PASS | `packages/ui/src/tokens/` — 110+ CSS variables, 60+ semantic tokens |
| Token usage in components | PARTIAL | Design tokens widely used but hardcoded hex values found in ~10 components |
| Responsive design (mobile-first) | FAIL | Only 16 of ~100+ component files use Tailwind breakpoints |

### [HIGH] F10 — Hardcoded Color Values Bypass Design Token System

**Track**: 4 — Coding Standards
**Location**: Multiple components
**Category**: standards

**Finding**: Despite having a comprehensive design token system (110+ CSS variables in `packages/ui/src/tokens/theme.css`), at least 10 component files use hardcoded hex color values:

| Component | File | Hardcoded Values |
|-----------|------|-----------------|
| WorkspaceNode | `apps/web/src/components/account-map/nodes/WorkspaceNode.tsx` | `#00ccff` (3x) |
| SessionNode | `apps/web/src/components/account-map/nodes/SessionNode.tsx` | `#aa88ff` (3x) |
| IdeaNode | `apps/web/src/components/account-map/nodes/IdeaNode.tsx` | `#ffdd44` (2x) |
| AnimatedFlowEdge | `apps/web/src/components/account-map/AnimatedFlowEdge.tsx` | `#00ff88` |
| AccountMapToolbar | `apps/web/src/components/account-map/AccountMapToolbar.tsx` | `bg-[#00ccff]`, `bg-[#aa88ff]` |
| LogEntry | `apps/web/src/components/node/LogEntry.tsx:27-28` | `#ef4444`, `#f59e0b` |
| LogsSection | `apps/web/src/components/node/LogsSection.tsx:62` | `#06b6d4`, `#22c55e` |
| GitDiffView | `apps/web/src/components/shared-file-viewer/GitDiffView.tsx` | Fallback hex in style objects |
| ActivityFeed | `apps/web/src/components/activity/ActivityFeed.tsx` | `var()` with hardcoded fallbacks |

**Impact**: Violates Constitution Principle XI (No Hardcoded Values). Colors cannot be themed or adapted for high-contrast/dark mode variants. Account map is the worst offender — its entire color scheme is disconnected from the design system.

**Recommendation**:
1. Add account-map-specific semantic tokens to `packages/ui/src/tokens/theme.css` (e.g., `--sam-color-map-workspace`, `--sam-color-map-session`, `--sam-color-map-idea`).
2. Replace all hardcoded hex values in the listed files with Tailwind utilities referencing design tokens.
3. Add a CI check (ESLint rule or quality script) that flags hardcoded hex values in `.tsx` files.

**Implementation Owner**: `apps/web`, `packages/ui`
**Effort**: M

---

### [MEDIUM] F11 — Sparse Responsive Breakpoint Usage

**Track**: 4 — Coding Standards
**Location**: `apps/web/src/` — 16 of ~100+ component files use Tailwind breakpoints
**Category**: standards

**Finding**: Only 16 component files use Tailwind responsive breakpoint modifiers (`sm:`, `md:`, `lg:`). The app primarily handles responsiveness via the `useIsMobile()` hook with conditional rendering (different component trees for mobile vs. desktop). While this works, it:
1. Doubles the JSX surface area (two layouts to maintain)
2. Cannot handle intermediate viewport sizes gracefully
3. Makes responsive behavior invisible in CSS — you must read the JSX to understand layout behavior

Specific gaps:
- `AppShell.tsx:213` — Hardcoded `gridTemplateColumns: '220px 1fr'` sidebar width (not responsive)
- Multiple `grid` and `flex` layouts have no breakpoint variants
- 104 arbitrary width classes (`w-[...]`) with hardcoded values

**Impact**: Components may not render well at intermediate viewport sizes (tablet, small desktop). The conditional rendering approach is maintainable but creates larger component files.

**Recommendation**:
1. For layout-critical components (AppShell, PageLayout), prefer CSS breakpoints over JS-conditional rendering where possible.
2. Audit components with `grid` or fixed `w-[...]` classes for missing breakpoint variants.
3. The `useIsMobile()` hook is acceptable for structural differences (e.g., drawer vs. sidebar) but should not be the only responsive mechanism.

**Implementation Owner**: `apps/web`
**Effort**: L

---

### [LOW] F12 — Inline Style Props for Layout

**Track**: 4 — Coding Standards
**Location**: 108+ instances across `apps/web/src/`
**Category**: standards

**Finding**: 108+ components use inline `style={{}}` props with layout-affecting values (padding, margin, width, height, gap). Many use conditional logic: `isMobile ? 18 : 16`. These inline styles bypass Tailwind's utility class system and cannot be overridden by the design system.

Examples:
- `FileBrowserPanel.tsx:137` — `style={{ height: isMobile ? 18 : 16, width: isMobile ? 18 : 16 }}`
- `AppShell.tsx:171` — `style={{ gridTemplateColumns: '220px 1fr', gridTemplateRows: '1fr auto' }}`
- `GitDiffView.tsx:157-161` — `style={{ borderCollapse: 'collapse', width: '100%', minWidth: 320 }}`

**Impact**: Low — these are mostly for dynamic or calculated values that Tailwind classes cannot express. The pattern is acceptable for values derived from JavaScript state but should be minimized.

**Recommendation**: Replace static inline styles with Tailwind classes where possible. Dynamic values that depend on JS state are acceptable as inline styles.

**Implementation Owner**: `apps/web`
**Effort**: S

---

## Top 20 Most Impactful Violations

| Rank | ID | Severity | Finding | Effort |
|------|----|----------|---------|--------|
| 1 | F01 | HIGH | ~60% of mutation routes lack Valibot validation | M |
| 2 | F05 | HIGH | 7 route files exceed 500-line limit (up to 995) | M |
| 3 | F10 | HIGH | Hardcoded hex colors bypass design token system (~10 files) | M |
| 4 | F04 | MEDIUM | Single global ErrorBoundary — no feature isolation | M |
| 5 | F03 | MEDIUM | 412 useEffect calls with no automated interaction-effect tracing | L |
| 6 | F11 | MEDIUM | Only 16/100+ component files use responsive breakpoints | L |
| 7 | F06 | MEDIUM | Business logic leaking into route handlers | M |
| 8 | F02 | MEDIUM | `no-explicit-any` is warn, not error, for production code | S |
| 9 | F07 | LOW | Inconsistent error response diagnostic enrichment | S |
| 10 | F12 | LOW | 108+ inline style props for layout values | S |
| 11 | F08 | INFO | Fire-and-forget goroutines in ACP gateway (safe but untracked) | S |
| 12 | F09 | INFO | Go VM agent is exemplary reference implementation | S |
| 13 | — | INFO | `knowledge.ts:37` — env var parsed via `env as unknown as Record<...>` | S |
| 14 | — | INFO | jsx-a11y rules are warnings, not errors | S |
| 15 | — | INFO | `no-non-null-assertion` is warn, not error | S |
| 16 | — | INFO | Test files account for majority of type assertions (~70%) | — |
| 17 | — | INFO | `useProjectChatState.ts` has 10 effects — highest density in codebase | M |
| 18 | — | INFO | `acp-chat.css` (413 lines) — utility backfill for ACP client, potentially reducible | S |
| 19 | — | INFO | 5 raw CSS files remain (all legitimate — Tailwind theme, markdown, terminal) | — |
| 20 | — | INFO | Logger + instrumented logger patterns are dual-track (standard vs. D1-persisted) | — |

---

## Implementation-Ready Follow-Up Task Packets

### P0: Add Valibot Validation to All Mutation Routes

**Priority**: P0 (security + correctness)
**Files to modify**: ~19 route files listed in F01
**Pattern**: Add `jsonValidator(Schema)` middleware to each POST/PUT/PATCH handler
**Reference implementation**: `apps/api/src/routes/tasks/crud.ts:78` (uses `jsonValidator(SubmitTaskSchema)`)
**Schema location**: `apps/api/src/schemas/` — create new schema files as needed
**Estimated schemas to create**: ~15 new Valibot schemas
**Test requirement**: Each new schema needs unit tests for valid/invalid input
**Acceptance criteria**: `grep -r "\.post\|\.put\|\.patch" apps/api/src/routes/ | grep -v jsonValidator | grep -v "\.get\|\.delete"` returns zero unvalidated mutation routes

### P0: Split Oversized Route Files

**Priority**: P0 (maintainability, agent navigability)
**Files**: `tasks/crud.ts` (995), `projects/crud.ts` (920), `triggers/crud.ts` (842), `workspaces/runtime.ts` (814), `mcp/dispatch-tool.ts` (685), `chat.ts` (655), `credentials.ts` (682)
**Pattern**: Directory with one file per operation group + `index.ts` barrel (per Rule 18)
**Reference**: The existing `tasks/`, `projects/`, `workspaces/` directories already demonstrate the pattern — the `crud.ts` files inside them just need further splitting
**Test requirement**: No behavior change; existing tests must pass unmodified
**Acceptance criteria**: `pnpm quality:file-sizes` passes with no route files over 500 lines

### P1: Add Feature-Level Error Boundaries

**Priority**: P1 (resilience)
**New component**: `FeatureErrorBoundary.tsx` — reusable boundary with localized error display and retry
**Wrap locations**: Chat view, terminal panel, settings drawer, file browser, admin pages
**Reference**: Existing `ErrorBoundary.tsx` — extend with retry capability and localized UI
**Test requirement**: Behavioral test for each boundary — render, throw, verify recovery UI appears
**Acceptance criteria**: An error thrown in the chat panel does not crash the terminal or settings

### P1: Extract Design Tokens for Account Map Colors

**Priority**: P1 (constitution compliance)
**Token file**: `packages/ui/src/tokens/theme.css` — add `--sam-color-map-*` variables
**Files to update**: 5 account-map component files listed in F10 + LogEntry, LogsSection
**Pattern**: Replace `#00ccff` with `text-map-workspace` (Tailwind class via @theme)
**CI check**: Add hex-color detection to `pnpm quality:ast-checks`
**Acceptance criteria**: `grep -r '#[0-9a-fA-F]\{6\}' apps/web/src/components/ --include='*.tsx'` returns zero matches

### P1: Escalate `no-explicit-any` to Error for Production Code

**Priority**: P1 (type safety)
**File**: `.eslintrc.cjs`
**Change**: Add override for `apps/api/src/**/*.ts` and `apps/web/src/**/*.tsx` setting `no-explicit-any` to `error`, keep `warn` for test files
**Test requirement**: `pnpm lint` must pass (fix any existing production `any` usages first)
**Acceptance criteria**: Lint passes; new `any` in production code fails CI
