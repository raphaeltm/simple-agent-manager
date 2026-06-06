# Library search & navigation: client-side index + always-visible search + flicker-free results

**Idea:** 01KTEGHZ8DA0ATXQAZTXGCEK54 (the "CONSENSUS RESOLUTION" section of the idea is authoritative and supersedes any conflicting earlier detail).
**Scope:** Frontend-only (`apps/web/`, `packages/shared/` types). No API/Go changes.
**Branch:** sam/use-sam-mcp-tools-01kteg

## Problem Statement

The Project File Library (`apps/web/src/pages/ProjectLibrary.tsx`) has three UX problems identified in the parent review session:

- **A — No cross-directory search.** Search round-trips to the server per keystroke (debounced) and only the current page (50 files) is loaded; results are not ranked. For sub-cap projects (<300 files) the whole library could live client-side and be searched instantly with ranking.
- **B — Search is hidden.** The search box lives inside the `{showFilters && ...}` block (ProjectLibrary.tsx:419-495); users must click "Filters" before they can search.
- **D — Result-swap flicker.** Background refresh and search replace `files`/`directories` state wholesale, unmounting rows; first paint shows a full-page spinner (ProjectLibrary.tsx:314).

This task implements options A + B + D together as a frontend-only change.

## Research Findings (verified against current code)

### Frontend
- `ProjectLibrary.tsx` (629 lines — over Rule-18 500 soft limit; extraction required as Step 0):
  - `filterFilesBySearch`/`filterDirectoriesBySearch` (38-50) — naive substring filters; **dead after this change**.
  - `searchInput`/`debouncedSearch`/`isSearchPending` (80-87); `activeFilterCount` includes `searchInput` (102-103) — **must exclude**.
  - `isSearching = !!debouncedSearch` (106) drives recursive server search + dir search (158, 167-169) — **the gated fallback path**.
  - Dual-path `displayFiles`/`displayDirectories` memo (121-135) — **dead after client index**.
  - `loadFiles` (144-189): `recursive` (158), `limit: LIST_DEFAULT_PAGE_SIZE` (161), `sortOrder` (160); caches unfiltered results (177-180). Effect dep on `loadFiles` (191-193) re-runs on dir/search/sort change.
  - `navigateToDirectory` already uses functional `setSearchParams((prev)=>...)` (199-209) — keep this pattern everywhere.
  - Full-page Spinner on `loading` (314-320).
  - Header is `flex flex-wrap` (327); search currently inside `{showFilters}` (419-495).
- `lib/library-cache.ts`: `buildKey` includes directory+sortBy; `writeCache` **silently swallows QuotaExceededError** (31-37) → must not cause infinite re-sweep; `clearLibraryCache` (71-82). EXTEND, do not fork.
- `lib/api/library.ts`: `listLibraryFiles` returns `{ files: (ProjectFile & {tags})[], cursor, total }`; `moveFile` returns ProjectFile **without tags**.
- `hooks/useDebouncedValue.ts` (300ms) — reuse for URL reflection only.

### API (read-only context — NOT modified)
- `file-library.ts` `listFiles` (326-482): cursor is `id > cursor` **ascending ULID** (375); `sortOrder` defaults `'desc'` (384) — **sweep MUST pass `sortOrder:'asc'`** or files sharing a `createdAt` ms get dropped/duped. Returns `{files, cursor, total}`. Search uses `like(filename, %x%)` with `.replace(/[%_]/,'\\$&')` (367) but **no ESCAPE clause** → LIKE-escape bug (backlog 2026-04-24, OUT OF SCOPE here).
- `file-library-directories.ts` `listDirectories` silently truncates at maxDirs+1 (147), no `hasMore`; `fileCount` is a server-derived aggregate.
- `file-library-config.ts`: 500 files/project, 500 dirs, 50 default page, 200 max page (all env-overridable).

## Implementation Checklist

### Step 0 — Rule-18 extraction (PREREQUISITE, separate commit) — COMMITTED ca493c38
- [x] Create `apps/web/src/lib/library-search.ts`: pure `matchFile`/ranked matcher + pure `buildIndex` (no I/O, no React). Ranking: exact > prefix > word-boundary > substring > subsequence; tie-break match position then length; match over filename + description + directory path + tag names.
- [x] Create `apps/web/src/hooks/useLibraryIndex.ts`: acquisition only — sweep + refresh + invalidation (sweep-generation counter). No matching logic here.
- [x] EXTEND `apps/web/src/lib/library-cache.ts` with global-index key `sam-library:<projectId>:global-index` (count/updatedAt/TTL), distinct from per-directory keys; extend `clearLibraryCache`; add size-estimate guard + LRU evict of oldest `sam-library:*` key (do NOT swallow QuotaExceededError into infinite re-sweep).

### Step 1 — shared types — COMMITTED ca493c38
- [x] Add `LIBRARY_CLIENT_SWEEP_CAP` (default **300**, `VITE_LIBRARY_CLIENT_SWEEP_CAP` override) to `packages/shared/src/types/library.ts`.

### Step 2 — sweep + index acquisition (useLibraryIndex) — COMMITTED ca493c38
- [x] Sweep passes `sortOrder:'asc'`, loops until `cursor === null` (NOT `>= total`, NOT fixed count), `MAX_SWEEP_PAGES` (~10) safety guard.
- [x] Strip `extractedTextPreview` from each record before caching.
- [x] Accumulate sweep pages into a ref; commit to state ONCE on `cursor===null` (flicker-free). First load with no cache: show page 1 immediately, accumulate rest, full-page spinner only for page 1.
- [x] Sweep `useEffect` deps = `[projectId, invalidationToken]` ONLY.
- [x] If file count ≥ cap → fall back to existing server-search path (gated, not deleted).
- [x] Mid-sweep failure → set `sweepError`, render non-blocking banner ("Some files may be missing — refresh to retry").
- [x] Generation guard: discard sweep result if `gen !== currentGen`. Bump generation on every mutation. **Trailing re-sweep** on move/delete drives the post-mutation state (dir fileCount is server aggregate; move returns no tags), so no optimistic in-place patch is needed — `invalidate()` re-sweeps and the deleted/moved row drops out of the fresh result.

### Step 3 — ProjectLibrary integration — COMMITTED ec65577b
- [x] `searchInput` stays LOCAL state; filtering against the index is instant (no debounce on match). URL is WRITE-ONLY reflection on debounce; never read back into the input value.
- [x] All `setSearchParams` use functional `(prev)=>` form.
- [x] Directory nav must NOT re-sweep.
- [x] Always-visible search in a dedicated full-width row BETWEEN header bar and breadcrumb (sticky on mobile, non-sticky desktop). Advanced filters (tags/source) stay behind the Filters toggle. Exactly ONE search input.
- [x] Exclude `searchInput` from `activeFilterCount`.
- [x] Do NOT change sort-control placement (already correct `!isMobile`/`isMobile`).
- [x] Delete dead code: `filterFilesBySearch`/`filterDirectoriesBySearch`, dual-path `displayFiles`/`displayDirectories` memo for sub-cap path, `isSearching`/`recursive` branch only where superseded (keep gated fallback).

### Step 4 — a11y — COMMITTED ec65577b
- [x] Search input `id="library-search"` + `aria-label="Search files and folders"`.
- [x] Result-count `<p>` gets `aria-live="polite" aria-atomic="true"` (+ no-matches message).
- [x] Focus to heading/breadcrumb after directory nav.
- [x] Tag/source chips `aria-pressed`.

### Step 5 — tests — COMMITTED c04349c8
- [x] Unit `library-search.test.ts`: ranking order, tie-breaks, unicode/emoji, match over all fields. (16 tests)
- [x] Unit `useLibraryIndex.test.ts`: multi-page sweep (asc, cursor===null termination), extractedTextPreview strip, cache read/write, cap fallback, generation guard discards stale result. (6 tests)
- [x] Vertical slice (`project-library.test.tsx`): multi-directory dataset, asserts SINGLE sweep, cross-directory search results, NO re-sweep on directory nav, realistic mocks (no empty-object mocks). (18 tests)
- [x] 4 regression tests: (1) search visible without clicking Filters; (2) rows stay mounted + no full-page spinner during background sweep; (3) directory with >50 files shows all (not just first page); (4) mutation during refresh does not resurrect a deleted file.
- [x] Playwright `library-ui-audit.spec.ts` at 375px / 390px / 1280px: mobile grid, long filenames (incl. long tag names), many items (25 files + 8 dirs), empty state, filter panel open; assert no horizontal overflow. (11 tests × 3 viewports = 33 pass). Note: dedicated emoji/special-char filename scenario NOT included — real filenames are constrained by `LIBRARY_FILENAME_PATTERN`; unicode coverage lives in the `library-search.test.ts` matcher unit tests instead.

## Acceptance Criteria
- [x] For sub-cap (<300 files) projects, search is instant and ranked, spans all directories, with zero per-keystroke server round-trips.
- [x] Search box is always visible (no Filters click required) in its own full-width row.
- [x] No full-page spinner on background refresh; rows stay mounted (no flicker).
- [x] Directory navigation does not trigger a re-sweep.
- [x] At/over cap, the gated server-search fallback engages with no regression.
- [x] Move/delete mutations do not resurrect stale rows; directory fileCounts re-sync via trailing re-sweep.
- [x] localStorage never throws an unhandled quota error or loops re-sweeping.
- [x] Full a11y: aria-label, aria-live count, focus mgmt, aria-pressed chips.
- [x] All tests in the matrix pass; Playwright shows no overflow at 375/1280.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green; staging-verified (pending Phase 6).

## References
- Idea 01KTEGHZ8DA0ATXQAZTXGCEK54 (CONSENSUS RESOLUTION authoritative)
- Rules: 06 (API/React patterns), 10 (e2e), 16 (no reload on mutation), 17 (UI visual testing), 18 (file size), 24 (no duplicate controls), 35 (vertical slice)
- Out of scope: LIKE-escape (backlog 2026-04-24), chat-first integration (Rule 26 follow-up), virtualization
