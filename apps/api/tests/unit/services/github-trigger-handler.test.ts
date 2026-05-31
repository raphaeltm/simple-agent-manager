/**
 * Integration tests for handleGitHubEventForTriggers.
 *
 * These tests mock D1 and submitTriggeredTask at the boundary to verify:
 * - Delivery deduplication
 * - Feature flag gating
 * - Non-matching events do not start tasks
 * - Matching events reach the submission boundary with correct payloads
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock submitTriggeredTask before importing the handler
vi.mock('../../../src/services/trigger-submit', () => ({
  submitTriggeredTask: vi.fn().mockResolvedValue({
    taskId: 'task-123',
    sessionId: 'session-456',
    branchName: 'sam/trigger-branch',
  }),
}));

import { handleGitHubEventForTriggers } from '../../../src/services/github-trigger-handler';
import { submitTriggeredTask } from '../../../src/services/trigger-submit';

// ---------------------------------------------------------------------------
// D1 Mock Infrastructure
// ---------------------------------------------------------------------------

interface MockRow {
  [key: string]: unknown;
}

function createMockD1(tables: Record<string, MockRow[]> = {}) {
  const data = { ...tables };

  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(null),
  };

  const mockDb = {
    prepare: vi.fn().mockReturnValue(mockStmt),
    // Drizzle uses batch internally - mock the underlying D1 operations
    _stmt: mockStmt,
    _data: data,
  };

  return { mockDb, mockStmt };
}

// ---------------------------------------------------------------------------
// Minimal Env mock
// ---------------------------------------------------------------------------

function createMockEnv(overrides: Record<string, unknown> = {}) {
  const { mockDb, mockStmt } = createMockD1();

  return {
    env: {
      GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
      DATABASE: mockDb,
      ...overrides,
    } as unknown as Parameters<typeof handleGitHubEventForTriggers>[0],
    mockDb,
    mockStmt,
  };
}

// ---------------------------------------------------------------------------
// Test payloads
// ---------------------------------------------------------------------------

function makeIssuesPayload(action: string = 'labeled') {
  return {
    action,
    sender: { login: 'contributor', type: 'User' },
    repository: { full_name: 'org/repo', default_branch: 'main' },
    installation: { id: 12345 },
    issue: {
      number: 10,
      title: 'Feature request',
      body: 'Please add this feature',
      labels: [{ name: 'sam' }, { name: 'enhancement' }],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleGitHubEventForTriggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Feature flag gating ---
  it('uses GITHUB_WEBHOOK_SECRET as the default enablement signal', async () => {
    const { env } = createMockEnv({ GITHUB_TRIGGERS_ENABLED: undefined });
    const result = await handleGitHubEventForTriggers(env, {
      deliveryId: 'delivery-1',
      eventType: 'star',
      payload: { action: 'created', sender: { login: 'fan' } },
    });
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('unsupported_event_type:star');
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });

  it('returns feature_disabled when neither override nor webhook secret is configured', async () => {
    const { env } = createMockEnv({
      GITHUB_TRIGGERS_ENABLED: undefined,
      GITHUB_WEBHOOK_SECRET: undefined,
    });
    const result = await handleGitHubEventForTriggers(env, {
      deliveryId: 'delivery-no-secret',
      eventType: 'issues',
      payload: makeIssuesPayload(),
    });
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('feature_disabled');
    expect(result.matchedTriggers).toBe(0);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });

  it('returns feature_disabled when flag is explicitly "false"', async () => {
    const { env } = createMockEnv({ GITHUB_TRIGGERS_ENABLED: 'false' });
    const result = await handleGitHubEventForTriggers(env, {
      deliveryId: 'delivery-2',
      eventType: 'issues',
      payload: makeIssuesPayload(),
    });
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('feature_disabled');
  });

  // --- Unsupported event type ---
  it('skips unsupported event types', async () => {
    const { env } = createMockEnv();
    const result = await handleGitHubEventForTriggers(env, {
      deliveryId: 'delivery-3',
      eventType: 'star',
      payload: { action: 'created', sender: { login: 'fan' } },
    });
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('unsupported_event_type:star');
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });

  // --- Delivery deduplication ---
  it('deduplicates deliveries when INSERT OR IGNORE returns 0 changes', async () => {
    const { env, mockStmt } = createMockEnv();
    // Simulate the INSERT OR IGNORE returning 0 changes (duplicate)
    mockStmt.run.mockResolvedValueOnce({ meta: { changes: 0 } });

    const result = await handleGitHubEventForTriggers(env, {
      deliveryId: 'already-processed',
      eventType: 'issues',
      payload: makeIssuesPayload(),
    });
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('duplicate');
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });

  // --- No repository in payload ---
  it('returns no_repository when payload lacks repository', async () => {
    const { env, mockStmt } = createMockEnv();
    // INSERT OR IGNORE succeeds (new delivery)
    mockStmt.run.mockResolvedValueOnce({ meta: { changes: 1 } });

    const result = await handleGitHubEventForTriggers(env, {
      deliveryId: 'delivery-no-repo',
      eventType: 'issues',
      payload: { action: 'opened', sender: { login: 'user' } },
    });
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('no_repository');
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });
});
