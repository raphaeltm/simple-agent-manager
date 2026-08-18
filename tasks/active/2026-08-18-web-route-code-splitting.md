# Web: Route-Level Code Splitting (React.lazy + Vite advancedChunks + lazy mermaid)

UI Performance Program — Workstream B (item #2 of SAM idea `01M09SKVNJGJNJY2WGCZ6D89XZ`).

## Problem Statement

`apps/web/src/App.tsx` statically imports every page component (~90 imports, lines 15-90).
`React.lazy` usage in `apps/web` is zero and `apps/web/vite.config.ts` sets no chunking
strategy. Every user therefore downloads, parses, and executes the entire application —
admin analytics charts, the account-map graph canvas, the workspace terminal, and the
mermaid diagram engine — before the login screen can paint.

Measured baseline (`pnpm --filter @simple-agent-manager/web build`, commit `1f64efc2f`):

| Metric | Value |
| --- | --- |
| Initial entry chunk (`assets/index-*.js`) | **3,121.19 kB raw / 854.00 kB gzip** |
| Total emitted JS | 5,817.2 kB across 75 files |

Rule `.claude/rules/60-request-io-and-bundle-budgets.md` states: *"Every top-level page in
`apps/web/src/pages/` MUST be imported via `React.lazy`. Static imports of page components
from `App.tsx` or router config are banned for pages not in the initial landing set
(dashboard, login)."* The current code violates this rule outright.

## Research Findings

### Verified against code (line numbers as of `1f64efc2f`)

| Finding | Evidence | Becomes checklist item |
| --- | --- | --- |
| ~90 static page imports in the router | `apps/web/src/App.tsx:15-90` | 1.1, 1.2 |
| No chunking config at all | `apps/web/vite.config.ts:33-41` (only `outDir`/`sourcemap`) | 2.1 |
| `mermaid` imported at module load on the chat path | `apps/web/src/components/MarkdownRenderer.tsx:3`; `ensureMermaidInit()` at :44; used only inside `MermaidDiagram` at :93 | 3.1, 3.2 |
| `@xyflow/react` reachable only from account-map | 11 files under `apps/web/src/components/account-map/` | 2.1 |
| `recharts` reachable only from admin analytics/costs | `apps/web/src/pages/AdminCosts.tsx`, `apps/web/src/pages/admin-analytics/*.tsx` (4 files) | 2.1 |
| `@xterm/*` reachable only from the workspace terminal | `packages/terminal/src/{Terminal,MultiTerminal}.tsx`, `types/multi-terminal.ts` | 2.1 |
| `prism-react-renderer` cannot be dynamically imported from MarkdownRenderer | `CODE_THEME_BG` (`MarkdownRenderer.tsx:127`) is a **synchronous** module-scope export consumed by other components — it must stay statically imported and be split by chunk group instead | 2.1 (chunk group, not dynamic import) |
| Bundler is **Rolldown**, not Rollup | vite `8.1.3`; `dist/assets/rolldown-runtime-*.js` present; `rolldown@1.1.4` exposes `output.advancedChunks.groups` **and** legacy `output.manualChunks` (`define-config-BBz954-q.d.mts:791,834`) | 2.1 — use `advancedChunks` (the non-deprecated API for this bundler) |
| Service worker serves scripts stale-while-revalidate and does **not** rescue a 404 | `apps/web/src/sw.ts:60-62,231-256` — a missing chunk returns the origin 404/HTML, so the dynamic import rejects | 4.x |
| Assets are content-hashed with long TTL ("cache-bust on deploy") | idea `01M09SKVNJGJNJY2WGCZ6D89XZ`, "What's already good" | 4.x |
| `app-routes.test.tsx` asserts routes **synchronously** | `apps/web/tests/unit/app-routes.test.tsx:206-273` uses `screen.getByTestId` | 5.2 |
| Reusable audit helpers already exist | `apps/web/tests/playwright/audit-helpers.ts` exports `assertNoOverflow`, `screenshot`, `setupAuditRoutes`, `makeMockUser` | 5.4 |
| `Spinner` + `sam-char-fade-in` keyframe available for the fallback | `packages/ui/src/components/Spinner.tsx`; `apps/web/src/app.css:143` | 1.3 |

### Stale-chunk failure mode (the reason deliverable 4 exists)

Content-hashed assets + a redeploy = an open SPA session still holds the *old*
`index.html` module graph. Its `React.lazy` import URLs point at hashed filenames that no
longer exist on the origin. The dynamic import rejects and — with no recovery — every
navigation to a not-yet-loaded route is permanently broken until the user manually
reloads. `sw.ts:231-256` does not help: `staleWhileRevalidate` only caches `status === 200`
and returns the 404 response verbatim on a miss.

Browser error strings differ, so detection must match all of them:

- Chromium — `Failed to fetch dynamically imported module`
- Firefox — `error loading dynamically imported module`
- WebKit — `Importing a module script failed`
- Bundler/webpack-style — `error.name === 'ChunkLoadError'`

### Prior art coverage (`tasks/backlog/2026-04-10-web-lazy-loading-error-boundaries-a11y.md`)

| Prior-art item | This task |
| --- | --- |
| §1 Route-level lazy loading (all three bullets) | **Covered** |
| §2 Granular `RouteErrorBoundary` | **Not covered** — deliberately out of scope; deliverable 4's chunk recovery is a different mechanism. Left in the backlog file. |
| §3 Accessibility (`aria-label`, `type="button"` ×62) | **Not covered** — unrelated to this workstream. |
| §4 AuthProvider null-context fix | **Not covered** — owned by the chat/client workstream's files. |
| §5 `crypto.randomUUID()` in `useTerminalSessions` | **Not covered** — `packages/terminal`, out of scope. |
| §6 Testing | **Covered** for the lazy-loading slice only. |

Prior art keeps `ProjectChat` and `Project` eager; rule 60 (newer, and cited by this
workstream's brief) supersedes that and limits the static set to the landing/dashboard
pair. Rule 60 wins. The `Project` shell → `ProjectChat` child waterfall this creates is
neutralised by co-locating both in one `advancedChunks` group so the second lazy import
resolves from an already-fetched chunk.

## Implementation Checklist

### 1. React.lazy + Suspense route wiring

- [ ] 1.1 Add `lazyNamed()` helper so named page exports work with `React.lazy`
- [ ] 1.2 Convert every page import in `App.tsx` to `lazyNamed`, keeping ONLY `Landing`
      (login/landing) and `Dashboard` static per rule 60
- [ ] 1.3 Add `RouteFallback` — centered `Spinner`, `role="status"`, fade-in delayed so a
      fast chunk load never flashes a spinner
- [ ] 1.4 Wrap each lazy route element in its own `<Suspense>` (per-route boundary, so a
      fallback can never unmount the `AppShell` chrome or a parent layout — rule 48)

### 2. Vite chunking

- [ ] 2.1 Add `build.rollupOptions.output.advancedChunks.groups` splitting
      `vendor-mermaid`, `vendor-charts`, `vendor-flow`, `vendor-terminal`,
      `vendor-markdown`, `vendor-react`, and a `project-chat` route group
- [ ] 2.2 Verify from the build output that no heavy vendor group is reachable from the
      entry (check `dist/index.html` modulepreload list)

### 3. Lazy mermaid

- [ ] 3.1 Replace the static `import mermaid from 'mermaid'` with a memoised
      `loadMermaid()` dynamic import that also runs `initialize()` exactly once
- [ ] 3.2 Move `DOMPurify` into the same dynamic path (only used for mermaid SVG output)
- [ ] 3.3 Reset the memo on failure so a transient network error can be retried

### 4. Stale-chunk resilience

- [ ] 4.1 `isChunkLoadError()` matching all four browser/bundler error shapes
- [ ] 4.2 `importWithRetry()` — retry once after a configurable delay
- [ ] 4.3 One-shot reload recovery guarded by a `sessionStorage` marker + cooldown so a
      genuinely-missing chunk cannot cause a reload loop
- [ ] 4.4 Non-chunk errors rethrow immediately (never trigger a reload)
- [ ] 4.5 All timings env-configurable with `DEFAULT_*` constants (Principle XI)

### 5. Tests

- [ ] 5.1 Unit tests for `lazy-with-retry` (success, retry-then-success, reload-once,
      loop-guard rethrow, non-chunk passthrough, cross-browser error strings)
- [ ] 5.2 Update `app-routes.test.tsx` to await lazy routes (`findByTestId`)
- [ ] 5.3 Unit test proving non-diagram markdown never evaluates the `mermaid` module and
      a diagram does
- [ ] 5.4 Playwright audit at 375px + 1280px across dashboard, project chat, settings,
      admin analytics, account map, workspace — `assertNoOverflow`, no blank flash
- [ ] 5.5 `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green

## Acceptance Criteria

- [ ] Initial entry chunk gzip size drops materially vs. the 854.00 kB baseline
- [ ] `mermaid`, `recharts`, `@xyflow/react`, `@xterm/*` are absent from the entry chunk
      and from `dist/index.html`'s modulepreload set
- [ ] Rendering markdown without a diagram evaluates zero mermaid code (test-proven)
- [ ] A failed chunk import retries once, then reloads once, then surfaces an error —
      never loops (test-proven)
- [ ] Route transitions never unmount the `AppShell` chrome (rule 48)
- [ ] No horizontal overflow at 375px or 1280px on the audited routes
- [ ] Only `Landing` and `Dashboard` remain statically imported in `App.tsx`

## References

- SAM idea `01M09SKVNJGJNJY2WGCZ6D89XZ` (item #2)
- `.claude/rules/60-request-io-and-bundle-budgets.md` — route-splitting requirement
- `.claude/rules/48-stale-while-revalidate-ui.md` — fallback must not unmount content
- `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`
- `.claude/rules/03-constitution.md` — Principle XI (no hardcoded values)
- `tasks/backlog/2026-04-10-web-lazy-loading-error-boundaries-a11y.md` — prior art
