# Branch Search Typeahead

**Created**: 2026-02-25
**Branch**: `fix/branch-search-typeahead`
**Priority**: High
**Affects**: `apps/api/`, `apps/web/`, `packages/vm-agent/`

## Problem

When interacting with branches anywhere in SAM — creating workspaces, creating projects, or creating worktrees — users cannot find the branch they need if the repository has many branches. Multiple compounding issues:

1. **API only fetches the first page of branches** — `getRepositoryBranches()` in `apps/api/src/services/github-app.ts:247-275` calls the GitHub API with `per_page=100` but never paginates. Repos with >100 branches silently lose the rest. The `main` branch may not appear if it falls outside the first page (GitHub returns branches alphabetically, so `main` appears after any branches starting with a-l).

2. **UI uses plain `<select>` dropdowns with no search** — Both `CreateWorkspace.tsx:405-415` and `ProjectForm.tsx:253-265` render a native `<select>` element. With 100 branches in a dropdown, finding a specific branch requires scrolling. No typeahead, filter, or search capability.

3. **WorktreeSelector has a blind text input** — `WorktreeSelector.tsx:263-275` uses a plain text `<input>` for the branch name when creating a new worktree. Users must know the exact branch name — there is no autocomplete, no branch list, and no validation against available branches before submission. The VM agent has no endpoint to list remote branches (`GET /workspaces/{id}/worktrees` only lists existing worktrees, not available remote branches).

### Root Cause

`getRepositoryBranches()` was added without pagination, even though the sibling function `getInstallationRepositories()` (same file, lines 176-236) correctly paginates through all pages. The UI was never upgraded from a basic `<select>` to a searchable input. The worktree creation flow was built without branch discovery at all.

### Impact

- Users with repos that have many branches (common in active projects) cannot select their target branch
- The `main` branch — the most commonly needed branch — can be missing from the list entirely
- Creating worktrees requires knowing the exact branch name with no assistance
- Workaround: users must manually type the branch name only if the API call fails and the fallback text input appears

## Audit: All Branch Interaction Points

Every location in the codebase where branches are loaded, displayed, or selected:

| # | Location | File | What It Does | Current UX | Needs Fix? |
|---|----------|------|-------------|-----------|-----------|
| 1 | `getRepositoryBranches()` | `apps/api/src/services/github-app.ts:247-275` | Fetches branches from GitHub API | Backend — `per_page=100`, no pagination | **YES — add pagination** |
| 2 | `GET /api/github/branches` | `apps/api/src/routes/github.ts:96-140` | API route that calls the service above | Backend — passes through to service | **YES — accept `defaultBranch` param** |
| 3 | `listBranches()` | `apps/web/src/lib/api.ts:155-163` | Client-side API wrapper | Frontend — returns `Array<{ name }>` | **YES — pass defaultBranch** |
| 4 | CreateWorkspace branch picker | `apps/web/src/pages/CreateWorkspace.tsx:405-415` | Branch selection when creating workspace | Plain `<select>` dropdown | **YES — replace with BranchSelector** |
| 5 | ProjectForm branch picker | `apps/web/src/components/project/ProjectForm.tsx:253-265` | Default branch selection when creating/editing project | Plain `<select>` dropdown | **YES — replace with BranchSelector** |
| 6 | WorktreeSelector create form | `apps/web/src/components/WorktreeSelector.tsx:263-275` | Branch name input when creating new worktree | Plain text `<input>`, no autocomplete | **YES — add branch autocomplete** |
| 7 | VM agent worktree handler | `packages/vm-agent/internal/server/worktrees.go:220-327` | Creates worktree on VM | Backend — validates branch name, no list endpoint | **YES — add branch list endpoint** |
| 8 | Task runner `outputBranch` | `apps/api/src/services/task-runner.ts:384-389` | Auto-assigns `task/{id}` branch name | Automated, no user interaction | No |

## Proposed Solutions

### Backend: Paginated Branch Fetching (GitHub API)

Update `getRepositoryBranches()` to paginate through all GitHub API pages, matching the pattern already used in `getInstallationRepositories()`:

- Loop through pages using `?per_page=100&page=N` until a page returns fewer than `per_page` results
- Add a safety cap (e.g., 1000 branches max) to prevent runaway pagination
- Make the cap configurable via environment variable (constitution Principle XI)
- Prioritize the default branch: accept an optional `defaultBranch` parameter and ensure it's always first in results

**Key file**: `apps/api/src/services/github-app.ts` — `getRepositoryBranches()`

### Backend: VM Agent Branch List Endpoint

Add a new `GET /workspaces/{workspaceId}/git/branches` endpoint to the VM agent that lists remote branches available in the cloned repo:

- Run `git branch -r --format='%(refname:short)'` inside the workspace container
- Strip the `origin/` prefix
- Return as `Array<{ name: string }>`
- This enables the WorktreeSelector to offer autocomplete from the actual repo state on the VM

**Key file**: `packages/vm-agent/internal/server/worktrees.go` (or new `git.go` handler)

### Frontend: Searchable BranchSelector Component

Create a reusable `BranchSelector` component following the existing `RepoSelector` pattern:

- Text input with dropdown overlay showing filtered branch results
- Client-side filtering as the user types
- Show the default/current branch prominently (pinned to top or marked)
- Handle loading, error, and empty states
- Support keyboard navigation (arrow keys, enter to select, escape to close)
- Click-outside to dismiss dropdown
- Fallback to plain text input if branch fetching fails entirely

This component replaces the `<select>` in CreateWorkspace and ProjectForm.

**Key files**:
- New: `apps/web/src/components/BranchSelector.tsx`
- Update: `apps/web/src/pages/CreateWorkspace.tsx` — replace `<Select>` with `<BranchSelector>`
- Update: `apps/web/src/components/project/ProjectForm.tsx` — replace `<select>` with `<BranchSelector>`

### Frontend: WorktreeSelector Branch Autocomplete

Enhance the WorktreeSelector's "create worktree" form to offer branch autocomplete:

- When "Create new branch" is unchecked (i.e., checking out an existing branch), fetch the branch list from the new VM agent endpoint and show a searchable dropdown
- When "Create new branch" is checked, allow freeform text input (new branch names won't be in any list)
- Reuse the same `BranchSelector` component or a lightweight variant that accepts a branch list as props

**Key file**: `apps/web/src/components/WorktreeSelector.tsx`

### Alternative Considered: Server-Side Search

Adding a `?query=` parameter to the branches API and having the server filter via the GitHub API. Rejected because:
- GitHub's List Branches endpoint doesn't support search/filter natively — would require fetching all then filtering server-side anyway
- Client-side filtering of a pre-fetched list is simpler, faster, and avoids extra API round-trips
- The full branch list is small enough to transfer and filter in-browser (even 1000 branches is <50KB)

## Implementation Checklist

### Phase 1: Backend — GitHub API Pagination

- [ ] Add pagination to `getRepositoryBranches()` in `apps/api/src/services/github-app.ts`
  - [ ] Loop through pages until `results.length < perPage`
  - [ ] Add configurable max branch limit (env var `MAX_BRANCHES_PER_REPO`, default 1000)
  - [ ] Add the max branch limit to the `Env` interface in `apps/api/src/env.ts`
  - [ ] Document the new env var in `apps/api/.env.example`
- [ ] Ensure default branch is always present in results
  - [ ] Accept an optional `defaultBranch` query parameter on the API route (`apps/api/src/routes/github.ts`)
  - [ ] If the default branch isn't in the paginated results, prepend it
  - [ ] Update `listBranches()` in `apps/web/src/lib/api.ts` to pass `defaultBranch`
- [ ] Add unit tests for `getRepositoryBranches()` pagination
  - [ ] Test single-page response (< 100 branches)
  - [ ] Test multi-page response (> 100 branches)
  - [ ] Test default branch inclusion when not in first page
  - [ ] Test max branch limit cap
  - [ ] Test error handling (GitHub API failure, rate limiting)
- [ ] Add integration test for `GET /api/github/branches` route with pagination

### Phase 2: Frontend — BranchSelector Component

- [ ] Create `apps/web/src/components/BranchSelector.tsx`
  - [ ] Text input with typeahead filtering
  - [ ] Dropdown overlay showing filtered branch list (max height with scroll)
  - [ ] Pin default branch to top of list with visual indicator (e.g., "default" badge)
  - [ ] Loading spinner while branches are being fetched
  - [ ] Empty state when no branches match the filter
  - [ ] Error state with fallback to plain text input
  - [ ] Click-outside to dismiss dropdown
  - [ ] Keyboard navigation: arrow up/down, enter to select, escape to close
  - [ ] Style consistently with `RepoSelector` and design system (`@simple-agent-manager/ui`)
- [ ] Replace branch `<Select>` in `CreateWorkspace.tsx:405-415` with `<BranchSelector>`
  - [ ] Pass default branch from project/repo metadata
  - [ ] Verify the `isProjectLinked` text input path still works
- [ ] Replace branch `<select>` in `ProjectForm.tsx:253-265` with `<BranchSelector>`
  - [ ] Pass default branch from repo metadata
  - [ ] Verify edit mode fallback to text input still works
- [ ] Add unit tests for `BranchSelector`
  - [ ] Renders branch list from props
  - [ ] Filters branches as user types (case-insensitive)
  - [ ] Default branch pinned to top
  - [ ] Calls onChange with selected branch value
  - [ ] Keyboard navigation works (up/down/enter/escape)
  - [ ] Falls back to text input on error
  - [ ] Click-outside dismisses dropdown
  - [ ] Loading state shows spinner

### Phase 3: VM Agent — Branch List Endpoint

- [ ] Add `GET /workspaces/{workspaceId}/git/branches` handler in `packages/vm-agent/internal/server/`
  - [ ] Run `git branch -r --format='%(refname:short)'` inside workspace container
  - [ ] Strip `origin/` prefix from branch names
  - [ ] Deduplicate and sort results
  - [ ] Return `Array<{ name: string }>` JSON response
  - [ ] Handle errors (no git repo, container not running, etc.)
- [ ] Register the route in `server.go` under the git section (near line 473)
- [ ] Add tests for the new endpoint in `worktrees_test.go` or new `git_branches_test.go`
  - [ ] Test successful branch listing
  - [ ] Test error when no git repo exists
  - [ ] Test with workspace that has many remote branches

### Phase 4: WorktreeSelector — Branch Autocomplete

- [ ] Add branch list fetching to `WorktreeSelector.tsx` (or its parent)
  - [ ] Call the new VM agent `git/branches` endpoint when the create form opens
  - [ ] Pass branch list to the input component
- [ ] Replace plain `<input>` with `BranchSelector` (or lightweight variant) when "Create new branch" is unchecked
  - [ ] When unchecked: show searchable dropdown of existing remote branches
  - [ ] When checked: show plain text input for new branch name (freeform)
- [ ] Add tests for WorktreeSelector branch autocomplete
  - [ ] Autocomplete shown when creating worktree from existing branch
  - [ ] Autocomplete hidden when creating new branch
  - [ ] Filters branches as user types
  - [ ] Handles empty branch list gracefully

### Quality Gates

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (all new and existing tests)
- [ ] `go test ./...` passes in `packages/vm-agent/`
- [ ] Manual verification: test with a repo that has >100 branches
- [ ] Manual verification: test worktree creation with branch autocomplete
- [ ] Constitution check: no hardcoded limits (`MAX_BRANCHES_PER_REPO` is configurable)
- [ ] Documentation: update env var reference if new env vars added

## Reference Code

- **Pagination pattern**: `getInstallationRepositories()` at `apps/api/src/services/github-app.ts:176-236`
- **Typeahead pattern**: `RepoSelector` at `apps/web/src/components/RepoSelector.tsx`
- **Branch API route**: `apps/api/src/routes/github.ts:96-140`
- **WorktreeSelector**: `apps/web/src/components/WorktreeSelector.tsx`
- **VM agent routes**: `packages/vm-agent/internal/server/server.go:473-475` (git section)
- **VM agent worktree handler**: `packages/vm-agent/internal/server/worktrees.go`
- **GitHub Branches API**: `GET /repos/{owner}/{repo}/branches` — returns alphabetically, supports `per_page` and `page` params
