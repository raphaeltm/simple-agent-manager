/**
 * The `gcp_price_table` step end to end: the real `scheduled()` handler, the real sweep isolator,
 * the real price refresh against credentials in a real SQLite engine, and Google's own error
 * bodies parsed by the real `providerFetch`. Only the token exchange and the other sweeps are
 * stubbed. A user's Google project with Cloud Billing turned off is theirs to fix and must not
 * page operators; a fault in SAM's own call must.
 */
import { Buffer } from 'node:buffer';

import { GCP_CLOUD_BILLING_SERVICE } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { encrypt } from '../../../src/services/encryption';
import { listGcpApiIssues } from '../../../src/services/gcp-api-health';
import { serializeGcpCredential } from '../../../src/services/provider-credential-codecs';
import {
  googleErrorResponse,
  googleScopeInsufficientBody,
  googleServiceDisabledBody,
} from '../../helpers/google-api-errors';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const { notifyFailedSweepsMock } = vi.hoisted(() => ({
  notifyFailedSweepsMock: vi.fn(async () => ({ notifiedSweeps: 0, notificationsSent: 0 })),
}));

vi.mock('../../../src/services/operational-kill-switch', () => ({
  isOperationalLoopEnabled: vi.fn(async () => true),
}));
vi.mock('../../../src/scheduled/platform-feedback-hourly', () => ({
  isHourlyPlatformMaintenanceCron: vi.fn(() => false),
  scheduleHourlyPlatformMaintenance: vi.fn(() => false),
}));
vi.mock('../../../src/scheduled/sweep-isolation', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/scheduled/sweep-isolation')>();
  return {
    createSweepIsolator: vi.fn((env: Parameters<typeof real.createSweepIsolator>[0]) => {
      const isolator = real.createSweepIsolator(env);
      return {
        ...isolator,
        // Only the step under test runs; every other sweep reports "no data this tick".
        isolate: (name: string, fn: () => Promise<unknown>) =>
          name === 'gcp_price_table' ? isolator.isolate(name, fn) : Promise.resolve(undefined),
      };
    }),
  };
});
vi.mock('../../../src/services/observability', () => ({ persistError: vi.fn() }));
vi.mock('../../../src/scheduled/failed-sweep-notifications', () => ({
  notifyFailedSweeps: notifyFailedSweepsMock,
}));
vi.mock('../../../src/services/gcp-sts', () => ({
  getGcpAccessToken: async (
    _userId: string,
    _projectId: string,
    credential: { gcpProjectId: string }
  ) => `token-for-${credential.gcpProjectId}`,
}));

const { scheduled } = await import('../../../src/scheduled/handler');

const KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const controller = { cron: '*/5 * * * *' } as ScheduledController;
const context = { waitUntil: vi.fn() } as unknown as ExecutionContext;

function credentialJson(gcpProjectId: string) {
  return serializeGcpCredential({
    version: 1,
    provider: 'gcp',
    authType: 'workload-identity',
    gcpProjectId,
    gcpProjectNumber: '123456',
    serviceAccountEmail: `sam@${gcpProjectId}.iam.gserviceaccount.com`,
    wifPoolId: 'sam-pool',
    wifProviderId: 'sam-provider',
    defaultZone: 'us-central1-a',
  });
}

describe('scheduled gcp_price_table step against real Google error bodies', () => {
  const originalFetch = globalThis.fetch;
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(async () => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('user-1', 'u@example.com', 'U', ?, ?)`
      )
      .run(now, now);
    const { ciphertext, iv } = await encrypt(credentialJson('owner-gcp'), KEY);
    sqlite
      .prepare(
        `INSERT INTO credentials (id, user_id, project_id, provider, credential_type, is_active, encrypted_token, iv, created_at, updated_at)
         VALUES ('cred-1', 'user-1', NULL, 'gcp', 'cloud-provider', 1, ?, ?, ?, ?)`
      )
      .run(ciphertext, iv, now, now);
    env = {
      DATABASE: createSqliteD1(sqlite),
      OBSERVABILITY_DATABASE: {},
      KV: createMemoryKv(),
      ENCRYPTION_KEY: KEY,
    } as unknown as Env;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    sqlite.close();
  });

  function billingAnswers(body: unknown) {
    const fetchMock = vi.fn(async () => googleErrorResponse(body));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it("does not report Cloud Billing turned off in the owner's project as a failed sweep", async () => {
    const fetchMock = billingAnswers(googleServiceDisabledBody(GCP_CLOUD_BILLING_SERVICE));

    await scheduled(controller, env, context);

    // Liveness: the refresh really called Google, so the empty list is a verdict.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notifyFailedSweepsMock).toHaveBeenCalledWith(env, []);
    // The problem went to the owner's credential instead.
    const issues = await listGcpApiIssues(env, 'cred-1', JSON.parse(credentialJson('owner-gcp')));
    expect(issues).toMatchObject([{ service: GCP_CLOUD_BILLING_SERVICE, reason: 'api_disabled' }]);
  });

  it("reports a fault in SAM's own call (insufficient token scope) as a failed sweep", async () => {
    const fetchMock = billingAnswers(googleScopeInsufficientBody(GCP_CLOUD_BILLING_SERVICE));

    await scheduled(controller, env, context);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notifyFailedSweepsMock).toHaveBeenCalledWith(env, ['gcp_price_table']);
  });
});
