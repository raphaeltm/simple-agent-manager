# Vertical Slice Testing (Mandatory for Cross-Boundary Features)

## The Problem

Unit tests that mock dependencies with empty objects or minimal stubs pass even when the integration is completely broken. A test that mocks `vi.fn().mockResolvedValue({})` proves nothing about whether the real system would return data in that shape, whether the caller handles it correctly, or whether prerequisite state was established upstream.

99% of features in this codebase cross at least one system boundary (Worker to DO, Worker to VM agent, API to D1, UI to API). Tests for these features MUST be vertical slice tests — they mock at the boundary but carry realistic state through the mock.

## What Is a Vertical Slice Test?

A vertical slice test exercises a feature through all its layers, mocking only at system boundaries (external APIs, databases, DOs, VM agent HTTP calls) — not at internal function boundaries. The mocks carry realistic state that reflects what the real system would contain at that point in the flow.

```
UI Component
    |
    v
API Route Handler      <-- real code
    |
    v
Service Layer          <-- real code
    |
    v
Database / DO / HTTP   <-- mock HERE, with realistic state
```

### What "Realistic State" Means

The mock must return data that:
1. Has the same shape as the real system's response (all fields present, correct types)
2. Reflects prerequisite state that earlier steps would have created
3. Includes relationships between entities (a workspace references a real node ID, a task references a real project ID)
4. Contains enough variety to exercise branching logic (not just one happy-path object)

## Required State Setup Pattern

For every vertical slice test, you MUST set up state across all mocked systems before asserting behavior.

### Example: Task Dispatch Test

Bad (isolated, proves nothing about integration):
```typescript
it('dispatches a task', async () => {
  const mockDb = { prepare: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({}) }) };
  const result = await dispatchTask(mockDb, 'task-1');
  expect(result).toBeDefined();
});
```

Good (vertical slice with realistic state):
```typescript
it('dispatches a task to an available node', async () => {
  // Set up realistic state across all systems
  const project = makeProject({ id: 'proj-1', repoUrl: 'https://github.com/org/repo' });
  const node = makeNode({ id: 'node-1', projectId: 'proj-1', status: 'active', ip: '1.2.3.4' });
  const credential = makeCredential({ userId: 'user-1', provider: 'hetzner', isActive: true });

  // Mock D1 with state that reflects what earlier operations created
  const db = createTestDb({
    projects: [project],
    nodes: [node],
    credentials: [credential],
  });

  // Mock VM agent HTTP boundary with realistic response
  const vmAgentFetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({
      workspaceId: 'ws-1',
      status: 'creating',
      agentSessionId: 'sess-1',
    }), { status: 201 })
  );

  // Exercise the full vertical slice
  const app = createTestApp({ db, fetch: vmAgentFetch });
  const res = await app.request('/api/projects/proj-1/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'Fix the bug', agentType: 'claude-code' }),
  }, mockEnvWithAuth('user-1'));

  // Assert end-to-end outcome
  expect(res.status).toBe(201);
  const task = await res.json();
  expect(task.nodeId).toBe('node-1');
  expect(task.status).toBe('dispatching');

  // Assert the VM agent was called with correct payload
  expect(vmAgentFetch).toHaveBeenCalledWith(
    expect.stringContaining('1.2.3.4'),
    expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('Fix the bug'),
    })
  );
});
```

## Common SAM Boundary Pairs

When your feature crosses any of these boundaries, set up state on both sides:

| Boundary | Mock at | State to set up |
|----------|---------|----------------|
| **API Route to D1** | D1 queries | Rows in all referenced tables (project, node, workspace, user, credentials) with valid foreign keys |
| **API Route to Durable Object** | DO stub | DO internal state (sessions, messages, alarms) that reflects prior operations |
| **API Route to VM Agent** | HTTP fetch | VM agent response with realistic workspace/session metadata |
| **Task Runner DO to D1** | D1 queries | Task row, project row, node row, credential row — all with consistent IDs |
| **Task Runner DO to VM Agent** | HTTP fetch | Agent session creation response, heartbeat responses |
| **UI Component to API** | fetch/API client | API response with full entity shape including nested objects and arrays |
| **VM Agent to Control Plane** | HTTP fetch | Callback responses (token validation, message persistence, status updates) |
| **Cron Job to D1 + DO** | Both | D1 rows for discovery, DO state for lifecycle operations |

## When to Write Vertical Slice Tests

Write a vertical slice test when ANY of these are true:

1. The feature touches 2+ packages or services
2. Data flows through an HTTP boundary (API call, webhook, callback)
3. A UI action triggers a backend operation that produces a user-visible result
4. A background process (cron, DO alarm) reads state from one system and writes to another
5. A state machine transition depends on data from multiple sources

If the feature is purely internal to one module with no external dependencies (a pure function, a parser, a validator), a standard unit test is fine.

## Vertical Slice Test Checklist

Before marking any cross-boundary feature complete:

- [ ] Identified all system boundaries the feature crosses
- [ ] At least one test exercises the full vertical slice from entry point to final outcome
- [ ] Every mock at a boundary carries realistic state (not empty objects or minimal stubs)
- [ ] Mock state includes valid relationships between entities (consistent IDs, foreign keys)
- [ ] The test asserts both the final user-visible outcome AND the payloads sent to mocked boundaries
- [ ] At least one test includes a failure/error state at a boundary to verify error propagation
- [ ] State variety: mocks include enough data to exercise branching (e.g., multiple nodes to test selection, both active and inactive credentials to test filtering)

## Anti-Patterns (Banned)

### 1. Empty Mock Objects
```typescript
// BANNED: Proves nothing about the integration
const mockDb = {} as D1Database;
```

### 2. Minimal Stubs That Skip State
```typescript
// BANNED: No realistic state, just returns success
vi.mock('./services/nodes', () => ({
  findAvailableNode: vi.fn().mockResolvedValue({ id: 'node-1' }),
}));
```
The mock returns a node with only an `id`. The real function returns a node with `ip`, `status`, `projectId`, `vmSize`, `provider`, and more. Code that reads any of those fields will silently get `undefined` — and the test still passes.

### 3. Testing One Layer When the Feature Spans Three
```typescript
// BANNED for multi-layer features: Only tests the service, not the route or the DB
it('creates a workspace', async () => {
  const result = await workspaceService.create(mockInput);
  expect(result.id).toBeDefined();
});
```
If the route doesn't call the service correctly, or the service doesn't write to the DB correctly, this test won't catch it.

### 4. Mocking Internal Functions Instead of Boundaries
```typescript
// BANNED: Mocking internal helpers defeats the purpose
vi.mock('./utils/validate', () => ({ validate: vi.fn().mockReturnValue(true) }));
```
Mock at system boundaries (D1, HTTP, DO), not at internal function boundaries. The vertical slice should exercise your own code; only external systems get mocked.

## Relationship to Other Testing Rules

- **Rule 02 (Quality Gates)**: Vertical slice tests satisfy the "capability test" requirement when they cross system boundaries
- **Rule 10 (E2E Verification)**: Vertical slice tests are the automated complement to data flow tracing — the trace identifies the path, the test proves the path works
- **Rule 23 (Cross-Boundary Contract Tests)**: Contract tests verify the shape of the boundary; vertical slice tests verify the behavior through the boundary with realistic state
- **Rule 33 (Staging Feature Validation)**: Vertical slice tests catch most integration bugs locally, reducing the number of staging deploy cycles needed
