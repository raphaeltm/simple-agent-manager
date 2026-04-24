# Fix Library UX — Directory Layout & Search Debounce

## Problem

Two UX issues in the project library page (`apps/web/src/pages/ProjectLibrary.tsx`):

1. **Directories render as long rectangles on desktop.** In list view, directories are full-width rows. In grid view, they stretch with `1fr` columns. The user wants square cards with icons instead.

2. **Search is completely unusable.** Every keystroke in the search input immediately triggers `loadFiles()` via a `useEffect` dependency chain (`searchQuery` → `loadFiles` useCallback → useEffect). This causes:
   - Full data reload on every character typed
   - `setLoading(true)` replaces the entire content area with a spinner
   - No debounce — typing "hello" fires 5 API requests

## Research Findings

### Directory Layout (Issue 1)
- `ProjectLibrary.tsx:454-470` — List view directories: full-width flex rows (long rectangles)
- `ProjectLibrary.tsx:489-502` — Grid view directories: `min-h-[120px]` cards in `grid-cols-[repeat(auto-fill,minmax(200px,1fr))]` — can stretch very wide
- Fix: Always render directories as a compact grid of square cards with icons, regardless of file view mode. Separate the directory grid from the file listing.

### Search UX (Issue 2)
- `ProjectLibrary.tsx:52` — `searchQuery` state updated directly on every keystroke
- `ProjectLibrary.tsx:85-123` — `loadFiles` callback depends on `searchQuery`
- `ProjectLibrary.tsx:125-127` — `useEffect` calls `loadFiles()` whenever it changes
- `ProjectLibrary.tsx:88-91` — Loading state replaces content: `setLoading(true)` → spinner replaces everything
- Fix: (a) Debounce the search query with ~300ms delay. (b) Use background refresh for search (show spinner inline, preserve existing results). (c) Only use `setLoading(true)` for initial page load.

## Implementation Checklist

- [x] 1. Add a `useDebouncedValue` hook (or inline useRef/useEffect debounce pattern)
- [x] 2. Split search state into `searchInput` (raw) and `debouncedSearch` (delayed) — use debounced value in `loadFiles`
- [x] 3. Change `loadFiles` to use `setRefreshing(true)` for search/filter changes (preserves existing content), only `setLoading(true)` for initial mount
- [x] 4. Show a subtle search-in-progress indicator (small spinner near the search input) instead of replacing the entire content
- [x] 5. Always render directories as a compact grid of square cards with folder icons — separate from the file view mode (list vs grid)
- [x] 6. Ensure directory cards use `aspect-square` or fixed dimensions, centered icon and name
- [x] 7. Write Playwright visual audit tests with mock data covering normal, long-text, empty, many-items, and error scenarios
- [x] 8. Test on mobile (375px) and desktop (1280px) viewports
- [x] 9. Assert no horizontal overflow

## Acceptance Criteria

- [x] Typing in search does NOT trigger a request per keystroke — requests fire after user stops typing (~300ms)
- [x] Search results update without replacing existing content with a full-page spinner
- [x] A subtle inline indicator shows while search is in progress
- [x] Directories display as square cards with folder icons on desktop (both list and grid view modes)
- [x] Directory layout looks good on mobile too
- [x] No horizontal overflow on any viewport
- [x] Playwright screenshots captured for mobile and desktop
