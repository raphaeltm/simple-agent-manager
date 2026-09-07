import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleAcpUsageCallback } from '../../src/services/acp-usage-callback-handler';
import {
  CREDENTIAL_LIMIT_EVENT_TYPES,
  type CredentialLimitObservation,
  extractCredentialLimitObservationsFromHeaders,
  parseOpenAIDurationMs,
  recordCredentialLimitObservation,
} from '../../src/services/credential-limit-events';
import * as jwtService from '../../src/services/jwt';
import * as projectDataService from '../../src/services/project-data';

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

type WindowRow = {
  status: string;
  last_event_level: string;
  utilization_percent: number | null;
  limit_amount: number | null;
  remaining_amount: number | null;
  window_minutes: number | null;
  resets_at: number | null;
  observed_at: number;
  stale_sample_count: number;
  duplicate_sample_count: number;
};

type AgentAttributionRow = {
  id: string;
  user_id: string;
  agent_type: string | null;
  agent_credential_reference: string | null;
  agent_credential_source: string | null;
  agent_credential_provider: string | null;
  agent_provider_mode: string | null;
  workspace_id: string;
  workspace_project_id: string | null;
  workspace_chat_session_id: string | null;
  workspace_node_id: string | null;
};

class FakeStatement {
  private readonly values: unknown[] = [];

  constructor(
    private readonly db: FakeD1Database,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): FakeStatement {
    this.values.splice(0, this.values.length, ...values);
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM credential_limit_windows')) {
      return (this.db.windows.get(windowKey(this.values)) as T | undefined) ?? null;
    }
    if (this.sql.includes('FROM agent_sessions s')) {
      const [sessionId, workspaceId, projectId] = this.values as [string, string, string];
      const row = this.db.agentRows.get(sessionId);
      if (
        row &&
        row.workspace_id === workspaceId &&
        row.workspace_project_id === projectId
      ) {
        return row as T;
      }
      return null;
    }
    throw new Error(`Unexpected first() SQL: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes('stale_sample_count = MIN')) {
      const row = this.db.windows.get(windowKey(this.values.slice(1)));
      if (row) row.stale_sample_count += 1;
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (this.sql.includes('duplicate_sample_count = MIN')) {
      const row = this.db.windows.get(windowKey(this.values.slice(1)));
      if (row) row.duplicate_sample_count += 1;
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (this.sql.includes('INSERT INTO credential_limit_windows')) {
      const [
        projectId,
        credentialReference,
        windowType,
        ,
        ,
        ,
        ,
        ,
        ,
        ,
        ,
        ,
        status,
        lastEventLevel,
        utilizationPercent,
        limitAmount,
        remainingAmount,
        windowMinutes,
        resetsAt,
        observedAt,
      ] = this.values;
      const key = `${projectId}\0${credentialReference}\0${windowType}`;
      const existing = this.db.windows.get(key);
      if (!existing || Number(observedAt) > existing.observed_at) {
        this.db.windows.set(key, {
          status: String(status),
          last_event_level: String(lastEventLevel),
          utilization_percent: utilizationPercent === null ? null : Number(utilizationPercent),
          limit_amount: limitAmount === null ? null : Number(limitAmount),
          remaining_amount: remainingAmount === null ? null : Number(remainingAmount),
          window_minutes: windowMinutes === null ? null : Number(windowMinutes),
          resets_at: resetsAt === null ? null : Number(resetsAt),
          observed_at: Number(observedAt),
          stale_sample_count: existing?.stale_sample_count ?? 0,
          duplicate_sample_count: existing?.duplicate_sample_count ?? 0,
        });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    throw new Error(`Unexpected run() SQL: ${this.sql}`);
  }
}

class FakeD1Database {
  readonly windows = new Map<string, WindowRow>();
  readonly agentRows = new Map<string, AgentAttributionRow>();

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

function windowKey(values: unknown[]): string {
  const [projectId, credentialReference, windowType] = values;
  return `${projectId}\0${credentialReference}\0${windowType}`;
}

function makeEnv(db = new FakeD1Database()) {
  return {
    DATABASE: db,
    CREDENTIAL_LIMIT_WARNING_PERCENT: '75',
    CREDENTIAL_LIMIT_CRITICAL_PERCENT: '90',
  } as never;
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
    observedAt: 1_000,
    status: 'allowed',
    utilizationPercent: 80,
    resetsAt: 20_000,
    freshnessMs: 0,
    workspaceId: 'workspace-1',
    agentSessionId: 'session-1',
    chatSessionId: 'chat-1',
    agentType: 'claude-code',
    ...overrides,
  };
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
  vi.mocked(projectDataService.admitProjectEvent).mockClear();
  vi.mocked(projectDataService.getAcpSession).mockReset();
  vi.mocked(jwtService.verifyCallbackToken).mockReset();
});

describe('credential limit producer', () => {
  it('emits edge transitions and suppresses duplicate and stale samples', async () => {
    const db = new FakeD1Database();
    const env = makeEnv(db);

    await expect(recordCredentialLimitObservation(env, baseObservation())).resolves.toMatchObject({
      outcome: 'event_admitted',
      transition: 'warning',
    });
    await expect(recordCredentialLimitObservation(env, baseObservation())).resolves.toEqual({
      outcome: 'ignored',
      reason: 'duplicate',
    });
    await expect(
      recordCredentialLimitObservation(
        env,
        baseObservation({ observedAt: 900, utilizationPercent: 95 })
      )
    ).resolves.toEqual({ outcome: 'ignored', reason: 'stale' });
    await expect(
      recordCredentialLimitObservation(
        env,
        baseObservation({ observedAt: 2_000, utilizationPercent: 95 })
      )
    ).resolves.toMatchObject({ outcome: 'event_admitted', transition: 'critical' });
    await expect(
      recordCredentialLimitObservation(
        env,
        baseObservation({ observedAt: 3_000, utilizationPercent: 96 })
      )
    ).resolves.toEqual({ outcome: 'ignored', reason: 'ok' });
    await expect(
      recordCredentialLimitObservation(
        env,
        baseObservation({ observedAt: 4_000, utilizationPercent: 10 })
      )
    ).resolves.toMatchObject({ outcome: 'event_admitted', transition: 'reset' });

    const eventTypes = vi
      .mocked(projectDataService.admitProjectEvent)
      .mock.calls.map(([, , event]) => event.eventType);
    expect(eventTypes).toEqual([
      CREDENTIAL_LIMIT_EVENT_TYPES.warning,
      CREDENTIAL_LIMIT_EVENT_TYPES.critical,
      CREDENTIAL_LIMIT_EVENT_TYPES.reset,
    ]);

    const row = db.windows.get('project-1\0cc_credentials:cred-1\0claude.five_hour');
    expect(row?.duplicate_sample_count).toBe(1);
    expect(row?.stale_sample_count).toBe(1);
    expect(row?.last_event_level).toBe('ok');
  });

  it('extracts supported OpenAI and Anthropic provider header evidence', () => {
    const observedAt = 10_000;
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
  function seedCallback(db: FakeD1Database, overrides: Partial<AgentAttributionRow> = {}) {
    db.agentRows.set('session-1', {
      id: 'session-1',
      user_id: 'user-1',
      agent_type: 'claude-code',
      agent_credential_reference: 'cc_credentials:cred-1',
      agent_credential_source: 'user',
      agent_credential_provider: 'anthropic',
      agent_provider_mode: 'direct',
      workspace_id: 'workspace-1',
      workspace_project_id: 'project-1',
      workspace_chat_session_id: 'chat-1',
      workspace_node_id: 'node-1',
      ...overrides,
    });
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
    const db = new FakeD1Database();
    const env = makeEnv(db);
    seedCallback(db);

    const response = await handleAcpUsageCallback(makeContext(env), {
      projectId: 'project-1',
      sessionId: 'session-1',
      body: {
        nodeId: 'node-1',
        agentType: 'claude-code',
        credentialReference: 'cc_credentials:cred-1',
        credentialSource: 'user',
        observedAt: 1_000,
        source: 'claude-acp.usage_update',
        rateLimits: [
          {
            windowType: 'claude.five_hour',
            provider: 'anthropic',
            source: 'claude-acp.rate_limit',
            status: 'allowed_warning',
            utilizationPercent: 82,
            resetsAt: 20_000,
            freshnessMs: 0,
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
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
      },
    });
  });

  it('rejects forged credential attribution from the callback body', async () => {
    const db = new FakeD1Database();
    const env = makeEnv(db);
    seedCallback(db);

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

  it('rejects project/session isolation mismatches before emitting events', async () => {
    const db = new FakeD1Database();
    const env = makeEnv(db);
    seedCallback(db, { workspace_project_id: 'project-2' });

    await expect(
      handleAcpUsageCallback(makeContext(env), {
        projectId: 'project-1',
        sessionId: 'session-1',
        body: {
          nodeId: 'node-1',
          rateLimits: [
            {
              windowType: 'claude.five_hour',
              status: 'allowed_warning',
              utilizationPercent: 80,
            },
          ],
        },
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(projectDataService.admitProjectEvent).not.toHaveBeenCalled();
  });
});
