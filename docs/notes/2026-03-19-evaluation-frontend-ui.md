# Frontend & UI Module Evaluation

**Date:** 2026-03-19
**Scope:** `apps/web/`, `apps/www/`, `packages/ui/`, `packages/terminal/`, `packages/acp-client/`

---

## 1. apps/web/ — Control Plane UI

### Purpose & Scope

Main control plane interface for SAM. React 18 + Vite + React Router 6 + Tailwind CSS v4. 152 source files, 97 test files, 32 page components covering projects, workspaces, nodes, settings, admin, and chat.

**Directory structure:**
```
src/
├── components/     (admin, chat, node, project, shared, task, ui)
├── config/         (feature flags)
├── hooks/          (21 custom hooks)
├── lib/            (11 utilities: api, auth, error-reporting, etc.)
├── pages/          (32 page components)
├── styles/
└── App.tsx, main.tsx
```

### Code Quality

**Strengths:**
- Well-organized component hierarchy with clear separation (pages, shared components, feature components)
- Comprehensive hook library for complex async operations (WebSocket, polling, log streaming)
- Routing: React Router v6 with nested routes, protected routes, AppShell layout pattern
- State management: Context API (AuthContext) + React hooks — appropriate for the app's complexity
- Centralized `lib/api.ts` provides typed fetch wrapper with error handling and credential inclusion
- Error boundary and error reporting to Workers observability
- Tailwind integrated via `@tailwindcss/vite` v4.2.1, referencing SAM design tokens from `packages/ui`
- Dark-only theme with semantic token names (`--sam-color-bg-canvas`, `--sam-color-accent-primary`)

**Concerns:**
- **Oversized components:** `ProjectChat` (1,311 lines), `ProjectMessageView` (1,445 lines), `Workspace` (2,275 lines). These mix session management, task submission, polling, rendering, and lifecycle control in single files.
- Accessibility is inconsistent — `GlobalCommandPalette` has proper dialog semantics and ARIA, but many icon-only buttons lack labels.
- Heavy use of `vi.hoisted()` mocks and module-scope mock factories in tests can hide integration issues.

### Test Coverage

97 test files using Vitest + React Testing Library. Tests render components and simulate user interactions (good behavioral pattern). Coverage gaps:
- Some tests mock entire modules (`api.ts`, `AuthProvider`) which can mask integration failures
- No E2E/Playwright tests for critical flows (task submission, workspace creation, chat lifecycle)
- Feature flag usage not verified by tests

### Dead Code / Tech Debt

- Feature flags defined in `config/features.ts` but usage pattern not verified across the codebase
- No TODO/FIXME markers found (good sign)
- The three oversized page components are the primary tech debt

### Recommendations

1. **Decompose large page components.** Extract from `ProjectChat`: `TaskSubmissionForm`, `SessionList`, `ProvisioningStatusIndicator`. Extract from `ProjectMessageView`: `MessageRenderer`, `WorkspaceInfoPanel`, `IdleTimeoutBanner`. Extract from `Workspace`: terminal management, lifecycle controls, and tab state into separate modules. Target: no component file exceeds 400 lines.
2. **Add E2E capability tests.** Playwright tests for: (a) task submission → provisioning → agent execution, (b) workspace creation → WebSocket → terminal rendering, (c) chat session lifecycle (active → idle → stopped). These would catch the class of bugs that 97 unit tests miss.
3. **Accessibility audit.** Add `aria-label` to all icon-only buttons, ensure keyboard navigation works through all interactive flows, add skip-nav links.

---

## 2. apps/www/ — Public Website

### Purpose & Scope

Marketing + documentation website built with **Astro 5.x + Starlight**. Deployed to `www.simple-agent-manager.org`. Contains:
- Landing page with hero, 15 feature cards, comparison table, roadmap, social proof, CTAs
- Documentation site (Starlight): 16 pages covering overview, quickstart, guides, architecture, API reference
- Blog: 3 substantive technical posts

### Code Quality

- Professional design with smooth animations, responsive layouts, semantic HTML
- Well-organized: clear navigation, proper documentation hierarchy
- 1,891 lines of Astro components, all purposeful
- Sitemap generation, custom Starlight theming, edit links to GitHub
- Clean separation between marketing pages (`src/pages/`) and docs content (`src/content/docs/`)

### Test Coverage

No tests — acceptable for a static marketing/docs site. Content correctness is verified by human review.

### Dead Code / Tech Debt

- `src/pages/presentations/` directory exists but is empty — minor, could be removed
- Blog content may drift from actual product capabilities as features evolve

### Recommendations

1. **Remove empty `presentations/` directory** to avoid confusion.
2. **Add a doc-sync check** — when product features change in `apps/api/` or `apps/web/`, flag corresponding docs in `apps/www/src/content/docs/` for review. Currently docs can silently go stale.

---

## 3. packages/ui/ — Shared Design System

### Purpose & Scope

Shared UI component library: 18 components, 3 layout primitives, 2 hooks, comprehensive design token system. All components actively used in `apps/web/` (no dead exports).

**Components:** Alert, Breadcrumb, Button, ButtonGroup, Card, Dialog, DropdownMenu, EmptyState, Input, Select, Skeleton/SkeletonCard/SkeletonList, Spinner, StatusBadge, Tabs, Toast/ToastContainer, Tooltip

**Primitives:** Container, PageLayout, Typography (6 tier variants)

**Hooks:** useClickOutside, useEscapeKey

### Code Quality

**Strengths:**
- Consistent props pattern: HTML attribute passthrough, `className`/`style` support, `forwardRef` where needed
- Composable architecture: `ButtonGroup` wraps children dynamically, Skeleton family builds on itself, Toast system separates concerns
- Strong accessibility: DropdownMenu has full keyboard nav (Arrow Up/Down, Tab, Enter), Tabs has Arrow Left/Right + Home/End, Dialog has Escape close, Tooltip uses `aria-describedby`
- Comprehensive design token system: 30+ color tokens, 5 spacing values, 3 radius values, 6 typography tiers, 4 shadow scales, z-index scale, Tokyo Night palette for terminal UI
- Three semantic token variants: default, high-contrast, reduced-motion
- All components fully typed, no `any` types
- No external UI libraries (Radix, Headless UI) — all built from scratch

**Concerns:**
- Spacing inconsistency: some components use hardcoded Tailwind (`py-2.5 px-3`) instead of `--sam-space-*` tokens
- Typography mixing: both utility classes (`.sam-type-*`) and inline `clamp()` styles used
- CSS variables not scoped — components assume `:root` has `--sam-*` variables. If Tailwind is configured without importing `theme.css`, components render unstyled.

### Test Coverage

7 of 18 components tested (39%): ButtonGroup, Breadcrumb, DropdownMenu, EmptyState, Tabs, Tooltip, Typography. Tests use `@testing-library/react` with user interactions and ARIA assertions — good quality.

**Untested:** Alert, Button, Card, Dialog, Input, Select, Skeleton, Spinner, StatusBadge, Toast, Container, PageLayout.

Storybook is configured but only 2 stories exist (Button, StatusBadge). 16 components lack stories.

### Dead Code / Tech Debt

No dead code — all 18 components actively imported. The gap is in testing and documentation, not dead code.

### Recommendations

1. **Increase test coverage to 80%+.** Priority: Dialog (keyboard Escape, click-outside overlay, overflow lock), Button (loading state, disabled state, all variants), Input/Select (form integration, validation states), Toast (auto-dismiss timing, stacking).
2. **Write Storybook stories for all components.** Currently 2 of 18 — this is the primary documentation mechanism for a design system. Each story should demonstrate variants, sizes, interactive states.
3. **Standardize spacing usage.** Audit all components for hardcoded Tailwind padding/margins and replace with `--sam-space-*` token equivalents for consistency.

---

## 4. packages/terminal/ — Shared Terminal Component

### Purpose & Scope

Multi-terminal management component with xterm.js v5.5. Provides single-terminal (`Terminal`) and multi-tab terminal (`MultiTerminal`) components with custom WebSocket protocol, session persistence, and reconnection.

**Architecture:**
- `Terminal.tsx` — single instance (280 lines)
- `MultiTerminal.tsx` — multi-tab container (800+ lines)
- `protocol.ts` — custom JSON WebSocket protocol for session routing (232 lines)
- `useWebSocket.ts` — connection lifecycle with exponential backoff (189 lines)
- `hooks/useTerminalSessions.ts` — session CRUD + persistence (358 lines)
- `components/TabBar.tsx`, `TabItem.tsx`, `TabOverflowMenu.tsx` — tab UI

### Code Quality

**Strengths:**
- Proper closure safety: refs for latest callback versions prevent stale closures in long-lived effects
- Unmount guards: `mountedRef` and `disposed` flags prevent state updates after unmount
- Thorough cleanup: intervals, timeouts, listeners, ResizeObservers all cleaned up
- Session persistence via `sessionStorage` survives page reloads
- Graceful degradation when `sessionStorage` unavailable
- Double-rAF for tab switch animations ensures DOM layout complete before measuring
- Custom binary protocol supports: input, resize, ping, create/close/rename/reattach/list sessions
- Exponential backoff: configurable base delay (1s), max delay (30s), max 5 retries
- 30-second heartbeat prevents proxy idle timeouts

**Concerns:**
- `MultiTerminal.tsx` at 800+ lines is on the edge of being too large
- No rate limiting on terminal input — user keyboard input sent immediately without batching
- Scrollback lost on fresh reconnect (only restored for reattached sessions)

### Test Coverage

5 test files covering WebSocket lifecycle, protocol encoding/decoding, session management, tab UI, and multi-terminal integration. Tests use mocked WebSocket and xterm.js — no real protocol compliance tests.

### Dead Code / Tech Debt

No dead code detected. xterm.js pinned to exact `@5.5.0` — should use range for patch updates.

### Recommendations

1. **Add protocol compliance test.** Create a mock WebSocket server that validates the exact binary protocol, testing round-trip message encoding/decoding with realistic multi-session scenarios.
2. **Consider input batching.** For high-throughput scenarios (paste operations, rapid typing), batch terminal input into 16ms frames to reduce WebSocket message volume.

---

## 5. packages/acp-client/ — Agent Communication Protocol Components

### Purpose & Scope

Comprehensive React component library for ACP session integration. 11,461 lines of source code, 31 components, 4 core hooks, WebSocket transport layer. Handles the full agent chat experience: session lifecycle, message streaming, tool calls, plans, voice input, audio playback, settings, and error recovery.

**Core hooks:** `useAcpSession` (9-state lifecycle), `useAcpMessages` (conversation processing), `useAutoScroll` (sticky-to-bottom), `useAudioPlayback` (TTS)

**Key components:** AgentPanel (top-level), MessageBubble (markdown + syntax highlighting), ToolCallCard, SlashCommandPalette, VoiceButton, AudioPlayer, ChatSettingsPanel, PlanView/PlanModal, FileDiffView, TerminalBlock

### Code Quality

**Strengths:**
- Mature, production-quality architecture with excellent separation of concerns
- 14 structured error codes with severity classification (transient/recoverable/fatal) and user-facing messages
- Memory-safe: conversation items capped at 500, individual message text at 512KB, blob URL lifecycle managed
- Sophisticated reconnection: exponential backoff with ±25% jitter, close code classification, 60s total timeout
- Multi-viewer session replay with synchronization guards (replay timing race, scroll position race, streaming deadlock, double reconnection, user message dedup — all handled)
- Offline/online detection with visibility change reconnection
- Application-level heartbeat (30s ping, 10s pong timeout) works through Cloudflare proxies
- Efficient updates: tool call lookups search backward from most recent, streaming appends avoid full array spreads
- React-markdown + prism-react-renderer with stable component overrides (hoisted to module scope) to prevent unmount/remount flicker
- Virtuoso for efficient rendering of 500+ conversation items

**Concerns:**
- No end-to-end test of full session lifecycle (UI → WebSocket → message processing → render)
- No visual regression tests for modal/panel layouts

### Test Coverage

17 test files, 333 passing tests in ~9.8s. Covers all hooks (session state machine, message processing, auto-scroll), transport (heartbeat, routing), errors (classification, metadata), and all major components. Tests use `renderHook`, behavioral assertions, MockWebSocket simulation. No snapshot tests — all assertions explicit. This is the best-tested package in the frontend.

### Dead Code / Tech Debt

No dead code detected. All exports actively used. The codebase is clean and purpose-built.

### Recommendations

1. **Add integration test for full session lifecycle.** Test the complete flow: WebSocket open → session state negotiation → message streaming → tool calls → prompt completion → reconnection replay. This would be the capability test that proves the system works end-to-end.
2. **Add visual regression tests.** Use Playwright component testing for AgentPanel, ChatSettingsPanel, and PlanModal to catch layout regressions that behavioral tests miss.

---

## Cross-Module Analysis

### Dependency Flow

```
packages/shared (types)
       ↓
packages/ui (components + design tokens)
       ↓
packages/terminal (terminal component)
packages/acp-client (chat components)
       ↓
apps/web (integrates all)
apps/www (independent — marketing + docs)
```

### Integration Quality

| Integration | Quality | Notes |
|------------|---------|-------|
| ui → web | Good | All 18 components actively used, design tokens flow correctly |
| terminal → web | Good | MultiTerminal used in Workspace page with token refresh |
| acp-client → web | Good | AgentPanel + hooks used in ProjectChat/ProjectMessageView |
| terminal ↔ acp-client | None | No direct dependency — both render in workspace page |

### Comparative Assessment

| Module | Code Quality | Test Coverage | Architecture | Maturity |
|--------|-------------|---------------|--------------|----------|
| **apps/web** | Good (3 oversized files) | Good (97 files, heavy mocks) | Good | Production |
| **apps/www** | Good | N/A (static) | Good | Production |
| **packages/ui** | Good | Fair (39%) | Good | Needs polish |
| **packages/terminal** | Very Good | Good | Very Good | Production |
| **packages/acp-client** | Excellent | Excellent (333 tests) | Excellent | Production |

### Top-Priority Improvements (Across All Modules)

1. **Decompose oversized components in apps/web** — `ProjectChat` (1,311 lines), `ProjectMessageView` (1,445 lines), and `Workspace` (2,275 lines) are the biggest maintainability risks. Target: no file over 400 lines.

2. **Increase packages/ui test coverage from 39% to 80%+** — The shared design system is the foundation for all UI. Untested components (Dialog, Button, Input, Select, Toast) are used throughout `apps/web`.

3. **Add E2E capability tests** — 97 unit test files in `apps/web` + 333 tests in `packages/acp-client` provide strong component coverage, but no test exercises the full user flow across module boundaries. A small Playwright test suite covering task submission, workspace terminal, and chat session lifecycle would catch the class of bugs that component tests miss.

4. **Complete Storybook coverage in packages/ui** — 2 of 18 components have stories. A design system without visual documentation forces developers to read source code to understand component APIs and variants.

5. **Standardize spacing tokens** — Mixed use of hardcoded Tailwind values and `--sam-space-*` tokens in `packages/ui` components creates inconsistency that will compound as the design system grows.
