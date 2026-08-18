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
| **SUPERSEDES the original 7-group plan**: a manual chunk group makes a lazy library EAGER | A group collapses matching modules across dynamic-import boundaries, so the chunk attaches to the entry's static graph and lands in `index.html`'s `modulepreload` set. Measured eager JS: 6 groups → 908 kB gz; 3 groups → 286 kB gz; 2 groups → **211 kB gz**. Grouping mermaid also collapsed its own per-diagram lazy chunks into one 2.7 MB chunk. | 2.1 (rewritten), 2.2 |
| **SUPERSEDES the waterfall plan**: a `project-chat` route group is worse than the waterfall | The group produced one **eager** 1,199 kB / 343 kB gz `route-project-chat` chunk — the whole chat page downloaded on the login screen. | 2.3 (parallel import instead) |
| A same-specifier retry cannot refetch a 404'd chunk | Chromium's ES module map caches a failed specifier for the document's lifetime; verified in `lazy-route-chunks-audit.spec.ts`. The reload rung is what recovers. | 4.2 (documented), 5.6 |
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
neutralised by starting the child `import()` inside the shell's own lazy loader so both
chunks fetch in parallel. (The originally-planned "co-locate both in one `advancedChunks`
group" was implemented and measured during this task: it made a 1,199 kB / 343 kB gzip
chunk **eager on every page load**, so it was replaced by the parallel-import approach.
See checklist item 2.3 and the measurement table in `vite.config.ts`.)

## Implementation Checklist

### 1. React.lazy + Suspense route wiring

- [x] 1.1 Add `lazyNamed()` helper so named page exports work with `React.lazy`
- [x] 1.2 Convert every page import in `App.tsx` to `lazyNamed`, keeping ONLY `Landing`
      (login/landing) and `Dashboard` static per rule 60
- [x] 1.3 Add `RouteFallback` — centered `Spinner`, fade-in delayed so a fast chunk load
      never flashes a spinner. (Ships WITHOUT a wrapper `role="status"`: `Spinner`
      already declares one, and this now mounts on ~90 routes, so a nested second status
      region would double-announce on every navigation.)
- [x] 1.4 Wrap each lazy route element in its own `<Suspense>` (per-route boundary, so a
      fallback can never unmount the `AppShell` chrome or a parent layout — rule 48)
- [x] 1.5 `.sam-route-fallback` reduced-motion override in `app.css` cancelling the
      animation AND the reveal delay (the design-system blanket rule only zeroes
      `animation-duration`, not `animation-delay`)

### 2. Vite chunking

- [x] 2.1 **REPLAN — the original 7-group plan was measured to be a regression.**
      `advancedChunks.groups` ships with `vendor-terminal` + `vendor-react` ONLY.
      `mermaid`/`recharts`/`@xyflow/react`/`react-markdown`/`remark-gfm`/
      `prism-react-renderer` are deliberately NOT grouped — grouping them attaches the
      chunk to the entry's static graph and makes them eager (908 kB gz vs 211 kB gz).
      Rationale + measurement table recorded in `vite.config.ts`.
- [x] 2.2 Verify from the build output that no heavy vendor group is reachable from the
      entry (`dist/index.html` modulepreload list — verified, and now guarded by
      `lazy-route-chunks-audit.spec.ts`)
- [x] 2.3 **REPLAN** — the `project-chat` route group in the original plan produced an
      eager 343 kB gz chunk. The `Project` → `ProjectChat` waterfall is instead collapsed
      by starting the child `import()` inside the shell's own loader (`App.tsx`).

### 3. Lazy mermaid

- [x] 3.1 Replace the static `import mermaid from 'mermaid'` with a memoised
      `loadMermaid()` dynamic import that also runs `initialize()` exactly once
- [x] 3.2 Move `DOMPurify` into the same dynamic path (only used for mermaid SVG output)
- [x] 3.3 Reset the memo on failure so a transient network error can be retried
- [x] 3.4 Route both dynamic imports through `importWithRetry` — mermaid's chunk is
      subject to the same stale-deploy 404 as any route chunk
- [x] 3.5 Loading affordance while the engine downloads (`min-h-16` +
      `role="status"` placeholder) instead of an invisible gap mid-message

### 4. Stale-chunk resilience

- [x] 4.1 `isChunkLoadError()` matching all four browser/bundler error shapes
- [x] 4.2 `importWithRetry()` — retry once after a configurable delay. **Measured
      caveat**: Chromium's module map caches a failed specifier, so the retry does not
      refetch on that engine; kept as cross-engine insurance, documented in the source.
      The reload rung is what recovers.
- [x] 4.3 One-shot reload recovery guarded by a `sessionStorage` marker + cooldown so a
      genuinely-missing chunk cannot cause a reload loop
- [x] 4.4 Non-chunk errors rethrow immediately (never trigger a reload)
- [x] 4.5 All timings env-configurable with `DEFAULT_*` constants (Principle XI), parsed
      through a `NaN`/non-positive guard so a malformed override cannot silently disable
      the cooldown; documented in `apps/web/.env.example` + `configuration.md`

### 5. Tests

- [x] 5.1 Unit tests for `lazy-with-retry` (success, retry-then-success, reload-once,
      loop-guard rethrow, non-chunk passthrough, cross-browser error strings,
      malformed-env fallback, valid-env override)
- [x] 5.2 Update `app-routes.test.tsx` to await lazy routes (`findByTestId`)
- [x] 5.3 Unit test proving non-diagram markdown never evaluates the `mermaid` module and
      a diagram does
- [x] 5.4 Playwright audit at 375px + 1280px across dashboard, projects, project chat,
      settings, admin analytics, account map, nodes, workspace — `assertNoOverflow`,
      no crash screen, per-route heavy-chunk allowance
- [x] 5.5 `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green
- [x] 5.6 Real-browser stale-chunk recovery test (404 a route chunk, assert the reload
      rung fires once and the loop guard holds)
- [x] 5.7 `lazyNamed` direct tests (happy path, missing export, loader not called until
      render)
- [x] 5.8 Name-independent first-paint byte budget, so a future chunk group cannot evade
      the substring markers

## Acceptance Criteria

- [x] Initial entry chunk gzip size drops materially vs. the 854.00 kB baseline —
      **76.63 kB gz (−91.0%)**; full eager set 976.2 kB → 211.4 kB gz (−78.3%)
- [x] `mermaid`, `recharts`, `@xyflow/react`, `@xterm/*` are absent from the entry chunk
      and from `dist/index.html`'s modulepreload set (guarded by the Playwright audit)
- [x] Rendering markdown without a diagram evaluates zero mermaid code (test-proven,
      verified discriminating by restoring the static import)
- [x] A failed chunk import recovers via a single reload and never loops (test-proven in
      unit tests AND in a real browser against the production build)
- [x] Route transitions never unmount the `AppShell` chrome (rule 48)
- [x] No horizontal overflow at 375px or 1280px on the audited routes
- [x] Only `Landing` and `Dashboard` remain statically imported in `App.tsx`

## Measured Results (durable record — `.do-state.md` is gitignored)

| metric | before (`1f64efc2f`) | after |
| --- | --- | --- |
| entry chunk | 3,121.19 kB raw / 854.00 kB gz | 271.32 kB / 76.63 kB gz |
| eager JS set (entry + modulepreload) | 3,624.9 kB / 976.2 kB gz (16 files) | 718.8 kB / 211.4 kB gz (14 files) |
| total emitted JS | 5,956.4 kB / 75 files | 6,444.3 kB / 230 files |

Total emitted JS grows because chunk boundaries add per-chunk overhead; 82 of the 230
files are mermaid's own per-diagram chunks, which existed in the baseline too — they were
simply downloaded eagerly before.

## Known Gaps / Accepted Tradeoffs

- **`AppShell` stays statically imported.** An anonymous visitor to `/` therefore still
  downloads authenticated chrome. Making it lazy would add a chunk waterfall to *every*
  authenticated page load; with the entry already at 76.63 kB gz the trade is not worth
  it. Revisit if the entry grows.
- **Non-chat `/projects/:id/*` children still cascade** (shell chunk → child chunk). Only
  `chat` is warmed in parallel because the index route redirects to it. The other
  children are lower-traffic; warming all of them would defeat the split.
- **`resetMermaidLoaderForTests()` is a production export used only by tests.** The
  alternative (`vi.resetModules()` + dynamic re-import, as in `auth-terminal-cleanup.test.ts`)
  would also re-run the `vi.mock` factory and destroy the module-evaluation counter these
  tests depend on.

## References

- SAM idea `01M09SKVNJGJNJY2WGCZ6D89XZ` (item #2)
- `.claude/rules/60-request-io-and-bundle-budgets.md` — route-splitting requirement
- `.claude/rules/48-stale-while-revalidate-ui.md` — fallback must not unmount content
- `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`
- `.claude/rules/03-constitution.md` — Principle XI (no hardcoded values)
- `tasks/backlog/2026-04-10-web-lazy-loading-error-boundaries-a11y.md` — prior art
