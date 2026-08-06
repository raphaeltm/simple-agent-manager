# Namespace frontend library cache by authenticated user

## Problem

The web app caches project library file and directory metadata in `localStorage` under project-only keys. If a browser logs out, expires, or switches accounts, a later user with the same or colliding project ID can briefly see previous-user library metadata from cache before revalidation. The fix must isolate the frontend cache by authenticated user/session and clear unsafe cache on auth transitions, while preserving same-user stale-while-revalidate behavior.

## Scope

- Apps/web only.
- R2 finding 1 only.
- No API contract changes.
- No changes to persisted cache value data formats unless additive metadata is necessary; prefer namespacing keys so existing value formats remain readable.

## Research findings

- `apps/web/src/lib/library-cache.ts` owns library `localStorage` reads/writes. Current keys are `sam-library:<projectId>:files:<directory>:<sort>`, `sam-library:<projectId>:dirs:<parent>`, and `sam-library:<projectId>:global-index`.
- `apps/web/src/hooks/useLibraryIndex.ts` hydrates global index from cache for flicker-free first paint, then sweeps the library in the background.
- `apps/web/src/pages/ProjectLibrary.tsx` hydrates directory and over-cap file caches at render time before async fetches.
- `apps/web/src/lib/auth.ts` clears all library cache only on sign-out success, which does not cover session expiry or account switch transitions.
- Relevant historical note: `tasks/archive/2026-03-24-pwa-auth-race-condition.md` covers BetterAuth null session behavior and transition sensitivity.
- UI changes in `apps/web` require local Playwright visual audit per `.claude/rules/17-ui-visual-testing.md`.

## Implementation checklist

- [x] Add a deterministic authenticated cache namespace derived from the active user/session.
- [x] Update library cache APIs to read/write namespaced keys while keeping cache payload formats unchanged.
- [x] Handle legacy project-only cache safely by refusing authenticated hydration from legacy keys and removing unsafe legacy keys on transitions.
- [x] Add AuthProvider-level cleanup for null/user and account switch transitions.
- [x] Make logout clear namespaced cache deterministically before redirect, regardless of request success.
- [x] Update ProjectLibrary and `useLibraryIndex` to pass the namespace and reset render state when namespace changes.
- [x] Add scenario-driven unit/component tests covering cache isolation, AuthProvider transitions, ProjectLibrary cached render safety, logout, expiry, and account switch.
- [x] Run ProjectLibrary visual audit with normal, long text, empty, many, and error states on mobile and desktop.
- [x] Run specialist review and address findings (recovery pass completed successfully for ui-ux, security, test-engineer, task-completion, constitution, and doc-sync reviewers).
- [x] Run local quality suite and staging verification.
- [ ] Open PR and verify CI green.

## Acceptance criteria

- Previous-user file metadata is never rendered from `localStorage` after logout, session expiry, or account switch, including when project IDs collide.
- Same-user cache hydration still works and stale-while-revalidate UX is preserved.
- Legacy un-namespaced cache cannot leak metadata into authenticated ProjectLibrary renders.
- Logout/session expiry/account switch clear unsafe library cache deterministically.
- Tests fail against the old project-only cache behavior and pass with the fix.
- PR is open, CI green, and unmerged.


## Completion evidence

### Local quality

- Focused regression suite: `pnpm --filter @simple-agent-manager/web test -- tests/unit/lib/library-cache.test.ts tests/unit/lib/auth-signout.test.ts tests/unit/components/auth-provider.test.tsx tests/unit/hooks/useLibraryIndex.test.ts tests/unit/pages/project-library.test.tsx` — 69 tests passed.
- Full web suite: `pnpm --filter @simple-agent-manager/web lint && pnpm --filter @simple-agent-manager/web typecheck && pnpm --filter @simple-agent-manager/web test && pnpm --filter @simple-agent-manager/web build` — lint passed with pre-existing warnings only, typecheck passed, 2,858 tests passed, build passed with existing bundle/CSS warnings.

### Visual audit

- `PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/library-ui-audit.json pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/library-ui-audit.spec.ts --project="iPhone SE (375x667)" --project="Desktop (1280x800)" --reporter=json` — 28/28 passed.
- Screenshots captured under `.codex/tmp/playwright-screenshots/` for normal, long-text, empty, many-items, filters-open, search, directory navigation, grid, and interactive-preview states on mobile/desktop.

### Staging

- Deploy workflow: https://github.com/raphaeltm/simple-agent-manager/actions/runs/30992343962 — deploy, data integrity, health check, and smoke tests passed (`12 passed`).
- Existing authenticated staging library spec: `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/staging-library-search.spec.ts --project="Desktop (1280x800)" --reporter=line` — 2/2 passed.
- Focused staging cache-isolation verifier against `https://app.sammy.party`: seeded legacy and foreign-user localStorage library metadata for project `01KJVGMWX26SGQ5DX94GMTJRQN`; verified fake metadata did not render while real library loaded; cleared cookies and verified seeded legacy/foreign/current metadata did not render in null-auth state. Output: `{ legacyBlocked: true, foreignBlocked: true, nullAuthNoMetadata: true }`.

### Local specialist review outcomes

- `ui-ux-specialist`: PASS. Scope is state/cache behavior in existing ProjectLibrary UI, with no intentional visual redesign. Visual audit rerun in recovery after installing Playwright Chromium and dependencies: 28/28 passed across mobile and desktop projects, covering normal, long text, empty, many items, filters, directory navigation, grid view, and interactive preview confirmation states. Screenshots were regenerated under `.codex/tmp/playwright-screenshots/`.
- `security-auditor`: PASS. Reviewed the frontend auth-transition/localStorage cache path for cross-user data exposure. Namespaced cache keys include encoded authenticated user id; authenticated/null-auth renders do not read legacy project-only keys; AuthProvider clears previous-user and legacy namespaces on clean null session/account switch; sign-out clears cache before the request completes, including failed request paths. No high/critical findings remain in the frontend cache isolation path.
- `test-engineer`: PASS. Focused regression suite rerun successfully: 69/69 tests passed across library cache namespace isolation, legacy refusal/clearing, AuthProvider transient refetch vs clean null/account switch transitions, sign-out failure cleanup, ProjectLibrary null-auth safety, and account-switch remount behavior.
- `task-completion-validator`: PASS. Research findings map to checked checklist items and the diff touches each planned file. Acceptance criteria are covered by focused unit/component tests, staging evidence, and visual audit evidence. No new UI input/backend propagation or multi-resource selector gap exists.
- `constitution-validator`: PASS. Diff adds deterministic localStorage namespace/key construction only. No new hardcoded URLs, timeouts, deployment identifiers, or operational limits; existing configurable cache TTL and eviction defaults remain unchanged.
- `doc-sync-validator`: PASS. Scope is apps/web-only internal cache behavior with no API, env var, deployment, public docs, or persisted payload contract change. The archived task and PR body carry the required operational evidence; no public documentation update is required.
