# P4-03: Frontend Route Code Splitting

**Phase**: 4 (Performance & Code Organization)
**Priority**: P1
**Risk Level**: Medium — modifies app loading behavior
**Effort**: M (1-2 days)
**Source Findings**: F-019 (Track 5: Performance)
**Recommended Skill(s)**: `$ui-ux-specialist`

## Scope

All 59 page components are statically imported in `App.tsx`, including heavy visualization libraries (mermaid ~280KB, recharts ~200KB, @xyflow/react ~180KB). Every user downloads ~700KB of unused JS. Add `React.lazy()` for route-level code splitting.

## Files Likely Touched

- `apps/web/src/App.tsx` — convert static imports to `React.lazy()`
- `apps/web/vite.config.ts` — configure `manualChunks` for vendor splitting
- `apps/web/package.json` — remove unused `react-simple-maps` dependency
- Route components — no changes needed (lazy loading is transparent)
- Loading/Suspense boundary component (new or existing)

## Compatibility Constraints

- Loading states must be accessible and visually acceptable (not blank pages)
- Route transitions must remain smooth (prefetch on hover if possible)
- No change to routing logic or URLs
- Existing tool names and API compatibility unchanged

## Automated Tests to Add/Run

- Playwright visual audit: verify loading states render correctly
- Test: each lazy-loaded route renders after chunk loads
- Bundle analysis: `npx vite-bundle-visualizer` — verify >40% initial JS reduction
- `pnpm --filter web test`

## Manual Staging Verification

- Navigate to admin pages, account map, project chat — verify they load correctly
- Check network tab for chunk loading behavior
- Verify no blank pages during navigation
- Test on throttled connection (3G simulation)

## Expected Post-Deploy State

- Initial bundle size reduced by >40%
- Heavy libraries loaded on demand
- Admin pages, chart pages, account map in separate chunks

## Visible Behavior Changes

- First navigation to heavy pages (admin, account map) may show brief loading indicator
- Subsequent navigations are cached
- Overall app feels faster on initial load

## Rollback Notes

- Revert to static imports in App.tsx. No data migration.

## Acceptance Criteria

- [ ] Major routes use `React.lazy()` or equivalent
- [ ] Admin pages (analytics, costs, AI usage) lazy-loaded
- [ ] Account map page lazy-loaded
- [ ] Mermaid loaded dynamically only when markdown contains mermaid blocks
- [ ] `react-simple-maps` removed from package.json
- [ ] Loading states are accessible and visually acceptable
- [ ] Bundle analysis shows >40% initial JS reduction
- [ ] `pnpm --filter web test` passes

## Links

- Track report: `tracks/05-performance-cost.md` (Section 5.3: Frontend Performance)
- Finding: F-019 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 4, Task 4B
