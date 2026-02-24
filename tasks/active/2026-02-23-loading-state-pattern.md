# Fix Loading State Pattern — Never Hide Loaded Data

**Created**: 2026-02-23
**Priority**: High
**Classification**: `ui-change`, `cross-component-change`

## Context

Multiple components across the SAM web app use the anti-pattern of replacing already-loaded content with spinners/skeletons during data refresh. This causes data to disappear for a fraction of a second while being re-fetched, which is extremely jarring. The user has requested this become a core UI principle: **if data is loaded, it should never be hidden for a loading state.**

## Anti-Pattern

```typescript
// BAD: Hides loaded data during refresh
if (loading) return <Spinner />;

// GOOD: Only show spinner on initial load when no data exists
if (loading && !data.length) return <Spinner />;
```

## Affected Files (8 components)

### 1. TaskList.tsx (lines 37-50)
**File**: `apps/web/src/components/project/TaskList.tsx`
- Shows spinner when `loading` is true, completely replacing task list
- Fix: `if (loading && !tasks.length)`

### 2. ProjectSessions.tsx (lines 30-35)
**File**: `apps/web/src/pages/ProjectSessions.tsx`
- Shows spinner unconditionally when loading
- Fix: `if (loading && !chatSessions.length)`

### 3. SettingsCloudProvider.tsx (lines 9-14)
**File**: `apps/web/src/pages/SettingsCloudProvider.tsx`
- Shows skeleton placeholder when loading
- Fix: `if (loading && !credentials.length)` or check for existing form data

### 4. GitHubAppSection.tsx (lines 81-86)
**File**: `apps/web/src/components/GitHubAppSection.tsx`
- Shows spinner when loading
- Fix: `if (loading && !installations.length)`

### 5. AgentSettingsSection.tsx (lines 309-314)
**File**: `apps/web/src/components/AgentSettingsSection.tsx`
- Shows spinner when loading
- Fix: `if (loading && !agents.length)`

### 6. AgentKeysSection.tsx (lines 74-79)
**File**: `apps/web/src/components/AgentKeysSection.tsx`
- Shows spinner when loading
- Fix: `if (loading && !agents.length)`

### 7. ChatSessionView.tsx (lines 141-146)
**File**: `apps/web/src/pages/ChatSessionView.tsx`
- Shows spinner when loading
- Fix: `if (loading && !session)`

### 8. Workspace.tsx (lines 1315-1327)
**File**: `apps/web/src/pages/Workspace.tsx`
- Shows spinner when loading
- Fix: `if (loading && !workspace)` — conditional on data existence, not loading state

## Plan

1. Fix all 8 components to only show loading UI when data hasn't been loaded yet
2. Optionally add subtle loading indicators (e.g., opacity reduction, small spinner in corner) during refresh
3. Document the pattern as a core UI principle

## Detailed Tasklist

- [ ] Fix `apps/web/src/components/project/TaskList.tsx` — change loading guard to `loading && !tasks.length`
- [ ] Fix `apps/web/src/pages/ProjectSessions.tsx` — change loading guard to `loading && !chatSessions.length`
- [ ] Fix `apps/web/src/pages/SettingsCloudProvider.tsx` — change loading guard to check for existing data
- [ ] Fix `apps/web/src/components/GitHubAppSection.tsx` — change loading guard to `loading && !installations.length`
- [ ] Fix `apps/web/src/components/AgentSettingsSection.tsx` — change loading guard to `loading && !agents.length`
- [ ] Fix `apps/web/src/components/AgentKeysSection.tsx` — change loading guard to `loading && !agents.length`
- [ ] Fix `apps/web/src/pages/ChatSessionView.tsx` — change loading guard to `loading && !session`
- [ ] Fix `apps/web/src/pages/Workspace.tsx` — change loading guard to `loading && !workspace`
- [ ] Search for any other instances of this pattern in the codebase
- [ ] Run typecheck: `pnpm typecheck`
- [ ] Run build: `pnpm --filter @simple-agent-manager/web build`
