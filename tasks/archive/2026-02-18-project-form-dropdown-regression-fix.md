# Project Form Dropdown Regression Fix

**Created**: 2026-02-18
**Status**: completed

## Problem

PR #110 introduced a regression where project navigation/routes no longer behaved as before (projects path resolving to workspace-oriented screens). The intended change was narrower: keep existing Projects behavior and only improve project creation repository/default-branch inputs to match workspace creation dropdown behavior.

## Scope

1. Restore project route behavior to pre-#110 behavior.
2. Update project creation form (`ProjectForm`) so repository uses searchable dropdown behavior and default branch is populated from GitHub branches API.
3. Keep top-level navbar links intact.

## Preflight Classification

- `ui-change`
- `cross-component-change`
- `business-logic-change`
- `docs-sync-change`

## Implementation Plan

1. Revert unintended route wiring introduced in `App.tsx` for `/projects` and `/projects/new`.
2. Replace project form repository plain input with `RepoSelector`.
3. Add branch-fetch behavior mirroring workspace creation:
   - select repo -> fetch branches via `listBranches`
   - use default branch from selected repo
   - fallback branch options/messages on API failure
4. Normalize repository value before submit (`owner/repo` expected by API).
5. Add/update unit tests for projects creation flow and branch dropdown behavior.

## Validation Checklist

- [x] `/projects` shows projects page (not dashboard/workspace screen)
- [x] Project creation repository field is searchable dropdown-like selector
- [x] Branch options are fetched/populated from API after repo selection
- [x] Project create submit payload uses normalized repository and selected branch
- [x] Relevant web tests pass

## Completion Notes

- Restored project routes to pre-#110 behavior by removing unintended `/projects` -> dashboard and `/projects/new` -> workspace-create mappings.
- Kept top-level navbar links from `UserMenu` intact.
- Updated `ProjectForm` create mode to use `RepoSelector` and branch fetching via `listBranches`, with the same fallback behavior used in workspace creation.
- Added route regression coverage and project creation form coverage in unit tests.
