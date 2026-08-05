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

- [ ] Add a deterministic authenticated cache namespace derived from the active user/session.
- [ ] Update library cache APIs to read/write namespaced keys while keeping cache payload formats unchanged.
- [ ] Handle legacy project-only cache safely by refusing authenticated hydration from legacy keys and removing unsafe legacy keys on transitions.
- [ ] Add AuthProvider-level cleanup for null/user and account switch transitions.
- [ ] Make logout clear namespaced cache deterministically before redirect, regardless of request success.
- [ ] Update ProjectLibrary and `useLibraryIndex` to pass the namespace and reset render state when namespace changes.
- [ ] Add scenario-driven unit/component tests covering cache isolation, AuthProvider transitions, ProjectLibrary cached render safety, logout, expiry, and account switch.
- [ ] Run ProjectLibrary visual audit with normal, long text, empty, many, and error states on mobile and desktop.
- [ ] Run specialist review and address findings.
- [ ] Run local quality suite, staging verification, and PR/CI.

## Acceptance criteria

- Previous-user file metadata is never rendered from `localStorage` after logout, session expiry, or account switch, including when project IDs collide.
- Same-user cache hydration still works and stale-while-revalidate UX is preserved.
- Legacy un-namespaced cache cannot leak metadata into authenticated ProjectLibrary renders.
- Logout/session expiry/account switch clear unsafe library cache deterministically.
- Tests fail against the old project-only cache behavior and pass with the fix.
- PR is open, CI green, and unmerged.
