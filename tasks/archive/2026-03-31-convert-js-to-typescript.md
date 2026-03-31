# Convert 3 JS Files to TypeScript

## Problem

Three JavaScript files remain in the source tree. All can be converted to TypeScript with type annotations and build config updates.

## Research Findings

### File 1: `apps/api/src/shims/unicorn-magic.js`
- Wrangler esbuild shim providing Node-condition exports for `unicorn-magic` package
- Exports: `toPath`, `traversePathUp`, `rootDirectory`, `delay`
- Referenced in `apps/api/wrangler.toml` as alias: `"unicorn-magic" = "./src/shims/unicorn-magic.js"`
- Simple rename + type annotations + wrangler.toml update

### File 2: `apps/web/public/sw.js`
- Service worker for offline caching (111 lines)
- Registered via `apps/web/src/lib/pwa.ts` as `/sw.js`
- Uses network-first for navigation, stale-while-revalidate for assets
- Lives in `public/` (served statically, not processed by Vite)
- **Approach**: Move to `src/sw.ts` with ServiceWorkerGlobalScope types. Add minimal Vite plugin using esbuild to compile to `dist/sw.js` during build. No new dependencies needed.
- pwa.ts registration path `/sw.js` stays the same
- Dev mode doesn't need the SW (disabled by default per pwa.ts comments)

### File 3: `apps/www/public/scripts/tracker.js`
- Analytics tracker IIFE (82 lines) for the marketing site
- Referenced in `apps/www/astro.config.mjs` Starlight head config as `/scripts/tracker.js`
- Also referenced in `apps/www/src/layouts/Base.astro`
- **Approach**: Move to `src/scripts/tracker.ts`. Add Vite plugin (Astro uses Vite) to compile TS to output during build.

## Implementation Checklist

### unicorn-magic.js → .ts
- [ ] Rename file to `unicorn-magic.ts`
- [ ] Add type annotations to all 4 exported functions
- [ ] Update wrangler.toml alias to point to `.ts`
- [ ] Verify API build passes

### sw.js → .ts
- [ ] Create `apps/web/src/sw.ts` with ServiceWorkerGlobalScope types and full type annotations
- [ ] Add Vite plugin to compile sw.ts → dist/sw.js during build
- [ ] Remove `apps/web/public/sw.js`
- [ ] Verify web build produces sw.js in dist
- [ ] Update pwa.test.ts if needed

### tracker.js → .ts
- [ ] Create `apps/www/src/scripts/tracker.ts` with type annotations
- [ ] Add Vite plugin in astro config to compile tracker.ts → output
- [ ] Update astro.config.mjs head script reference if path changes
- [ ] Update Base.astro script reference if path changes
- [ ] Remove `apps/www/public/scripts/tracker.js`
- [ ] Verify www build produces tracker.js in output

### Final Verification
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
- [ ] `pnpm lint` passes
- [ ] Zero .js files in source directories (excluding node_modules, dist, config files)

## Acceptance Criteria
- [ ] All 3 files converted to TypeScript
- [ ] Type annotations on all function signatures
- [ ] Build configs updated
- [ ] All builds pass (`pnpm build`)
- [ ] All existing functionality preserved

## References
- Idea: 01KN2PS2QEBVT17XW01VPJMADT
- Task: 01KN2Q9SYM0HCFRE9H0KNNV3FB
