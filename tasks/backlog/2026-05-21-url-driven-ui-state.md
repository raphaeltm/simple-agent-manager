# URL-Driven UI State for Linkable Project Resources

## Problem

Many project pages manage selection/navigation state via React `useState` instead of URL params, making them non-bookmarkable, non-shareable, and losing state on refresh. Modals for editing profiles, triggers, etc. open without URL changes — you can't link to "edit this profile" or share a deep-link to a specific library directory.

## Research Findings

### Current State: What IS URL-driven
- Chat sessions: `/projects/:id/chat/:sessionId` (good)
- Idea/task detail: `/projects/:id/ideas/:taskId` (good)
- Trigger history: `/projects/:id/triggers/:triggerId` (good)
- Node/workspace detail: `/nodes/:id`, `/workspaces/:id` (good)

### Current State: What is NOT URL-driven (needs fixing)
1. **Library directory navigation** — `currentDirectory` is a `useState('/')` in `ProjectLibrary.tsx:67`. Navigating into folders updates local state only. Refreshing or bookmarking loses the directory position.
2. **Library file preview modal** — `previewFile` is `useState<FileWithTags | null>(null)` in `ProjectLibrary.tsx:92`. No URL footprint.
3. **Knowledge entity selection** — `selectedEntityId` is `useState<string | null>(null)` in `KnowledgePage.tsx:72`. Desktop detail panel and mobile full-screen view are both state-driven.
4. **Agent profile edit modal** — `formOpen`/`editingProfile` are `useState` in `ProfileList.tsx:31-32`. Clicking Edit opens a `ProfileFormDialog` with no URL change.
5. **Trigger edit modal** — `formOpen`/`editTarget` are `useState` in `ProjectTriggers.tsx:32-33`. Clicking Edit opens `TriggerForm` with no URL change. Inconsistent with trigger history which IS URL-driven.

### Implementation Approach

Use `useSearchParams` to sync key UI state to query parameters. This is minimally invasive — no new routes needed, just query params that drive existing modal/selection state.

| Page | Query Param | What It Controls |
|------|------------|-----------------|
| Library | `?dir=/path/to/folder` | Current directory |
| Library | `?preview=fileId` | File preview modal |
| Knowledge | `?entity=entityId` | Selected entity (detail panel on desktop, full view on mobile) |
| Profiles | `?edit=profileId` or `?edit=new` | Profile form dialog open state |
| Triggers | `?edit=triggerId` or `?edit=new` | Trigger form dialog open state |

## Implementation Checklist

- [ ] **Library: URL-driven directory navigation**
  - Replace `useState` for `currentDirectory` with `useSearchParams` `dir` param
  - Default to `/` when no param present
  - Update `navigateToDirectory` to use `setSearchParams`
  - Update `DirectoryBreadcrumb` clicks to update URL
  - Ensure back button works (browser history)

- [ ] **Library: URL-driven file preview**
  - Add `preview` search param that holds a file ID
  - When `preview` param is present, find the file and open `FilePreviewModal`
  - When modal closes, remove `preview` param
  - When clicking a file to preview, set `preview` param

- [ ] **Knowledge: URL-driven entity selection**
  - Replace `useState` for `selectedEntityId` with `useSearchParams` `entity` param
  - Both desktop detail panel and mobile full-screen view driven by the param
  - Back button on mobile removes the param (returns to list)
  - Clicking an entity sets the param

- [ ] **Profiles: URL-driven edit modal**
  - Add `edit` search param: `edit=new` for create, `edit=<profileId>` for editing
  - `ProfileFormDialog` open state driven by presence of `edit` param
  - Closing the dialog removes `edit` param
  - Edit button on profile card sets `edit=<profileId>`

- [ ] **Triggers: URL-driven edit modal**
  - Add `edit` search param: `edit=new` for create, `edit=<triggerId>` for editing
  - `TriggerForm` open state driven by presence of `edit` param
  - Closing the form removes `edit` param
  - Edit button sets `edit=<triggerId>`

- [ ] **Tests for URL-driven state**
  - Add behavioral tests that verify URL params control modal/selection state
  - Verify setting params via URL opens the correct modal/view
  - Verify closing modal/deselecting removes the params

## Acceptance Criteria

- [ ] Navigating into a library folder updates the URL with `?dir=...`; refreshing preserves the directory
- [ ] Opening a file preview updates the URL with `?preview=...`; sharing the URL opens the preview
- [ ] Selecting a knowledge entity updates the URL with `?entity=...`; refreshing preserves the selection
- [ ] The "Edit" button on a profile updates the URL with `?edit=<id>`; sharing the URL opens the edit dialog
- [ ] The "Edit" button on a trigger updates the URL with `?edit=<id>`; sharing the URL opens the edit form
- [ ] The "New" button on profiles/triggers uses `?edit=new`
- [ ] Browser back button works correctly for all URL-driven state changes
- [ ] No regressions in existing functionality
