# Branch Search Typeahead

**Created**: 2026-02-25
**Branch**: `fix/branch-search-typeahead`
**Priority**: High
**Affects**: `apps/api/`, `apps/web/`

## Problem

When creating a workspace or project for a repository with many branches, users cannot find the branch they need. Two compounding issues:

1. **API only fetches the first page of branches** — `getRepositoryBranches()` in `apps/api/src/services/github-app.ts:247-275` calls the GitHub API with `per_page=100` but never paginates. Repos with >100 branches silently lose the rest. The `main` branch may not appear if it falls outside the first page (GitHub returns branches in alphabetical order by default, so `main` appears after any branches starting with a-l).

2. **UI uses a plain `<select>` dropdown with no search** — Both `CreateWorkspace.tsx:405-415` and `ProjectForm.tsx:253-265` render a native `<select>` element. With 100 branches in a dropdown, finding a specific branch requires scrolling. There is no typeahead, filter, or search capability. The `RepoSelector` component already implements a searchable typeahead pattern that could be adapted.

### Root Cause

`getRepositoryBranches()` was added without pagination, even though the sibling function `getInstallationRepositories()` (same file, lines 176-236) correctly paginates through all pages. The UI was never upgraded from a basic `<select>` to a searchable input.

### Impact

- Users with repos that have many branches (common in active projects) cannot select their target branch
- The `main` branch — the most commonly needed branch — can be missing from the list entirely
- Workaround: users must manually type the branch name only if the API call fails and the fallback text input appears

## Proposed Solutions

### Backend: Paginated Branch Fetching

Update `getRepositoryBranches()` to paginate through all GitHub API pages, matching the pattern already used in `getInstallationRepositories()`:

- Loop through pages using `?per_page=100&page=N` until a page returns fewer than `per_page` results
- Add a safety cap (e.g., 1000 branches max) to prevent runaway pagination
- Make the cap configurable via environment variable (constitution Principle XI)
- Prioritize the default branch: fetch repo metadata to identify the default branch and ensure it's always included in results, regardless of alphabetical position

**Key file**: `apps/api/src/services/github-app.ts` — `getRepositoryBranches()`

### Frontend: Searchable Branch Selector Component

Replace the native `<select>` with a searchable typeahead component, following the existing `RepoSelector` pattern:

- Text input with dropdown overlay showing filtered branch results
- Client-side filtering as the user types
- Show the default/current branch prominently (pinned to top or marked)
- Handle loading, error, and empty states
- Support keyboard navigation (arrow keys, enter to select, escape to close)
- Click-outside to dismiss dropdown
- Fallback to plain text input if branch fetching fails entirely

**Key files**:
- New: `apps/web/src/components/BranchSelector.tsx`
- Update: `apps/web/src/pages/CreateWorkspace.tsx` — replace `<Select>` with `<BranchSelector>`
- Update: `apps/web/src/components/project/ProjectForm.tsx` — replace `<select>` with `<BranchSelector>`

### Alternative Considered: Server-Side Search

Adding a `?query=` parameter to the branches API and having the server filter via the GitHub API's branch search. Rejected because:
- GitHub's List Branches endpoint doesn't support search/filter natively — would require fetching all then filtering server-side anyway
- Client-side filtering of a pre-fetched list is simpler, faster, and avoids extra API round-trips
- The full branch list is small enough to transfer and filter in-browser (even 1000 branches is <50KB)

## Implementation Checklist

### Backend

- [ ] Add pagination to `getRepositoryBranches()` in `apps/api/src/services/github-app.ts`
  - [ ] Loop through pages until `results.length < perPage`
  - [ ] Add configurable max branch limit (env var `MAX_BRANCHES_PER_REPO`, default 1000)
  - [ ] Add the max branch limit to the `Env` interface in `apps/api/src/env.ts`
  - [ ] Document the new env var in `apps/api/.env.example`
- [ ] Ensure default branch is always present in results
  - [ ] Accept an optional `defaultBranch` query parameter on the API route
  - [ ] If the default branch isn't in the paginated results, prepend it
- [ ] Add unit tests for `getRepositoryBranches()` pagination
  - [ ] Test single-page response (< 100 branches)
  - [ ] Test multi-page response (> 100 branches)
  - [ ] Test default branch inclusion when not in first page
  - [ ] Test max branch limit cap
  - [ ] Test error handling (GitHub API failure, rate limiting)
- [ ] Add integration test for `GET /api/github/branches` route with pagination

### Frontend — BranchSelector Component

- [ ] Create `apps/web/src/components/BranchSelector.tsx`
  - [ ] Text input with typeahead filtering
  - [ ] Dropdown overlay showing filtered branch list (max height with scroll)
  - [ ] Pin default branch to top of list with visual indicator
  - [ ] Loading spinner while branches are being fetched
  - [ ] Empty state when no branches match the filter
  - [ ] Error state with fallback to plain text input
  - [ ] Click-outside to dismiss dropdown
  - [ ] Keyboard navigation: arrow up/down, enter to select, escape to close
  - [ ] Style consistently with `RepoSelector` and design system (`@simple-agent-manager/ui`)
- [ ] Replace branch `<Select>` in `CreateWorkspace.tsx:405-415` with `<BranchSelector>`
- [ ] Replace branch `<select>` in `ProjectForm.tsx:253-265` with `<BranchSelector>`
- [ ] Verify the `isProjectLinked` text input path in `CreateWorkspace.tsx` still works correctly
- [ ] Add unit tests for `BranchSelector`
  - [ ] Renders branch list from props
  - [ ] Filters branches as user types
  - [ ] Default branch pinned to top
  - [ ] Calls onChange with selected branch
  - [ ] Keyboard navigation works
  - [ ] Falls back to text input on error
  - [ ] Click-outside dismisses dropdown

### Quality Gates

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (all new and existing tests)
- [ ] Manual verification: test with a repo that has >100 branches
- [ ] Constitution check: no hardcoded limits (MAX_BRANCHES_PER_REPO is configurable)
- [ ] Documentation: update env var reference if new env vars added

## Reference Code

- **Pagination pattern**: `getInstallationRepositories()` at `apps/api/src/services/github-app.ts:176-236`
- **Typeahead pattern**: `RepoSelector` at `apps/web/src/components/RepoSelector.tsx`
- **Branch API route**: `apps/api/src/routes/github.ts:96-140`
- **GitHub Branches API**: `GET /repos/{owner}/{repo}/branches` — returns alphabetically, supports `per_page` and `page` params
