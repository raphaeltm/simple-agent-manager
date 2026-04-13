# Extract Env Interface from API Worker index.ts

## Problem

`apps/api/src/index.ts` is 945 lines. The `Env` interface (lines 73-486, ~414 lines) accounts for nearly half the file. This violates the 800-line mandatory split threshold (rule 18).

## Research Findings

- **Env interface**: Lines 73-486 in `apps/api/src/index.ts`. Pure interface, no imports needed — uses only Cloudflare Worker global types (D1Database, KVNamespace, DurableObjectNamespace, etc.)
- **~100 files** import `Env` from `../index`, `../../index`, or `./index` within `apps/api/src/`
- **No external consumers** outside the api package import `Env`
- **Separate Env type** exists in `apps/api/src/durable-objects/project-data/types.ts` — this is unrelated and should NOT be changed
- After extraction, `index.ts` will be ~530 lines (945 - 414 = 531), still above 500 but below mandatory 800

## Implementation Checklist

- [ ] Create `apps/api/src/env.ts` with the `Env` interface (lines 73-486)
- [ ] In `index.ts`, replace the interface with `import type { Env } from './env'` and `export type { Env }`
- [ ] Update ~100 files to import from `../env` / `../../env` instead of `../index` / `../../index`
- [ ] Verify `pnpm typecheck` passes
- [ ] Verify `pnpm lint` passes
- [ ] Verify `pnpm build` for api package passes
- [ ] Verify `pnpm test` passes

## Acceptance Criteria

- [ ] `Env` interface lives in `apps/api/src/env.ts`
- [ ] `index.ts` re-exports `Env` for backward compatibility
- [ ] All existing imports compile without errors
- [ ] All tests pass
- [ ] No behavioral changes — pure refactor
- [ ] `index.ts` is under 800 lines
