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

## Credential Lifecycle Alignment (Required)

When implementing credential revocation, cleanup, or expiration, you MUST verify that the credential's lifecycle matches the connection or session that depends on it.

### Why This Rule Exists

The MCP token revocation bug (see `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md`) was caused by revoking a task-scoped token when the MCP connection that used it was scoped to the entire ACP session. Once revoked, the client had no mechanism to obtain a new token, breaking all subsequent tool calls permanently.

### Required Steps

1. **Identify all consumers** of the credential being revoked/expired
2. **Map the credential lifecycle** vs the connection/session lifecycle that uses it
3. **If the connection outlives the credential**, do NOT revoke eagerly — rely on TTL expiration or provide a refresh mechanism
4. **If the credential outlives the connection**, verify cleanup happens when the connection closes
5. **Write a test** that exercises the lifecycle boundary: perform the credential-invalidating action, then verify subsequent operations on the same connection still work (or fail gracefully with refresh)

## CORS Origin Validation (Required)

When adding or modifying CORS middleware, the origin callback MUST default to **deny** (return `null`) for unrecognized origins. Never use a fallthrough that reflects the requesting origin.

> For browser requests to external origins (R2, S3, third-party APIs), see `.claude/rules/20-cross-origin-cors.md`.

### Why This Rule Exists

The CORS origin fallthrough bug (see `docs/notes/2026-03-09-cors-origin-fallthrough-postmortem.md`) allowed any website to make credentialed cross-origin requests because the origin callback returned the requesting origin for all cases, including unknown ones.

### Required Steps

1. **Origin callbacks must default-deny**: The fallthrough/default case must return `null` (or `undefined`), not the origin string
2. **Use proper subdomain checks**: Use `hostname === baseDomain || hostname.endsWith('.baseDomain')` instead of `origin.includes(baseDomain)` which matches substrings
3. **Parse origins as URLs**: Use `new URL(origin)` to extract the hostname for comparison, catching malformed origins
4. **Write negative tests**: Every CORS configuration must have at least one test verifying that unknown origins are rejected (no `Access-Control-Allow-Origin` header)
5. **Separate credentials for token-auth endpoints**: Endpoints using Bearer token auth (not cookies) should use `credentials: false` + `origin: '*'`

## UI-to-Backend Data Path Verification (Required)

When adding a new UI input element (form field, dropdown, toggle, radio group) that collects a user choice affecting backend behavior, you MUST verify the complete data path before marking the work complete.

### Why This Rule Exists

The Scaleway node creation bug (see `docs/notes/2026-03-14-scaleway-node-creation-failure-postmortem.md`) shipped a fully functional provider dropdown that looked correct — selecting Scaleway showed Scaleway locations and prices — but `handleCreateNode()` never included the selected provider in the API call. The `CreateNodeRequest` type didn't even have a `provider` field. The dropdown was cosmetic: it collected input that was silently discarded.

### Required Steps

When adding any new UI input that affects backend behavior:

1. **Verify the request type accepts the field.** The shared type (e.g., `CreateNodeRequest`) must include the field. If TypeScript doesn't error when you omit it, the field isn't in the type.
2. **Verify the submit handler includes the field.** The event handler (e.g., `handleCreateNode`) must include the state variable in the API call payload.
3. **Verify the API route reads the field.** The backend handler must extract the field from the request body and pass it to the service layer.
4. **Verify the service layer acts on the field.** The field must actually influence behavior (e.g., filtering a database query, selecting a provider).
5. **Write a test that traces the value end-to-end.** At minimum, test that the backend function receives and uses the field correctly. Ideally, test from API request through to the observable outcome.

### Red Flags

- A `useState` variable that appears in JSX `value=` props but not in any `fetch`/API call
- A `<Select>` or `<input>` whose `onChange` updates state that only affects local rendering (catalog display) but not the form submission
- A request type that doesn't include a field the UI collects
- A backend handler that destructures a request body but ignores a field the UI sends

### Quick Check

Before committing UI form changes:
- [ ] Every new `useState` variable used in a form input also appears in the submit handler's API call
- [ ] The API request type includes every field the form collects
- [ ] The backend handler reads every field the API request type defines
- [ ] At least one test verifies the field's value reaches the backend function that acts on it

## Adding New Features

1. Check if types need to be added to `packages/shared`
2. If provider-related, add to `packages/providers`
3. API endpoints go in `apps/api/src/routes/`
4. UI components go in `apps/web/src/components/`
