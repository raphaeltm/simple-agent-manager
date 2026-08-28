import type {
  ProjectEventDeliveryAdapterDecision,
  ProjectEventRecentStatus,
  ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';
import { PROJECT_EVENT_CONTRACT_VERSION } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const authMocks = vi.hoisted(() => ({
  getUserId: vi.fn(() => 'user-superadmin'),
}));

const serviceMocks = vi.hoisted(() => ({
  getProjectEventRecentStatus: vi.fn(),
  listProjectEventSubscriptionsForCaller: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: {
        id: 'user-superadmin',
        email: 'superadmin@example.com',
        name: 'Test Superadmin',
        role: 'superadmin',
      },
    });
    return next();
  },
  requireApproved: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => (c: any, next: () => Promise<void>) => {
    if (c.req.header('x-test-role') === 'non-superadmin') {
      return c.json({ error: 'FORBIDDEN' }, 403);
    }
    return next();
  },
  getUserId: (...args: unknown[]) => authMocks.getUserId(...args),
}));

vi.mock('../../../src/services/project-data', () => ({
  getProjectEventRecentStatus: (...args: unknown[]) =>
    serviceMocks.getProjectEventRecentStatus(...args),
}));

vi.mock('../../../src/services/project-event-subscriptions', () => ({
  listProjectEventSubscriptionsForCaller: (...args: unknown[]) =>
    serviceMocks.listProjectEventSubscriptionsForCaller(...args),
}));

const { adminProjectEventRoutes } = await import('../../../src/routes/admin-project-events');

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

function adapterDecision(
  overrides: Partial<ProjectEventDeliveryAdapterDecision> = {}
): ProjectEventDeliveryAdapterDecision {
  return {
    action: 'queue_prompt_delivery',
    reason: 'adapter_supported',
    adapterId: 'durable-queue',
    adapterKind: 'durable_queue',
    capability: 'durable_prompt_queue',
    agentType: 'codex',
    protocol: 'project-events',
    protocolVersion: '1',
    durableAck: true,
    supported: true,
    authorized: true,
    terminal: false,
    ...overrides,
  };
}

function subscription(
  overrides: Partial<ProjectEventSubscriptionRecord> = {}
): ProjectEventSubscriptionRecord {
  return {
    id: 'sub-agent-1',
    projectId: 'project-a',
    contractVersion: PROJECT_EVENT_CONTRACT_VERSION,
    owner: {
      type: 'agent',
      id: 'agent-owner-1',
      name: 'Agent owner',
    },
    idempotencyKey: 'idempotency-key-not-returned',
    filter: {
      version: 1,
      source: ['github'],
      eventType: 'pull_request.opened',
      subjectType: 'pull_request',
    },
    filterFingerprint: 'filter-fingerprint-not-returned',
    matchKeyCount: 3,
    deliveryPreference: {
      requested: 'existing_session_prompt',
      resolved: 'queued_for_prompt_delivery',
      target: {
        sessionId: 'session-safe-1',
        taskId: 'task-safe-1',
        runtimeId: 'runtime-safe-1',
        agentId: 'agent-safe-1',
      },
    },
    state: 'active',
    reason: 'Follow pull request updates',
    createdAt: NOW - 10_000,
    updatedAt: NOW - 5_000,
    expiresAt: NOW + 60_000,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    lastMatchedAt: NOW - 1_000,
    ...overrides,
  };
}

function recentStatus(): ProjectEventRecentStatus {
  return {
    projectId: 'project-a',
    events: [
      {
        id: 'evt-1',
        projectId: 'project-a',
        contractVersion: PROJECT_EVENT_CONTRACT_VERSION,
        source: 'github',
        eventType: 'pull_request.opened',
        subject: { type: 'pull_request', id: '123' },
        severity: 'warning',
        deliveryKey: 'delivery-key-not-returned',
        payloadFingerprint: 'fingerprint-not-returned',
        metadata: {
          secret: 'metadata-secret-canary',
          nested: { token: 'metadata-token-canary' },
        },
        display: {
          title: 'PR opened <script>alert(1)</script>',
          summary: 'Untrusted model/event content is inert text.',
          url: 'javascript:alert(1)',
          labels: ['untrusted<script>'],
          untrusted: true,
        },
        rawPayloadRef: {
          provider: 'r2',
          uri: 'r2://raw-payload-secret-canary',
          contentHash: 'raw-content-hash-not-returned',
        },
        occurredAt: NOW - 4_000,
        receivedAt: NOW - 3_000,
        updatedAt: NOW - 2_000,
        state: 'recorded',
        duplicateCount: 2,
        conflictCount: 0,
        conflictFingerprint: null,
        conflictDetectedAt: null,
      },
    ],
    matches: [
      {
        id: 'match-1',
        projectId: 'project-a',
        eventId: 'evt-1',
        subscriptionId: 'sub-agent-1',
        state: 'batch_created',
        matchedAt: NOW - 2_500,
        lifecycleCheckedAt: NOW - 2_400,
        batchId: 'batch-1',
        reason: 'matched filter',
      },
    ],
    batches: [
      {
        id: 'batch-1',
        projectId: 'project-a',
        subscriptionId: 'sub-agent-1',
        idempotencyKey: 'batch-idempotency-key-not-returned',
        state: 'ambiguous',
        requestedDelivery: 'existing_session_prompt',
        resolvedDelivery: 'queued_for_prompt_delivery',
        adapterDecision: adapterDecision({ reason: 'adapter_supported' }),
        target: {
          sessionId: 'session-safe-1',
          taskId: 'task-safe-1',
          runtimeId: 'runtime-safe-1',
          agentId: 'agent-safe-1',
        },
        matchIds: ['match-1'],
        eventCount: 1,
        createdAt: NOW - 2_300,
        updatedAt: NOW - 2_200,
        terminalAt: null,
        terminalReason: null,
      },
    ],
    attempts: [
      {
        id: 'attempt-1',
        projectId: 'project-a',
        batchId: 'batch-1',
        idempotencyKey: 'attempt-idempotency-key-not-returned',
        attemptNumber: 1,
        state: 'retry',
        adapter: 'durable-queue',
        protocolVersion: '1',
        runtimeId: 'runtime-safe-1',
        receiptId: 'receipt-safe-1',
        errorCode: 'TEMPORARY_BACKPRESSURE',
        errorMessage: 'delivery queue is temporarily unavailable',
        startedAt: NOW - 2_100,
        completedAt: null,
        createdAt: NOW - 2_100,
      },
    ],
    accounting: [
      {
        projectId: 'project-a',
        category: 'project_events',
        recordCount: 1,
        estimatedBytes: 2048,
        oldestCreatedAt: NOW - 4_000,
        newestCreatedAt: NOW - 2_000,
        measuredAt: NOW,
      },
    ],
    hasMore: true,
  };
}

describe('admin project event inspector routes', () => {
  let sqlite: Database.Database;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getUserId.mockReturnValue('user-superadmin');
    serviceMocks.listProjectEventSubscriptionsForCaller.mockResolvedValue({
      subscriptions: [subscription()],
      hasMore: false,
    });
    serviceMocks.getProjectEventRecentStatus.mockResolvedValue(recentStatus());

    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repository TEXT,
        repo_provider TEXT,
        status TEXT,
        active_session_count INTEGER,
        last_activity_at TEXT
      );
      INSERT INTO projects (
        id, name, repository, repo_provider, status, active_session_count, last_activity_at
      ) VALUES (
        'project-a',
        'Eventing Fixtures',
        'raphaeltm/simple-agent-manager',
        'github',
        'active',
        4,
        '2026-08-28T12:00:00.000Z'
      );
    `);

    app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/admin/project-events', adminProjectEventRoutes);
  });

  afterEach(() => {
    sqlite.close();
  });

  function env(): Env {
    return { DATABASE: createSqliteD1(sqlite) } as Env;
  }

  it('returns sanitized superadmin inspector data from B4 read surfaces', async () => {
    const res = await app.request(
      '/api/admin/project-events/project-a/inspector?limit=3',
      {},
      env()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project).toMatchObject({
      id: 'project-a',
      name: 'Eventing Fixtures',
      repository: 'raphaeltm/simple-agent-manager',
      repoProvider: 'github',
      activeSessionCount: 4,
    });
    expect(body.limit).toBe(3);
    expect(body.totals).toMatchObject({
      activeSubscriptions: 1,
      recentEvents: 1,
      recentMatches: 1,
      recentBatches: 1,
      recentAttempts: 1,
      attentionBatches: 1,
      attentionAttempts: 1,
    });
    expect(body.subscriptions[0]).toMatchObject({
      id: 'sub-agent-1',
      requestedDelivery: 'existing_session_prompt',
      resolvedDelivery: 'queued_for_prompt_delivery',
      target: {
        sessionId: 'session-safe-1',
        taskId: 'task-safe-1',
        runtimeId: 'runtime-safe-1',
        agentId: 'agent-safe-1',
      },
    });
    expect(body.events[0]).toMatchObject({
      id: 'evt-1',
      display: expect.objectContaining({
        title: 'PR opened <script>alert(1)</script>',
        url: 'javascript:alert(1)',
        untrusted: true,
      }),
      hasRawPayloadRef: true,
    });
    expect(body.events[0]).not.toHaveProperty('metadata');
    expect(body.events[0]).not.toHaveProperty('rawPayloadRef');
    expect(body.subscriptions[0]).not.toHaveProperty('idempotencyKey');
    expect(body.batches[0]).not.toHaveProperty('idempotencyKey');
    expect(body.attempts[0]).not.toHaveProperty('idempotencyKey');

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('metadata-secret-canary');
    expect(serialized).not.toContain('metadata-token-canary');
    expect(serialized).not.toContain('r2://raw-payload-secret-canary');
    expect(serialized).not.toContain('raw-content-hash-not-returned');

    expect(serviceMocks.listProjectEventSubscriptionsForCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'platform',
        projectId: 'project-a',
        actorId: 'user-superadmin',
        actorName: 'Test Superadmin',
        permissions: { readAllSubscriptions: true },
      }),
      { state: 'any', ownerScope: 'all', limit: 3 }
    );
    expect(serviceMocks.getProjectEventRecentStatus).toHaveBeenCalledWith(
      expect.anything(),
      'project-a',
      { limit: 3 }
    );
  });

  it('rejects non-superadmins before reading project event data', async () => {
    const res = await app.request(
      '/api/admin/project-events/project-a/inspector',
      { headers: { 'x-test-role': 'non-superadmin' } },
      env()
    );

    expect(res.status).toBe(403);
    expect(serviceMocks.listProjectEventSubscriptionsForCaller).not.toHaveBeenCalled();
    expect(serviceMocks.getProjectEventRecentStatus).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown projects without reading ProjectData', async () => {
    const res = await app.request('/api/admin/project-events/missing/inspector', {}, env());

    expect(res.status).toBe(404);
    expect(serviceMocks.listProjectEventSubscriptionsForCaller).not.toHaveBeenCalled();
    expect(serviceMocks.getProjectEventRecentStatus).not.toHaveBeenCalled();
  });

  it('rejects invalid limits before reading ProjectData', async () => {
    const res = await app.request(
      '/api/admin/project-events/project-a/inspector?limit=not-a-number',
      {},
      env()
    );

    expect(res.status).toBe(400);
    expect(serviceMocks.listProjectEventSubscriptionsForCaller).not.toHaveBeenCalled();
    expect(serviceMocks.getProjectEventRecentStatus).not.toHaveBeenCalled();
  });
});
