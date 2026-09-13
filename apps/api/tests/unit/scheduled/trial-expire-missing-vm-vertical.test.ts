import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const {
  nodeRows,
  drizzleUpdates,
  providerGetVM,
  providerDeleteVM,
  createProviderForUser,
  deleteDNSRecord,
  persistError,
  stopSession,
  cleanupWorkspaceActivity,
} = vi.hoisted(() => ({
  nodeRows: [] as Array<Record<string, unknown>>,
  drizzleUpdates: [] as Array<Record<string, unknown>>,
  providerGetVM: vi.fn(),
  providerDeleteVM: vi.fn(async () => {}),
  createProviderForUser: vi.fn(),
  deleteDNSRecord: vi.fn(async () => {}),
  persistError: vi.fn(async () => {}),
  stopSession: vi.fn(async () => {}),
  cleanupWorkspaceActivity: vi.fn(async () => {}),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => {
      const builder = {
        from: () => builder,
        where: () => builder,
        limit: () => Promise.resolve(nodeRows),
      };
      return builder;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          let execution: Promise<{ meta: { changes: number } }> | undefined;
          const execute = () => {
            if (!execution) {
              drizzleUpdates.push(values);
              if (
                nodeRows[0] &&
                (typeof values.runtimeTerminationConfirmedAt === 'string' ||
                  (values.status === 'destroying' && values.healthStatus === 'stale'))
              ) {
                nodeRows[0] = { ...nodeRows[0], ...values };
              }
              execution = Promise.resolve({ meta: { changes: 1 } });
            }
            return execution;
          };
          return {
            run: execute,
            then: <TResult1 = { meta: { changes: number } }, TResult2 = never>(
              onfulfilled?:
                | ((value: { meta: { changes: number } }) => TResult1 | PromiseLike<TResult1>)
                | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
            ) => execute().then(onfulfilled, onrejected),
          };
        },
      }),
    }),
  }),
}));

vi.mock('../../../src/services/provider-credentials', () => ({
  createProviderForUser: (...args: unknown[]) => createProviderForUser(...args),
  exactProviderCredentialBindingFromPlacementSnapshot: (snapshot: {
    placementCredentialSource?: string | null;
    placementCredentialReference?: string | null;
    placementCredentialVersion?: number | null;
    placementCredentialFingerprint?: string | null;
  }) =>
    snapshot.placementCredentialSource && snapshot.placementCredentialReference
      ? {
          credentialSource: snapshot.placementCredentialSource,
          credentialReference: snapshot.placementCredentialReference,
          credentialVersion: snapshot.placementCredentialVersion ?? null,
          credentialFingerprint: snapshot.placementCredentialFingerprint ?? null,
        }
      : null,
}));
vi.mock('../../../src/lib/secrets', () => ({ getCredentialEncryptionKey: () => 'test-key' }));
vi.mock('../../../src/services/dns', () => ({
  deleteDNSRecord: (...args: unknown[]) => deleteDNSRecord(...args),
  createNodeBackendDNSRecord: vi.fn(),
}));
vi.mock('../../../src/services/observability', () => ({
  persistError: (...args: unknown[]) => persistError(...args),
}));
vi.mock('../../../src/services/project-data', () => ({
  stopSession: (...args: unknown[]) => stopSession(...args),
  cleanupWorkspaceActivity: (...args: unknown[]) => cleanupWorkspaceActivity(...args),
}));
vi.mock('../../../src/services/node-agent', () => ({ deleteWorkspaceOnNode: vi.fn() }));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn((err: unknown) => ({ error: String(err) })),
}));

const { runTrialExpireSweep } = await import('../../../src/scheduled/trial-expire');

describe('expired-trial exact provider deletion vertical slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nodeRows.length = 0;
    drizzleUpdates.length = 0;
    nodeRows.push({
      id: 'node-old',
      userId: 'system_anonymous_trials',
      status: 'destroying',
      nodeClass: 'managed',
      runtime: 'vm',
      runtimeIncarnationId: 'runtime-old',
      providerInstanceId: 'vm-missing',
      cloudProvider: 'hetzner',
      backendDnsRecordId: 'dns-old',
      credentialAttributionUserId: null,
      credentialAttributionProjectId: null,
      credentialAttributionSource: null,
      placementCredentialSource: 'platform',
      placementCredentialReference: 'platform_credentials:platform-hetzner',
      placementCredentialVersion: null,
      placementCredentialFingerprint: 'sha256:fixture-provider-generation',
    });
    providerGetVM.mockResolvedValue(null);
    createProviderForUser.mockImplementation(async (...args: unknown[]) => {
      if (args[4] !== 'hetzner') return null;
      return {
        provider: { getVM: providerGetVM, deleteVM: providerDeleteVM },
        providerName: 'hetzner',
        credentialSource: 'platform',
      };
    });
  });

  it('flows from cron discovery through real strict deletion to guarded local finalization', async () => {
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...binds: unknown[]) => {
        calls.push({ sql, binds });
        return {
          all: vi.fn(async () => {
            if (sql.includes('WITH resolved_trials')) {
              return { results: [{ trial_id: 'trial-old', project_id: 'project-old' }] };
            }
            if (sql.includes('FROM workspaces') && sql.includes('project_id = ?')) {
              return {
                results: [
                  {
                    id: 'workspace-old',
                    node_id: 'node-old',
                    user_id: 'system_anonymous_trials',
                    project_id: 'project-old',
                    chat_session_id: 'chat-old',
                    status: 'running',
                  },
                ],
              };
            }
            if (sql.includes('FROM workspaces') && sql.includes('id IN')) {
              return {
                results: [
                  {
                    id: 'workspace-old',
                    project_id: 'project-old',
                    chat_session_id: 'chat-old',
                  },
                ],
              };
            }
            return { results: [] };
          }),
          first: vi.fn(async () =>
            sql.includes('COUNT(*) as active_count') ? { active_count: 0 } : null
          ),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        };
      }),
    }));
    const env = {
      DATABASE: { prepare },
      OBSERVABILITY_DATABASE: {},
    } as unknown as Env;

    const result = await runTrialExpireSweep(env, 1_700_000_000_000);

    expect(result).toMatchObject({ workspacesDeleted: 1, nodesDeleted: 1, cleanupErrors: 0 });
    expect(providerGetVM).not.toHaveBeenCalled();
    expect(providerDeleteVM).toHaveBeenCalledWith('vm-missing');
    expect(deleteDNSRecord).toHaveBeenCalledWith('dns-old', env);
    expect(drizzleUpdates).toEqual(
      expect.arrayContaining([
        { runtimeTerminationConfirmedAt: expect.any(String) },
        expect.objectContaining({
          status: 'deleted',
          runtimeDeletionConfirmedAt: expect.any(String),
          runtimeDeletionProof: 'node_runtime_terminated',
        }),
      ])
    );
    expect(calls.some(({ sql }) => sql.includes('UPDATE agent_sessions'))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes('UPDATE compute_usage'))).toBe(true);
    expect(
      calls.some(
        ({ sql }) => sql.includes('UPDATE workspaces') && sql.includes("status = 'deleted'")
      )
    ).toBe(true);
    expect(
      calls.some(({ sql }) => sql.includes('UPDATE nodes') && sql.includes("status = 'deleted'"))
    ).toBe(true);
    expect(stopSession).toHaveBeenCalledWith(env, 'project-old', 'chat-old');
    expect(cleanupWorkspaceActivity).toHaveBeenCalledWith(env, 'project-old', 'workspace-old');
    expect(persistError).not.toHaveBeenCalled();
  });
});
