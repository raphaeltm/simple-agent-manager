# No Page Reload on Mutation

## Rule: Never use `window.location.reload()` after API mutations

After any API mutation (POST, PUT, DELETE, PATCH), the UI MUST update via React state — not a full page reload. Page reloads destroy scroll position, reading context, and any in-progress user interactions.

### Acceptable uses of `window.location.reload()`

Only these scenarios justify a full page reload:
- **Error recovery** (e.g., `ErrorBoundary` crash recovery)
- **Auth state changes** (e.g., login/logout, pending-approval polling)

### Banned patterns

```typescript
// BAD: Full page reload after mutation
await updateTaskStatus(id, { toStatus: 'completed' });
window.location.reload();

// BAD: Replacing visible data with a loading spinner during refetch
setLoading(true); // hides already-rendered content
const data = await refetch();
setLoading(false);
```

### Required patterns

```typescript
// GOOD: Callback-based refresh (parent provides refetch function)
await updateTaskStatus(id, { toStatus: 'completed' });
onSessionMutated?.(); // parent calls loadSessions()

// GOOD: Background refetch that preserves existing data
setIsRefreshing(true); // shows subtle indicator, does NOT hide content
const data = await refetch();
setIsRefreshing(false);

// GOOD: Optimistic update
setItems(prev => prev.filter(item => item.id !== deletedId));
await deleteItem(deletedId); // fire-and-forget or rollback on error
```

### Why This Rule Exists

`handleMarkComplete()` in `ProjectMessageView.tsx` used `window.location.reload()` after completing a task, destroying the user's scroll position and reading context. The correct pattern already existed in the same codebase — `handleCloseConversation` in `ProjectChat.tsx` used `void loadSessions()` to refresh without a reload.

### Data visibility during refetch

When refetching data that is already displayed, the existing data MUST remain visible. Use a background refetch pattern (e.g., `isRefreshing` state with a subtle indicator) instead of replacing content with a full-screen spinner.

### Quick Compliance Check

Before committing UI mutation code:
- [ ] No `window.location.reload()` after any API call (unless error recovery or auth)
- [ ] Already-displayed data stays visible during refetch
- [ ] Mutation success triggers React state update or callback, not page reload
