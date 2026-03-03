# General Technical Patterns

## Provider Implementation

```typescript
import { Provider, VMConfig, VMInstance } from './types';

export class MyProvider implements Provider {
  async createVM(config: VMConfig): Promise<VMInstance> {
    // Implementation
  }
}
```

## Adding a New Provider

1. Create provider class in `packages/providers/src/`
2. Implement `Provider` interface
3. Export from `packages/providers/src/index.ts`
4. Add unit tests

## React Component Pattern

```typescript
import { FC } from 'react';

interface Props {
  workspace: Workspace;
}

export const WorkspaceCard: FC<Props> = ({ workspace }) => {
  return (
    <div className="workspace-card">
      {/* Implementation */}
    </div>
  );
};
```

## React Interaction-Effect Analysis (Required)

When adding or modifying a click handler, navigation call, or state setter in a component that has `useEffect` hooks, you MUST trace forward through every effect that could fire as a result of the state change.

### Why This Rule Exists

The "New Chat" button bug (see `docs/notes/2026-03-01-new-chat-button-postmortem.md`) was caused by a click handler and a `useEffect` both reacting to the same state (`sessionId === undefined`). The handler navigated to a URL without a session ID; the effect saw `sessionId === undefined` and immediately redirected back. The button shipped broken with 529 passing tests because no one traced what effects would fire after the click.

### Required Steps

1. **Identify all effects in the component** that depend on state changed by your new handler
2. **Trace the state transition**: What state does the handler set? What will each effect do when it sees that state?
3. **Check for conflicts**: Will any effect undo, override, or race with the handler's intended outcome?
4. **Add disambiguation if needed**: If the same state can be reached by both "user action" and "initial load" (or other paths), add a mechanism to distinguish them (e.g., a ref flag, a distinct state value, or a dedicated state field)
5. **Write a behavioral test**: The test must render the component, simulate the interaction, and assert the effect does not interfere with the intended outcome

### Common Patterns That Need This Analysis

- Navigation handlers in components with auto-select/auto-redirect effects
- Form reset handlers in components with validation effects
- Toggle handlers in components with sync effects
- Any handler that sets state to a value that an effect treats as a trigger

### Example Trace

```
Handler: handleNewChat() sets sessionId = undefined via navigate('/chat')
Effect: useEffect depends on [sessionId] — when sessionId is undefined and sessions exist, navigates to sessions[0]
Conflict: Effect undoes the handler's intent
Fix: Add newChatIntentRef to distinguish "user clicked New" from "initial page load"
```

## Async Effect Cleanup Must Cancel In-Flight Requests

When a `useEffect` makes HTTP requests (directly or via intervals/polling), the cleanup function MUST abort in-flight requests using `AbortController`, not just stop future ones via `clearInterval`.

### Why This Rule Exists

The chat session leakage bug (see `docs/notes/2026-03-03-chat-session-leakage-postmortem.md`) was caused by a polling interval that called `clearInterval()` on cleanup but did NOT abort the in-flight HTTP request. When the user switched sessions, the old session's poll response arrived after the new session's data had loaded and overwrote it.

### Required Pattern

```typescript
useEffect(() => {
  const abortController = new AbortController();
  const interval = setInterval(async () => {
    if (abortController.signal.aborted) return;
    const data = await fetchData(/* pass signal if possible */);
    if (abortController.signal.aborted) return; // Guard after await
    setState(data);
  }, POLL_MS);

  return () => {
    abortController.abort();
    clearInterval(interval);
  };
}, [deps]);
```

### Key Points

1. Always check `abortController.signal.aborted` AFTER every `await` before writing state
2. Pass the `AbortSignal` to `fetch()` calls when possible for early cancellation
3. For components that receive an entity ID as a prop and manage state based on it, prefer `key={id}` on the parent to force clean unmount/remount

## Adding New Features

1. Check if types need to be added to `packages/shared`
2. If provider-related, add to `packages/providers`
3. API endpoints go in `apps/api/src/routes/`
4. UI components go in `apps/web/src/components/`
