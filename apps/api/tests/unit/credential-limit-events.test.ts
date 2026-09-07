import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../src/durable-objects/migrations';
import {
  admitProjectEvent as admitProjectDataEvent,
  createProjectEventSubscription,
} from '../../src/durable-objects/project-data/project-events';
import type { Env as ProjectDataEnv } from '../../src/durable-objects/project-data/types';
import { handleAcpUsageCallback } from '../../src/services/acp-usage-callback-handler';
import {
  CREDENTIAL_LIMIT_EVENT_TYPES,
  type CredentialLimitObservation,
  extractCredentialLimitObservationsFromHeaders,
  parseOpenAIDurationMs,
  recordCredentialLimitObservation,
  retryPendingCredentialLimitEventAdmissions,
} from '../../src/services/credential-limit-events';
import { resolveCredentialLimitConfig } from '../../src/services/credential-limit-events/config';
import * as jwtService from '../../src/services/jwt';
import * as projectDataService from '../../src/services/project-data';
import { createSqliteD1 } from '../helpers/sqlite-d1';
import { createSqlStorage } from './durable-objects/sql-storage-test-utils';

vi.mock('../../src/services/project-data', () => ({
  admitProjectEvent: vi.fn(async () => ({ outcome: 'created' })),
  getAcpSession: vi.fn(),
}));

vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(),
}));

vi.mock('../../src/services/acp-activity-callback-flush', () => ({
  assertAcpActivityCallbackResourcesActive: vi.fn(async () => undefined),
}));

type TestEnv = {
  DATABASE: D1Database;
  CREDENTIAL_LIMIT_WARNING_PERCENT?: string;
  CREDENTIAL_LIMIT_CRITICAL_PERCENT?: string;
  CREDENTIAL_LIMIT_MAX_OBSERVATIONS_PER_REPORT?: string;
  CREDENTIAL_LIMIT_OBSERVATION_MAX_AGE_MS?: string;
  CREDENTIAL_LIMIT_OBSERVATION_FUTURE_SKEW_MS?: string;
  CREDENTIAL_LIMIT_RESET_MAX_FUTURE_MS?: string;
  CREDENTIAL_LIMIT_ADMISSION_MAX_ACTIVE_PER_PROJECT?: string;
  CREDENTIAL_LIMIT_ADMISSION_RETRY_BATCH_SIZE?: string;
  CREDENTIAL_LIMIT_ADMISSION_MAX_ATTEMPTS?: string;
  CREDENTIAL_LIMIT_ADMISSION_RETRY_DELAY_MS?: string;
  CREDENTIAL_LIMIT_ADMISSION_RETENTION_DAYS?: string;
};

type WindowRow = {
  status: string;
  last_event_level: string;
  observed_at: number;
  stale_sample_count: number;
  duplicate_sample_count: number;
  last_event_delivery_key: string | null;
};

type AdmissionRow = {
  id: string;
  delivery_key: string;
  dispatch_state: string;
  dispatch_outcome: string | null;
  dispatch_attempts: number;
  event_type: string;
  event_payload_json: string;
};

function migrationPath(name: string): string {
  return join(process.cwd(), 'src/db/migrations', name);
}

function createCredentialD1(overrides: Partial<TestEnv> = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT,
      chat_session_id TEXT,
      node_id TEXT,
      status TEXT
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      user_id TEXT,
      status TEXT,
      agent_type TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  sqlite.exec(readFileSync(migrationPath('0145_credential_limit_windows.sql'), 'utf8'));
  sqlite.exec(readFileSync(migrationPath('0146_credential_limit_event_admissions.sql'), 'utf8'));
  sqlite.prepare('INSERT INTO users (id) VALUES (?)').run('user-1');
  sqlite.prepare('INSERT INTO projects (id) VALUES (?)').run('project-1');
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, project_id, user_id, chat_session_id, node_id, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run('workspace-1', 'project-1', 'user-1', 'chat-1', 'node-1', 'running');
  sqlite
    .prepare(
      `INSERT INTO agent_sessions (
        id, workspace_id, user_id, status, agent_type, created_at, updated_at,
        agent_credential_source, agent_credential_reference, agent_credential_provider,
        agent_provider_mode, agent_credential_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'session-1',
      'workspace-1',
      'user-1',
      'running',
      'claude-code',
      '2026-09-07T00:00:00Z',
      '2026-09-07T00:00:00Z',
      'user',
      'cc_credentials:cred-1',
      'anthropic',
      'direct',
      1
    );
  const env = {
    DATABASE: createSqliteD1(sqlite),
    CREDENTIAL_LIMIT_WARNING_PERCENT: '75',
    CREDENTIAL_LIMIT_CRITICAL_PERCENT: '90',
    CREDENTIAL_LIMIT_ADMISSION_RETRY_DELAY_MS: '1',
    ...overrides,
  } as TestEnv;
  return { sqlite, env };
}

function baseObservation(overrides: Partial<CredentialLimitObservation> = {}): CredentialLimitObservation {
  return {
    projectId: 'project-1',
    userId: 'user-1',
    credentialReference: 'cc_credentials:cred-1',
    credentialSource: 'user',
    provider: 'anthropic',
    providerMode: 'direct',
    windowType: 'claude.five_hour',
    source: 'claude-acp.rate_limit',
    observedAt: 100_000,
    status: 'allowed',
    utilizationPercent: 80,
    resetsAt: 120_000,
    workspaceId: 'workspace-1',
    agentSessionId: 'session-1',
    chatSessionId: 'chat-1',
    agentType: 'claude-code',
    ...overrides,
  };
}

function window(sqlite: Database.Database): WindowRow | undefined {
  return sqlite
    .prepare(
      `SELECT status, last_event_level, observed_at, stale_sample_count,
              duplicate_sample_count, last_event_delivery_key
       FROM credential_limit_windows
       WHERE project_id = 'project-1'
         AND credential_reference = 'cc_credentials:cred-1'
         AND window_type = 'claude.five_hour'`
    )
    .get() as WindowRow | undefined;
}

function admissions(sqlite: Database.Database): AdmissionRow[] {
  return sqlite
    .prepare(
      `SELECT id, delivery_key, dispatch_state, dispatch_outcome, dispatch_attempts,
              event_type, event_payload_json
       FROM credential_limit_event_admissions
       ORDER BY created_at ASC, id ASC`
    )
    .all() as AdmissionRow[];
}

function createProjectEventStore() {
  const sqlite = new Database(':memory:');
  const sql = createSqlStorage(sqlite);
  runMigrations(sql);
  const env = { PROJECT_EVENT_RETENTION_DAYS: '30' } as ProjectDataEnv;
  return { sqlite, sql, env };
}

function makeContext(env: unknown, bodyHeaders: Record<string, string> = {}) {
  const headers = { Authorization: 'Bearer callback-token', ...bodyHeaders };
  return {
    env,
    req: {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
    },
    body: (body: BodyInit | null, status?: number) => new Response(body, { status }),
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.mocked(projectDataService.admitProjectEvent).mockReset();
  vi.mocked(projectDataService.admitProjectEvent).mockResolvedValue({ outcome: 'created' } as never);
  vi.mocked(projectDataService.getAcpSession).mockReset();
  vi.mocked(jwtService.verifyCallbackToken).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('credential limit producer', () => {
  it('dispatches a captured admission through canonical ProjectData event matching', async () => {
    const { env } = createCredentialD1();
    const eventStore = createProjectEventStore();
    try {
      const subscription = createProjectEventSubscription(eventStore.sql, eventStore.env, 'project-1', {
        projectId: 'project-1',
        owner: { type: 'agent', id: 'session-1', name: 'session-1' },
        idempotencyKey: 'credential-subscription',
        filter: { version: 1, source: 'sam.credential_limit' },
        deliveryPreference: {
          requested: 'existing_session_prompt',
          resolved: 'recorded_not_injected',
          target: { sessionId: 'chat-1', taskId: null, runtimeId: null, agentId: 'session-1' },
        },
        expiresAt: 200_000,
      }).subscription;
      vi.mocked(projectDataService.admitProjectEvent).mockImplementation(async (_env, projectId, input) =>
        admitProjectDataEvent(eventStore.sql, eventStore.env, projectId, { projectId, ...input })
      );

      await expect(recordCredentialLimitObservation(env as never, baseObservation())).resolves.toMatchObject({
        outcome: 'event_admitted',
        transition: 'warning',
        admissionOutcome: 'created',
        dispatchOutcome: 'created',
      });

      const storedEvent = eventStore.sqlite.prepare('SELECT * FROM project_events').get() as Record<string, unknown>;
      expect(storedEvent).toMatchObject({
        project_id: 'project-1',
        source: 'sam.credential_limit',
        event_type: CREDENTIAL_LIMIT_EVENT_TYPES.warning,
      });
      expect(
        eventStore.sqlite.prepare('SELECT subscription_id FROM project_event_matches').all()
      ).toEqual([expect.objectContaining({ subscription_id: subscription.id })]);
    } finally {
      eventStore.sqlite.close();
    }
  });

  it('captures D1 admission before ProjectData and suppresses superseded stale retry', async () => {
    const { sqlite, env } = createCredentialD1();
    vi.mocked(projectDataService.admitProjectEvent)
      .mockRejectedValueOnce(new Error('ProjectData unavailable'))
      .mockResolvedValue({ outcome: 'created' } as never);

    const critical = await recordCredentialLimitObservation(
      env as never,
      baseObservation({ observedAt: 100_000, utilizationPercent: 95 })
    );
    expect(critical).toMatchObject({
      outcome: 'event_admitted',
      transition: 'critical',
      dispatchOutcome: 'failed',
    });
    expect(window(sqlite)).toMatchObject({ last_event_level: 'critical', observed_at: 100_000 });
    expect(admissions(sqlite).find((row) => row.event_type === CREDENTIAL_LIMIT_EVENT_TYPES.critical)).toMatchObject({ dispatch_state: 'failed' });

    const reset = await recordCredentialLimitObservation(
      env as never,
      baseObservation({ observedAt: 101_000, utilizationPercent: 10, status: 'allowed' })
    );
    expect(reset).toMatchObject({
      outcome: 'event_admitted',
      transition: 'reset',
      dispatchOutcome: 'created',
    });

    vi.mocked(projectDataService.admitProjectEvent).mockClear();
    vi.setSystemTime(102_000);
    await expect(
      retryPendingCredentialLimitEventAdmissions(env as never, resolveCredentialLimitConfig(env as never), {
        projectId: 'project-1',
      })
    ).resolves.toEqual(['superseded']);
    expect(projectDataService.admitProjectEvent).not.toHaveBeenCalled();
    expect(admissions(sqlite).find((row) => row.event_type === CREDENTIAL_LIMIT_EVENT_TYPES.critical)).toMatchObject({
      dispatch_state: 'superseded',
      dispatch_outcome: 'superseded',
    });
  });

  it('does not emit an older reset after a newer critical edge is current', async () => {
    const { sqlite, env } = createCredentialD1();
    await recordCredentialLimitObservation(
      env as never,
      baseObservation({ observedAt: 100_000, utilizationPercent: 80 })
    );

    vi.mocked(projectDataService.admitProjectEvent).mockRejectedValueOnce(new Error('ProjectData unavailable'));
    await expect(
      recordCredentialLimitObservation(
        env as never,
        baseObservation({ observedAt: 101_000, utilizationPercent: 10, status: 'allowed' })
      )
    ).resolves.toMatchObject({ transition: 'reset', dispatchOutcome: 'failed' });

    vi.mocked(projectDataService.admitProjectEvent).mockResolvedValue({ outcome: 'created' } as never);
    await expect(
      recordCredentialLimitObservation(
        env as never,
        baseObservation({ observedAt: 102_000, utilizationPercent: 96 })
      )
    ).resolves.toMatchObject({ transition: 'critical', dispatchOutcome: 'created' });

    vi.mocked(projectDataService.admitProjectEvent).mockClear();
    vi.setSystemTime(103_000);
    await expect(
      retryPendingCredentialLimitEventAdmissions(env as never, resolveCredentialLimitConfig(env as never), {
        projectId: 'project-1',
      })
    ).resolves.toEqual(['superseded']);
    expect(projectDataService.admitProjectEvent).not.toHaveBeenCalled();
    expect(window(sqlite)).toMatchObject({ last_event_level: 'critical', observed_at: 102_000 });
  });

  it('records duplicate, stale, unknown, timestamp, and capacity outcomes through real SQL', async () => {
    const { sqlite, env } = createCredentialD1({ CREDENTIAL_LIMIT_ADMISSION_MAX_ACTIVE_PER_PROJECT: '1' });

    await expect(recordCredentialLimitObservation(env as never, baseObservation())).resolves.toMatchObject({
      outcome: 'event_admitted',
      transition: 'warning',
    });
    await expect(recordCredentialLimitObservation(env as never, baseObservation())).resolves.toEqual({
      outcome: 'ignored',
      reason: 'duplicate',
    });
    await expect(
      recordCredentialLimitObservation(env as never, baseObservation({ observedAt: 99_000, utilizationPercent: 95 }))
    ).resolves.toEqual({ outcome: 'ignored', reason: 'stale' });
    await expect(
      recordCredentialLimitObservation(env as never, baseObservation({ observedAt: 101_000, status: 'unknown', utilizationPercent: null }))
    ).resolves.toEqual({ outcome: 'ignored', reason: 'ok' });
    expect(window(sqlite)).toMatchObject({ last_event_level: 'warning', observed_at: 101_000 });
    await expect(
      recordCredentialLimitObservation(env as never, baseObservation({ observedAt: 102_000, utilizationPercent: 95 }))
    ).resolves.toEqual({ outcome: 'ignored', reason: 'capacity' });
    await expect(
      recordCredentialLimitObservation(env as never, baseObservation({ observedAt: 200_000 + 301_000 }))
    ).resolves.toEqual({ outcome: 'ignored', reason: 'future' });
    vi.setSystemTime(200_000 + 86_400_001);
    await expect(recordCredentialLimitObservation(env as never, baseObservation())).resolves.toEqual({
      outcome: 'ignored',
      reason: 'too_old',
    });
    expect(window(sqlite)).toMatchObject({ duplicate_sample_count: 1, stale_sample_count: 1 });
  });

  it('extracts supported OpenAI and Anthropic provider header evidence', () => {
    const observedAt = 100_000;
    const openAI = extractCredentialLimitObservationsFromHeaders(
      new Headers({
        'x-ratelimit-limit-tokens': '1000',
        'x-ratelimit-remaining-tokens': '100',
        'x-ratelimit-reset-tokens': '6m0s',
      }),
      {
        projectId: 'project-1',
        userId: 'user-1',
        credentialReference: 'platform_credentials:openai-1',
        credentialSource: 'platform',
        provider: 'openai',
        providerMode: 'platform-key',
        source: 'ai-proxy.openai.responses',
        responseStatus: 200,
        observedAt,
      }
    );
    expect(openAI).toMatchObject([
      {
        windowType: 'openai.tokens',
        utilizationPercent: 90,
        resetsAt: observedAt + parseOpenAIDurationMs('6m0s')!,
      },
    ]);

    const anthropic = extractCredentialLimitObservationsFromHeaders(
      new Headers({ 'retry-after': '2' }),
      {
        projectId: 'project-1',
        userId: 'user-1',
        credentialReference: 'platform_credentials:anthropic-1',
        credentialSource: 'platform',
        provider: 'anthropic',
        providerMode: 'platform-key',
        source: 'ai-proxy-anthropic.messages',
        responseStatus: 429,
        observedAt,
      }
    );
    expect(anthropic).toMatchObject([
      {
        windowType: 'anthropic.requests',
        status: 'rejected',
        resetsAt: observedAt + 2_000,
      },
    ]);
  });
});

describe('ACP usage callback credential verification', () => {
  function seedCallback() {
    vi.mocked(projectDataService.getAcpSession).mockResolvedValue({
      id: 'session-1',
      chatSessionId: 'chat-1',
      workspaceId: 'workspace-1',
      nodeId: 'node-1',
      acpSdkSessionId: 'sdk-1',
      status: 'running',
      agentType: 'claude-code',
    } as never);
    vi.mocked(jwtService.verifyCallbackToken).mockResolvedValue({
      scope: 'workspace',
      workspace: 'workspace-1',
    } as never);
  }

  it('records usage only against server-verified credential attribution', async () => {
    const { env } = createCredentialD1();
    seedCallback();

    const response = await handleAcpUsageCallback(makeContext(env), {
      projectId: 'project-1',
      sessionId: 'session-1',
      body: {
        nodeId: 'node-1',
        agentType: 'claude-code',
        credentialReference: 'cc_credentials:cred-1',
        credentialSource: 'user',
        observedAt: 100_000,
        source: 'claude-acp.usage_update',
        rateLimits: [
          {
            windowType: 'claude.five_hour',
            provider: 'anthropic',
            source: 'claude-acp.rate_limit',
            status: 'allowed_warning',
            utilizationPercent: 82,
            resetsAt: 120_000,
          },
        ],
      },
    });

    expect(response.status).toBe(204);
    expect(projectDataService.admitProjectEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(projectDataService.admitProjectEvent).mock.calls[0]![2]).toMatchObject({
      eventType: CREDENTIAL_LIMIT_EVENT_TYPES.warning,
      subject: { type: 'credential', id: 'cc_credentials:cred-1' },
      metadata: {
        credentialReference: 'cc_credentials:cred-1',
        affectedUserId: 'user-1',
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        serverReceivedAt: 100_000,
      },
    });
  });

  it('rejects forged credential attribution from the callback body', async () => {
    const { env } = createCredentialD1();
    seedCallback();

    await expect(
      handleAcpUsageCallback(makeContext(env), {
        projectId: 'project-1',
        sessionId: 'session-1',
        body: {
          nodeId: 'node-1',
          credentialReference: 'cc_credentials:attacker',
          rateLimits: [baseObservation({ windowType: 'claude.five_hour' })],
        } as never,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(projectDataService.admitProjectEvent).not.toHaveBeenCalled();
  });
});
