/**
 * Integration tests for handleGitHubEventForTriggers.
 *
 * These tests mock D1 and trigger admission at the boundary to verify:
 * - Delivery deduplication
 * - Feature flag gating
 * - Non-matching events do not start tasks
 * - Matching events reach the submission boundary with correct payloads
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock trigger admission before importing the handler. Success-path tests invoke
// the supplied renderPrompt callback so the production context/renderer wiring runs.
vi.mock('../../../src/services/trigger-admission', () => ({
  admitAndSubmitTriggerExecution: vi.fn().mockResolvedValue({
    outcome: 'submitted',
    executionId: 'execution-123',
    taskId: 'task-123',
    sessionId: 'session-456',
    branchName: 'sam/trigger-branch',
  }),
}));

import { handleGitHubEventForTriggers } from '../../../src/services/github-trigger-handler';
import { admitAndSubmitTriggerExecution } from '../../../src/services/trigger-admission';

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
    raw: vi.fn().mockResolvedValue([]),
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
    expect(admitAndSubmitTriggerExecution).not.toHaveBeenCalled();
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
    expect(admitAndSubmitTriggerExecution).not.toHaveBeenCalled();
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
    expect(admitAndSubmitTriggerExecution).not.toHaveBeenCalled();
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
    expect(admitAndSubmitTriggerExecution).not.toHaveBeenCalled();
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
    expect(admitAndSubmitTriggerExecution).not.toHaveBeenCalled();
  });

  it('renders matching GitHub events as plain text before admission', async () => {
    const { env, mockStmt } = createMockEnv();
    const now = '2026-07-14T00:00:00.000Z';
    const issueBody = 'Quotes "stay" & <script>window.githubExecuted=true</script> **bold**';

    mockStmt.raw
      .mockResolvedValueOnce([['project-1', 'Project One']])
      .mockResolvedValueOnce([
        [
          'trigger-1',
          'project-1',
          'user-1',
          'GitHub issue trigger',
          null,
          'active',
          'github',
          null,
          'UTC',
          1,
          'Body: {{github.body}}',
          null,
          null,
          'task',
          null,
          1,
          null,
          0,
          1,
          null,
          null,
          null,
          null,
          now,
          now,
        ],
      ])
      .mockResolvedValueOnce([['config-1', 'trigger-1', 'issues', '{}', now, now]]);

    let renderedPrompt = '';
    vi.mocked(admitAndSubmitTriggerExecution).mockImplementationOnce(async (_env, input) => {
      renderedPrompt = input.renderPrompt('execution-123', 1);
      return {
        outcome: 'submitted',
        executionId: 'execution-123',
        taskId: 'task-123',
        sessionId: 'session-456',
        branchName: 'sam/trigger-branch',
      };
    });

    const result = await handleGitHubEventForTriggers(env, {
      deliveryId: 'delivery-matched',
      eventType: 'issues',
      payload: {
        ...makeIssuesPayload('opened'),
        issue: {
          ...makeIssuesPayload('opened').issue,
          body: issueBody,
        },
      },
    });

    expect(result).toEqual({
      processed: true,
      deliveryId: 'delivery-matched',
      matchedTriggers: 1,
    });
    expect(admitAndSubmitTriggerExecution).toHaveBeenCalledOnce();
    expect(renderedPrompt).toBe(`Body: ${issueBody}`);
    expect(renderedPrompt).not.toContain('&quot;');
    expect(renderedPrompt).not.toContain('[object Object]');
  });
});
