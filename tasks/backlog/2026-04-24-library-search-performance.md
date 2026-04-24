# Library Search Performance & UX Improvements

**Created**: 2026-04-24
**Status**: Backlog

## Problem Statement

User testing on staging identified several library UX issues:

1. **Search feels slow** — every search triggers an API call (after 300ms debounce). With many files/directories, this creates noticeable latency with no instant feedback.
2. **Loading spinner is invisible** — the refreshing spinner is at the bottom of the file list, so when there are many files the user can't see it.
3. **Search doesn't match directories** — typing a directory name doesn't filter/show matching directories. Server-side search only queries `projectFiles.filename` via LIKE.
4. **No caching** — navigating away and back reloads everything from scratch.

## Research Findings

### Current Implementation (ProjectLibrary.tsx)
- `searchInput` → debounced at 300ms → `debouncedSearch` → triggers `loadFiles()` via useEffect
- `loadFiles()` calls `listLibraryFiles()` (files) + `listLibraryDirectories()` (directories) in parallel
- When searching (`debouncedSearch` is truthy), directories are NOT fetched at all (returns empty array)
- Refreshing spinner is at line 522-533, BELOW the file list
- Inline search spinner exists in the search input field (only visible when filter panel is open)

### Server-Side Search (file-library.ts:365-368)
- Uses `LIKE %search%` on `projectFiles.filename` column only
- Does NOT search directory names
- Directories are a separate endpoint that doesn't have a search parameter

### Auth/Logout (auth.ts:29-37)
- `signOut()` calls `authClient.signOut()` which redirects to `/`
- Good hook point: add `localStorage.removeItem()` in the `onSuccess` callback before redirect

### Key Files
- `apps/web/src/pages/ProjectLibrary.tsx` — main component
- `apps/web/src/hooks/useDebouncedValue.ts` — debounce hook
- `apps/web/src/lib/api/library.ts` — API client functions
- `apps/web/src/lib/auth.ts` — signOut function
- `apps/api/src/services/file-library.ts` — server-side listFiles (search = filename LIKE)
- `apps/api/src/services/file-library-directories.ts` — server-side listDirectories (no search)

## Implementation Checklist

### Client-Side Filtering for Instant Feedback
- [ ] Add client-side filtering that instantly filters already-loaded files/directories by search input (before debounced API call fires)
- [ ] Show client-filtered results immediately while API search runs in background
- [ ] When API results arrive, replace client-filtered results with full server results
- [ ] Ensure smooth transition between client-filtered and API results (no flash/jump)

### Move Loading Spinner to Top
- [ ] Move the refreshing spinner + file count indicator from bottom to top of the file/directory list
- [ ] Keep it visible regardless of how many files are displayed
- [ ] Show a distinct "Searching..." indicator when search is in-flight vs general refresh

### Directory Search Support
- [ ] Client-side: filter displayed directories by search input (match directory name against search)
- [ ] Server-side: add `search` parameter to `listDirectories` query in `file-library-directories.ts` to match directory names
- [ ] Update `listLibraryDirectories` API to accept and forward search parameter
- [ ] When searching, show matching directories alongside matching files (don't skip directory fetch)

### localStorage Cache
- [ ] Cache file list responses in localStorage keyed by `projectId + directory + sort`
- [ ] On mount, load cached data first (instant render), then fetch fresh data in background
- [ ] Cache directory listings similarly
- [ ] Clear all library cache entries on signOut (in auth.ts onSuccess callback)
- [ ] Set a reasonable cache TTL (e.g., 5 minutes) — don't serve arbitrarily stale data
- [ ] No sensitive file content in cache — only metadata (filenames, sizes, tags, directory structure)

### Test Data on Staging
- [ ] Upload 20+ files across multiple directories on staging
- [ ] Create 5+ nested directories
- [ ] Verify search performance with realistic data volumes

### Tests
- [ ] Unit test: client-side filtering logic (filters files AND directories by search)
- [ ] Unit test: localStorage cache read/write/clear behavior
- [ ] Unit test: cache cleared on signOut
- [ ] Update Playwright visual audit for new spinner placement
- [ ] Test with empty cache, stale cache, and fresh cache scenarios

## Acceptance Criteria

- [ ] Typing in search shows instant filtered results from already-loaded data
- [ ] API search results replace client-filtered results when they arrive
- [ ] Refreshing spinner is visible at the top of the list, not hidden below files
- [ ] Searching for a directory name shows that directory in results
- [ ] Navigating away and back shows cached data instantly, then refreshes
- [ ] Logging out clears all library cache from localStorage
- [ ] No sensitive data (file contents, encryption keys) stored in localStorage
- [ ] Performance feels responsive with 20+ files and 5+ directories
