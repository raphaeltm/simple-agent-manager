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
import {
  type AcpUsageCallbackReport,
  handleAcpUsageCallback,
} from '../../src/services/acp-usage-callback-handler';
import {
  CREDENTIAL_LIMIT_EVENT_TYPES,
  type CredentialLimitObservation,
  extractCredentialLimitObservationsFromHeaders,
  parseOpenAIDurationMs,
  recordCredentialLimitObservation,
} from '../../src/services/credential-limit-events';
import { purgeExpiredCredentialLimitWindows } from '../../src/services/credential-limit-events/admissions';
import * as jwtService from '../../src/services/jwt';
import * as projectDataService from '../../src/services/project-data';
import { reconcileProjectEventSourceOutbox } from '../../src/services/project-event-source-outbox';
import { createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';
import { createSqlStorage } from './durable-objects/sql-storage-test-utils';

vi.mock('../../src/services/project-data', () => ({
  admitProjectEvent: vi.fn(async () => ({
    outcome: 'created',
    event: { id: 'event-1' },
    matches: [],
  })),
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
  KV: KVNamespace;
  CREDENTIAL_LIMIT_WARNING_PERCENT?: string;
  CREDENTIAL_LIMIT_CRITICAL_PERCENT?: string;
  CREDENTIAL_LIMIT_MAX_OBSERVATIONS_PER_REPORT?: string;
  CREDENTIAL_LIMIT_TRANSITION_RECOMPUTE_ATTEMPTS?: string;
  CREDENTIAL_LIMIT_OBSERVATION_MAX_AGE_MS?: string;
  CREDENTIAL_LIMIT_OBSERVATION_FUTURE_SKEW_MS?: string;
  CREDENTIAL_LIMIT_RESET_MAX_FUTURE_MS?: string;
  CREDENTIAL_LIMIT_USAGE_CALLBACK_MAX_BODY_BYTES?: string;
  CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_RPM?: string;
  CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_WINDOW_SECONDS?: string;
  CREDENTIAL_LIMIT_ADMISSION_MAX_ACTIVE_PER_PROJECT?: string;
  CREDENTIAL_LIMIT_ADMISSION_RETRY_BATCH_SIZE?: string;
  CREDENTIAL_LIMIT_ADMISSION_RETENTION_DAYS?: string;
  PROJECT_EVENT_SOURCE_OUTBOX_RETRY_BASE_MS?: string;
  PROJECT_EVENT_SOURCE_OUTBOX_RETRY_MAX_MS?: string;
  PROJECT_EVENT_SOURCE_OUTBOX_MAX_ATTEMPTS?: string;
  PROJECT_EVENT_SOURCE_OUTBOX_BATCH_ROWS?: string;
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
  state: string;
  admission_outcome: string | null;
  attempt_count: number;
  event_type: string;
  event_payload_json: string;
  last_error: string | null;
};

function migrationPath(name: string): string {
  return join(process.cwd(), 'src/db/migrations', name);
}

function createCredentialD1(overrides: Partial<TestEnv> = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL
    );
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
  sqlite.exec(readFileSync(migrationPath('0144_project_event_source_outbox.sql'), 'utf8'));
  sqlite.exec(readFileSync(migrationPath('0145_credential_limit_windows.sql'), 'utf8'));
  sqlite.exec(readFileSync(migrationPath('0146_credential_limit_event_admissions.sql'), 'utf8'));
  sqlite.exec(
    readFileSync(migrationPath('0148_project_event_source_outbox_durability.sql'), 'utf8')
  );
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
    KV: createMemoryKv(),
    CREDENTIAL_LIMIT_WARNING_PERCENT: '75',
    CREDENTIAL_LIMIT_CRITICAL_PERCENT: '90',
    PROJECT_EVENT_SOURCE_OUTBOX_RETRY_BASE_MS: '1',
    PROJECT_EVENT_SOURCE_OUTBOX_RETRY_MAX_MS: '1',
    ...overrides,
  } as TestEnv;
  return { sqlite, env };
}

function baseObservation(
  overrides: Partial<CredentialLimitObservation> = {}
): CredentialLimitObservation {
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
      `SELECT id, delivery_key, state, admission_outcome, attempt_count,
              event_type, event_payload_json, last_error
       FROM project_event_source_outbox
       ORDER BY created_at ASC, id ASC`
    )
    .all() as AdmissionRow[];
}

async function waitForProjectDataAdmissions(count: number): Promise<void> {
  const admitMock = vi.mocked(projectDataService.admitProjectEvent);
  await vi.waitFor(() => expect(admitMock).toHaveBeenCalledTimes(count));
}

function seedActiveSourceOutboxCapacity(sqlite: Database.Database) {
  sqlite
    .prepare(
      `INSERT INTO project_event_source_outbox (
        id, project_id, source, event_type, subject_type, subject_id, delivery_key,
        payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
        next_attempt_at, expires_at, created_at, updated_at,
        credential_limit_window_type, credential_limit_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'capacity-intent',
      'project-1',
      'sam.credential_limit',
      CREDENTIAL_LIMIT_EVENT_TYPES.warning,
      'credential',
      'cc_credentials:other',
      'capacity-key',
      'sha256:capacity',
      '{}',
      'pending',
      0,
      8,
      '2026-09-07T00:00:00.000Z',
      '2026-09-08T00:00:00.000Z',
      '2026-09-07T00:00:00.000Z',
      '2026-09-07T00:00:00.000Z',
      'claude.five_hour',
      100_000
    );
}

function failFirstAdmissionResultPersistence(database: D1Database): D1Database {
  let failed = false;
  return {
    ...database,
    prepare(sql: string) {
      const statement = database.prepare(sql);
      if (!sql.includes('admitted_event_id = ?') || !sql.includes('admission_outcome = ?')) {
        return statement;
      }
      return {
        ...statement,
        bind(...params: unknown[]) {
          const bound = statement.bind(...params);
          return {
            ...bound,
            async run() {
              if (!failed) {
                failed = true;
                throw new Error('injected D1 admission-result persistence failure');
              }
              return bound.run();
            },
          };
        },
      } as D1PreparedStatement;
    },
  } as D1Database;
}

function pauseFirstCredentialWindowUpdate(database: D1Database): {
  database: D1Database;
  waitUntilPaused: () => Promise<void>;
  release: () => void;
} {
  let paused = false;
  let releasePaused!: () => void;
  let markPaused!: () => void;
  const pausedPromise = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    releasePaused = resolve;
  });
  return {
    database: {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql);
        if (!sql.trimStart().startsWith('UPDATE credential_limit_windows') || paused) {
          return statement;
        }
        return {
          ...statement,
          bind(...params: unknown[]) {
            const bound = statement.bind(...params);
            return {
              ...bound,
              async run() {
                paused = true;
                markPaused();
                await releasePromise;
                return bound.run();
              },
            };
          },
        } as D1PreparedStatement;
      },
    } as D1Database,
    waitUntilPaused: () => pausedPromise,
    release: releasePaused,
  };
}

function createProjectEventStore() {
  const sqlite = new Database(':memory:');
  const sql = createSqlStorage(sqlite);
  runMigrations(sql);
  const env = { PROJECT_EVENT_RETENTION_DAYS: '30' } as ProjectDataEnv;
  return { sqlite, sql, env };
}

function makeContext(env: unknown, bodyHeaders: Record<string, string> = {}) {
  const requestHeaders = new Map(
    Object.entries({ Authorization: 'Bearer callback-token', ...bodyHeaders }).map(
      ([name, value]) => [name.toLowerCase(), value]
    )
  );
  const responseHeaders = new Headers();
  return {
    env,
    req: {
      header: (name: string) => requestHeaders.get(name.toLowerCase()),
    },
    header: (name: string, value: string) => {
      responseHeaders.set(name, value);
    },
    body: (body: BodyInit | null, status?: number) =>
      new Response(body, { status, headers: new Headers(responseHeaders) }),
    json: (body: unknown, status?: number) => {
      const headers = new Headers(responseHeaders);
      headers.set('Content-Type', 'application/json');
      return new Response(JSON.stringify(body), { status, headers });
    },
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.mocked(projectDataService.admitProjectEvent).mockReset();
  vi.mocked(projectDataService.admitProjectEvent).mockResolvedValue({
    outcome: 'created',
    event: { id: 'event-1' },
    matches: [],
  } as never);
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
      const subscription = createProjectEventSubscription(
        eventStore.sql,
        eventStore.env,
        'project-1',
        {
          projectId: 'project-1',
          owner: { type: 'agent', id: 'project-1:chat-1', name: 'session-1' },
          idempotencyKey: 'credential-subscription',
          filter: { version: 1, source: 'sam.credential_limit' },
          deliveryPreference: {
            requested: 'existing_session_prompt',
            resolved: 'queued_for_prompt_delivery',
            target: { sessionId: 'chat-1', taskId: null, runtimeId: null, agentId: 'session-1' },
          },
          expiresAt: 200_000,
        }
      ).subscription;
      vi.mocked(projectDataService.admitProjectEvent).mockImplementation(
        async (_env, projectId, input) =>
          admitProjectDataEvent(eventStore.sql, eventStore.env, projectId, { projectId, ...input })
      );

      await expect(
        recordCredentialLimitObservation(env as never, baseObservation())
      ).resolves.toMatchObject({
        outcome: 'event_admitted',
        transition: 'warning',
        admissionOutcome: 'created',
        dispatchOutcome: 'created',
      });

      const storedEvent = eventStore.sqlite.prepare('SELECT * FROM project_events').get() as Record<
        string,
        unknown
      >;
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

  it('recovers a persisted source intent after ProjectData accepts but D1 result recording fails', async () => {
    const { sqlite, env } = createCredentialD1();
    const failingEnv = {
      ...env,
      DATABASE: failFirstAdmissionResultPersistence(env.DATABASE),
    };
    vi.mocked(projectDataService.admitProjectEvent)
      .mockResolvedValueOnce({
        outcome: 'created',
        event: { id: 'event-accepted' },
        matches: [],
      } as never)
      .mockResolvedValueOnce({
        outcome: 'duplicate_replay',
        event: { id: 'event-accepted' },
        matches: [],
      } as never);

    await expect(
      recordCredentialLimitObservation(failingEnv as never, baseObservation())
    ).resolves.toMatchObject({
      outcome: 'event_admitted',
      transition: 'warning',
      dispatchOutcome: 'deferred',
    });
    expect(admissions(sqlite)).toEqual([
      expect.objectContaining({
        event_type: CREDENTIAL_LIMIT_EVENT_TYPES.warning,
        state: 'retryable_failed',
        attempt_count: 1,
      }),
    ]);

    await expect(
      reconcileProjectEventSourceOutbox(failingEnv as never, { now: new Date(102_000) })
    ).resolves.toMatchObject({ attempted: 1, admitted: 1 });

    const firstPayload = vi.mocked(projectDataService.admitProjectEvent).mock.calls[0]![2];
    const retryPayload = vi.mocked(projectDataService.admitProjectEvent).mock.calls[1]![2];
    expect(retryPayload.deliveryKey).toBe(firstPayload.deliveryKey);
    expect(retryPayload.payloadFingerprint).toBe(firstPayload.payloadFingerprint);
    expect(admissions(sqlite)).toEqual([
      expect.objectContaining({
        event_type: CREDENTIAL_LIMIT_EVENT_TYPES.warning,
        state: 'admitted',
        admission_outcome: 'duplicate_replay',
        attempt_count: 2,
      }),
    ]);
  });

  it('recomputes against the replaced predecessor so a delayed ok emits reset after newer critical', async () => {
    const { sqlite, env } = createCredentialD1();
    const eventStore = createProjectEventStore();
    try {
      vi.mocked(projectDataService.admitProjectEvent).mockImplementation(
        async (_env, projectId, input) =>
          admitProjectDataEvent(eventStore.sql, eventStore.env, projectId, { projectId, ...input })
      );

      await expect(
        recordCredentialLimitObservation(
          env as never,
          baseObservation({ observedAt: 100_000, utilizationPercent: 10, status: 'allowed' })
        )
      ).resolves.toEqual({ outcome: 'ignored', reason: 'ok' });

      const paused = pauseFirstCredentialWindowUpdate(env.DATABASE);
      const delayedOk = recordCredentialLimitObservation(
        { ...env, DATABASE: paused.database } as never,
        baseObservation({ observedAt: 102_000, utilizationPercent: 10, status: 'allowed' })
      );
      await paused.waitUntilPaused();

      await expect(
        recordCredentialLimitObservation(
          env as never,
          baseObservation({
            observedAt: 101_000,
            utilizationPercent: 95,
            status: 'allowed_warning',
          })
        )
      ).resolves.toMatchObject({ outcome: 'event_admitted', transition: 'critical' });

      paused.release();
      await expect(delayedOk).resolves.toMatchObject({
        outcome: 'event_admitted',
        transition: 'reset',
        dispatchOutcome: 'created',
      });

      expect(window(sqlite)).toMatchObject({ last_event_level: 'ok', observed_at: 102_000 });
      expect(admissions(sqlite)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: CREDENTIAL_LIMIT_EVENT_TYPES.critical,
            state: 'admitted',
          }),
          expect.objectContaining({
            event_type: CREDENTIAL_LIMIT_EVENT_TYPES.reset,
            state: 'admitted',
          }),
        ])
      );
      expect(
        eventStore.sqlite
          .prepare('SELECT event_type FROM project_events ORDER BY occurred_at ASC, id ASC')
          .all()
      ).toEqual([
        { event_type: CREDENTIAL_LIMIT_EVENT_TYPES.critical },
        { event_type: CREDENTIAL_LIMIT_EVENT_TYPES.reset },
      ]);
    } finally {
      eventStore.sqlite.close();
    }
  });

  it('captures D1 admission before ProjectData and suppresses superseded stale retry', async () => {
    const { sqlite, env } = createCredentialD1();
    const eventStore = createProjectEventStore();
    vi.mocked(projectDataService.admitProjectEvent)
      .mockImplementation(async (_env, projectId, input) =>
        admitProjectDataEvent(eventStore.sql, eventStore.env, projectId, { projectId, ...input }))
      .mockRejectedValueOnce(new Error('ProjectData unavailable'));

    const critical = await recordCredentialLimitObservation(
      env as never,
      baseObservation({ observedAt: 100_000, utilizationPercent: 95 })
    );
    expect(critical).toMatchObject({
      outcome: 'event_admitted',
      transition: 'critical',
      dispatchOutcome: 'deferred',
    });
    expect(window(sqlite)).toMatchObject({ last_event_level: 'critical', observed_at: 100_000 });
    expect(
      admissions(sqlite).find((row) => row.event_type === CREDENTIAL_LIMIT_EVENT_TYPES.critical)
    ).toMatchObject({
      state: 'retryable_failed',
      attempt_count: 1,
    });

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
    await expect(
      reconcileProjectEventSourceOutbox(env as never, { now: new Date(102_000) })
    ).resolves.toMatchObject({
      attempted: 1,
      permanentFailed: 1,
    });
    expect(projectDataService.admitProjectEvent).toHaveBeenCalledTimes(1);
    expect(
      admissions(sqlite).find((row) => row.event_type === CREDENTIAL_LIMIT_EVENT_TYPES.critical)
    ).toMatchObject({
      state: 'permanent_failed',
      last_error: 'ProjectData admission conflict',
    });
    eventStore.sqlite.close();
  });

  it('does not emit an older reset after a newer critical edge is current', async () => {
    const { sqlite, env } = createCredentialD1();
    const eventStore = createProjectEventStore();
    vi.mocked(projectDataService.admitProjectEvent).mockImplementation(async (_env, projectId, input) =>
      admitProjectDataEvent(eventStore.sql, eventStore.env, projectId, { projectId, ...input }));
    await recordCredentialLimitObservation(
      env as never,
      baseObservation({ observedAt: 100_000, utilizationPercent: 80 })
    );

    vi.mocked(projectDataService.admitProjectEvent).mockRejectedValueOnce(
      new Error('ProjectData unavailable')
    );
    await expect(
      recordCredentialLimitObservation(
        env as never,
        baseObservation({ observedAt: 101_000, utilizationPercent: 10, status: 'allowed' })
      )
    ).resolves.toMatchObject({ transition: 'reset', dispatchOutcome: 'deferred' });

    await expect(
      recordCredentialLimitObservation(
        env as never,
        baseObservation({ observedAt: 102_000, utilizationPercent: 96 })
      )
    ).resolves.toMatchObject({ transition: 'critical', dispatchOutcome: 'created' });

    vi.mocked(projectDataService.admitProjectEvent).mockClear();
    await expect(
      reconcileProjectEventSourceOutbox(env as never, { now: new Date(103_000) })
    ).resolves.toMatchObject({
      attempted: 1,
      skipped: 0,
    });
    expect(projectDataService.admitProjectEvent).toHaveBeenCalledTimes(1);
    expect(window(sqlite)).toMatchObject({ last_event_level: 'critical', observed_at: 102_000 });
    expect(
      admissions(sqlite).find((row) => row.event_type === CREDENTIAL_LIMIT_EVENT_TYPES.reset)
    ).toMatchObject({
      state: 'permanent_failed',
    });
    eventStore.sqlite.close();
  });

  it('preserves a live reset claim and lets canonical admission fence it behind newer critical', async () => {
    const { sqlite, env } = createCredentialD1();
    const eventStore = createProjectEventStore();
    const releaseReset = {
      resolve: () => undefined as void,
    };
    const resetGate = new Promise<void>((resolve) => {
      releaseReset.resolve = resolve;
    });
    try {
      vi.mocked(projectDataService.admitProjectEvent).mockImplementation(
        async (_env, projectId, input) => {
          if (
            input.eventType === CREDENTIAL_LIMIT_EVENT_TYPES.reset &&
            input.metadata?.observedAt === 101_000
          ) {
            await resetGate;
          }
          return admitProjectDataEvent(eventStore.sql, eventStore.env, projectId, {
            projectId,
            ...input,
          });
        }
      );

      await expect(
        recordCredentialLimitObservation(env as never, baseObservation())
      ).resolves.toMatchObject({
        outcome: 'event_admitted',
        transition: 'warning',
        dispatchOutcome: 'created',
      });

      vi.setSystemTime(101_000);
      const delayedReset = recordCredentialLimitObservation(
        env as never,
        baseObservation({ observedAt: 101_000, utilizationPercent: 10, status: 'allowed' })
      );
      await waitForProjectDataAdmissions(2);
      const liveReset = sqlite
        .prepare(
          `SELECT state, claim_token, terminalized_at
             FROM project_event_source_outbox
            WHERE event_type = ?`
        )
        .get(CREDENTIAL_LIMIT_EVENT_TYPES.reset) as {
        state: string;
        claim_token: string | null;
        terminalized_at: string | null;
      };
      expect(liveReset.state).toBe('processing');
      expect(liveReset.claim_token).toEqual(expect.any(String));
      expect(liveReset.terminalized_at).toBeNull();

      vi.setSystemTime(102_000);
      await expect(
        recordCredentialLimitObservation(
          env as never,
          baseObservation({
            observedAt: 102_000,
            utilizationPercent: 96,
            status: 'allowed_warning',
          })
        )
      ).resolves.toMatchObject({
        outcome: 'event_admitted',
        transition: 'critical',
        dispatchOutcome: 'created',
      });
      expect(
        sqlite
          .prepare(
            `SELECT state, claim_token, terminalized_at
               FROM project_event_source_outbox
              WHERE event_type = ?`
          )
          .get(CREDENTIAL_LIMIT_EVENT_TYPES.reset)
      ).toMatchObject({
        state: 'processing',
        claim_token: liveReset.claim_token,
        terminalized_at: null,
      });

      releaseReset.resolve();
      await expect(delayedReset).resolves.toMatchObject({
        outcome: 'event_admitted',
        transition: 'reset',
        admissionOutcome: 'created',
        dispatchOutcome: 'conflict',
      });
      expect(window(sqlite)).toMatchObject({
        last_event_level: 'critical',
        observed_at: 102_000,
      });
      expect(
        admissions(sqlite).find((row) => row.event_type === CREDENTIAL_LIMIT_EVENT_TYPES.reset)
      ).toMatchObject({
        state: 'permanent_failed',
        admission_outcome: 'conflict',
        last_error: 'ProjectData admission conflict',
      });
    } finally {
      eventStore.sqlite.close();
    }
  });

  it('does not consume a credential edge when source-outbox capacity is full, and admits after release', async () => {
    const { sqlite, env } = createCredentialD1({
      CREDENTIAL_LIMIT_ADMISSION_MAX_ACTIVE_PER_PROJECT: '1',
    });

    await expect(
      recordCredentialLimitObservation(env as never, baseObservation())
    ).resolves.toMatchObject({
      outcome: 'event_admitted',
      transition: 'warning',
    });
    const warningDeliveryKey = window(sqlite)?.last_event_delivery_key;
    seedActiveSourceOutboxCapacity(sqlite);

    await expect(
      recordCredentialLimitObservation(
        env as never,
        baseObservation({ observedAt: 102_000, utilizationPercent: 95 })
      )
    ).resolves.toEqual({ outcome: 'ignored', reason: 'capacity' });
    expect(window(sqlite)).toMatchObject({
      last_event_level: 'warning',
      observed_at: 100_000,
      last_event_delivery_key: warningDeliveryKey,
    });
    expect(
      admissions(sqlite).filter((row) => row.event_type === CREDENTIAL_LIMIT_EVENT_TYPES.critical)
    ).toEqual([]);

    sqlite
      .prepare("UPDATE project_event_source_outbox SET state = 'admitted' WHERE id = ?")
      .run('capacity-intent');

    await expect(
      recordCredentialLimitObservation(
        env as never,
        baseObservation({ observedAt: 102_000, utilizationPercent: 95 })
      )
    ).resolves.toMatchObject({
      outcome: 'event_admitted',
      transition: 'critical',
      dispatchOutcome: 'created',
    });
    expect(window(sqlite)).toMatchObject({ last_event_level: 'critical', observed_at: 102_000 });
  });

  it('uses a global seekable retention path when no credential windows are due', async () => {
    const { sqlite, env } = createCredentialD1({
      CREDENTIAL_LIMIT_ADMISSION_RETRY_BATCH_SIZE: '10',
      CREDENTIAL_LIMIT_ADMISSION_RETENTION_DAYS: '30',
    });
    const insert = sqlite.prepare(
      `INSERT INTO credential_limit_windows
        (project_id, credential_reference, window_type, credential_source, provider,
         provider_mode, user_id, source, status, last_event_level, observed_at,
         freshness_ms, duplicate_sample_count, stale_sample_count, created_at, updated_at)
       VALUES ('project-1', ?, 'claude.five_hour', 'user', 'anthropic', 'direct',
        'user-1', 'claude-acp.rate_limit', 'allowed', 'ok', ?, 0, 0, 0, ?, ?)`
    );
    const seed = sqlite.transaction(() => {
      for (let index = 0; index < 20_000; index += 1) {
        insert.run(`cc_credentials:fresh-${index}`, 100_000 + index, 100_000, 100_000);
      }
    });
    seed();

    const cutoff = 100_000 - 30 * 24 * 60 * 60_000;
    const plan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM credential_limit_windows
          WHERE rowid IN (
            SELECT rowid
              FROM credential_limit_windows
             WHERE updated_at <= ?
             ORDER BY updated_at ASC, project_id ASC, credential_reference ASC, window_type ASC
             LIMIT ?
          )`
      )
      .all(cutoff, 10) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toContain('idx_credential_limit_windows_updated_global');
    expect(details).not.toContain('USE TEMP B-TREE');

    await expect(
      purgeExpiredCredentialLimitWindows(env as never, 100_000, {
        admissionRetryBatchSize: 10,
        admissionRetentionDays: 30,
      })
    ).resolves.toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM credential_limit_windows').get()).toEqual({
      count: 20_000,
    });
  });

  it('records duplicate, stale, unknown, and timestamp outcomes through real SQL', async () => {
    const { sqlite, env } = createCredentialD1();

    await expect(
      recordCredentialLimitObservation(env as never, baseObservation())
    ).resolves.toMatchObject({
      outcome: 'event_admitted',
      transition: 'warning',
    });
    await expect(
      recordCredentialLimitObservation(env as never, baseObservation())
    ).resolves.toEqual({
      outcome: 'ignored',
      reason: 'duplicate',
    });
    await expect(
      recordCredentialLimitObservation(
        env as never,
        baseObservation({ observedAt: 99_000, utilizationPercent: 95 })
      )
    ).resolves.toEqual({ outcome: 'ignored', reason: 'stale' });
    await expect(
      recordCredentialLimitObservation(
        env as never,
        baseObservation({ observedAt: 101_000, status: 'unknown', utilizationPercent: null })
      )
    ).resolves.toEqual({ outcome: 'ignored', reason: 'ok' });
    expect(window(sqlite)).toMatchObject({ last_event_level: 'warning', observed_at: 101_000 });
    await expect(
      recordCredentialLimitObservation(
        env as never,
        baseObservation({ observedAt: 200_000 + 301_000 })
      )
    ).resolves.toEqual({ outcome: 'ignored', reason: 'future' });
    vi.setSystemTime(200_000 + 86_400_001);
    await expect(
      recordCredentialLimitObservation(env as never, baseObservation())
    ).resolves.toEqual({
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
        credentialGeneration: 1,
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

  it('rate limits authenticated callbacks before repeated session lookup work', async () => {
    const { env } = createCredentialD1({
      CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_RPM: '1',
      CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_WINDOW_SECONDS: '60',
    });
    seedCallback();

    const body: AcpUsageCallbackReport = {
      nodeId: 'node-1',
      agentType: 'claude-code',
      credentialReference: 'cc_credentials:cred-1',
      credentialSource: 'user',
      credentialGeneration: 1,
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
    };

    const first = await handleAcpUsageCallback(makeContext(env), {
      projectId: 'project-1',
      sessionId: 'session-1',
      body,
    });
    expect(first.status).toBe(204);
    const second = await handleAcpUsageCallback(makeContext(env), {
      projectId: 'project-1',
      sessionId: 'session-1',
      body,
    });
    expect(second.status).toBe(429);
    expect(projectDataService.getAcpSession).toHaveBeenCalledTimes(1);
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

  it('rejects missing or stale credential generations at the callback boundary', async () => {
    const { env } = createCredentialD1();
    seedCallback();

    await expect(
      handleAcpUsageCallback(makeContext(env), {
        projectId: 'project-1',
        sessionId: 'session-1',
        body: {
          nodeId: 'node-1',
          credentialReference: 'cc_credentials:cred-1',
          credentialSource: 'user',
          rateLimits: [baseObservation({ windowType: 'claude.five_hour' })],
        } as never,
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      handleAcpUsageCallback(makeContext(env), {
        projectId: 'project-1',
        sessionId: 'session-1',
        body: {
          nodeId: 'node-1',
          credentialReference: 'cc_credentials:cred-1',
          credentialSource: 'user',
          credentialGeneration: 0,
          rateLimits: [baseObservation({ windowType: 'claude.five_hour' })],
        },
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(projectDataService.admitProjectEvent).not.toHaveBeenCalled();
  });

  it('rate limits callbacks by verified token identity instead of body node identity', async () => {
    const { env } = createCredentialD1({
      CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_RPM: '1',
      CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_WINDOW_SECONDS: '60',
    });
    seedCallback();

    const first = await handleAcpUsageCallback(makeContext(env), {
      projectId: 'project-1',
      sessionId: 'session-1',
      body: {
        nodeId: 'node-1',
        credentialReference: 'cc_credentials:cred-1',
        credentialSource: 'user',
        credentialGeneration: 1,
        rateLimits: [baseObservation({ windowType: 'claude.five_hour' })],
      },
    });
    expect(first.status).toBe(204);

    const second = await handleAcpUsageCallback(makeContext(env), {
      projectId: 'project-1',
      sessionId: 'session-1',
      body: {
        nodeId: 'node-attacker-controlled',
        credentialReference: 'cc_credentials:cred-1',
        credentialSource: 'user',
        credentialGeneration: 1,
        rateLimits: [baseObservation({ windowType: 'claude.five_hour' })],
      },
    });
    expect(second.status).toBe(429);
    expect(projectDataService.getAcpSession).toHaveBeenCalledTimes(1);
  });
});
