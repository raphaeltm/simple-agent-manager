import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { loadRuntimeRecoveryContext } from '../../../src/durable-objects/vm-agent-container-recovery';
import type { Env } from '../../../src/env';
import { loadRecoveryContext } from '../../../src/services/session-recovery-context';
import type { RecoveryPlacementResolution } from '../../../src/services/session-recovery-request';
import { startRecoveryTask } from '../../../src/services/session-recovery-task';
import {
  loadSnapshotRuntimeContract,
  parseSessionRuntimeContract,
} from '../../../src/services/session-runtime-contract';
import {
  ensureSessionSnapshotForSleep,
  prepareSessionSnapshot,
} from '../../../src/services/session-snapshot-prepare';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const { createAgentSessionOnNodeMock, restoreAgentSessionOnNodeMock, startAgentSessionOnNodeMock } =
  vi.hoisted(() => ({
    createAgentSessionOnNodeMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
      async () => undefined
    ),
    restoreAgentSessionOnNodeMock: vi.fn<(...args: unknown[]) => Promise<{ status: string }>>(
      async () => ({ status: 'restored' })
    ),
    startAgentSessionOnNodeMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
      async () => undefined
    ),
  }));

// Mock ONLY the outermost system boundary (the HTTP call to the VM). Everything between the
// entry point and that boundary — resolution, decryption, merge, composition — runs for real.
vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: createAgentSessionOnNodeMock,
  startAgentSessionOnNode: startAgentSessionOnNodeMock,
  restoreAgentSessionOnNode: restoreAgentSessionOnNodeMock,
}));

vi.mock('../../../src/services/mcp-token', () => ({
  generateMcpToken: () => 'sam-session-token',
  revokeMcpToken: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  storeMcpToken: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));

vi.mock('../../../src/services/project-data', () => ({
  ensureAcpSession: vi.fn(async () => ({ id: 'acp-1' })),
  createAcpSession: vi.fn(async () => ({ id: 'acp-1' })),
  getAcpSession: vi.fn(async () => null),
  persistMessage: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  transitionAcpSession: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  prepareAcpSessionForFreshStart: vi.fn(async () => ({ id: 'acp-1' })),
}));

const { startSamAwareAgentSession } = await import('../../../src/services/agent-session-bootstrap');
const tokenService = await import('../../../src/services/mcp-token');
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
function env() {
  return {
    BASE_DOMAIN: 'example.com',
    ACP_INTERACTIONS_ENABLED: 'true',
    ACP_INTERACTION_FORMS_ENABLED: 'true',
    ACP_INTERACTION_URLS_ENABLED: 'true',
    ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    KV: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  } as unknown as Env;
}
function input(extra: Record<string, unknown> = {}) {
  return {
    nodeId: 'node-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    userId: 'user-1',
    chatSessionId: 'chat-1',
    agentSessionId: 'agent-1',
    label: 'Session',
    agentType: 'codex',
    visibleInitialPrompt: 'continue work',
    promptKind: 'conversation',
    actor: { type: 'system', id: 'user-1', reasonPrefix: 'test' },
    ...extra,
  } as Parameters<typeof startSamAwareAgentSession>[2];
}
beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.mcpConnections,
    schema.agentSessions,
    schema.projects,
    schema.agentSettings,
    schema.sessionSnapshots,
    schema.nodes,
    schema.workspaces,
    schema.users,
    schema.tasks,
    schema.agentProfiles,
  ]);
  sqlite.exec(
    'CREATE UNIQUE INDEX session_snapshots_chat_unique ON session_snapshots(chat_session_id)'
  );
  db = drizzle(createSqliteD1(sqlite), { schema });
});
afterEach(() => sqlite.close());
async function sleep() {
  await prepareSessionSnapshot(db, env(), {
    workspaceId: 'ws-1',
    nodeId: 'node-1',
    projectId: 'proj-1',
    userId: 'user-1',
    chatSessionId: 'chat-1',
    agentSessionId: 'agent-1',
    runtime: 'vm',
  });
  return JSON.parse(
    (
      sqlite.prepare('SELECT runtime_contract_json FROM session_snapshots').get() as {
        runtime_contract_json: string;
      }
    ).runtime_contract_json
  );
}
describe('runtime contract survives real bootstrap and snapshot persistence', () => {
  it.each(['default', 'plan'] as const)(
    'normal wake preserves %s and all overrides despite changing defaults',
    async (permissionMode) => {
      await startSamAwareAgentSession(
        db,
        env(),
        input({
          overrides: {
            model: 'gpt-6.1-sol',
            effort: 'high',
            permissionMode,
            opencodeProvider: 'custom',
            opencodeBaseUrl: 'https://inference.example.com',
          },
        })
      );
      const contract = await sleep();
      sqlite
        .prepare(
          "INSERT INTO agent_settings (id,user_id,agent_type,model,permission_mode) VALUES ('settings','user-1','codex','different','bypassPermissions')"
        )
        .run();
      vi.clearAllMocks();
      await startSamAwareAgentSession(
        db,
        env(),
        input({
          agentSessionId: 'agent-wake',
          restoreSnapshotChatSessionId: 'chat-1',
          overrides: { permissionMode: 'bypassPermissions', model: 'changed' },
        })
      );
      expect(restoreAgentSessionOnNodeMock.mock.calls[0]?.[5]).toMatchObject({
        runtimeContract: contract,
      });
      expect(contract).toMatchObject({
        permissionMode,
        model: 'gpt-6.1-sol',
        effort: 'high',
        settingsResolved: true,
        acpInteractions: { enabled: true, formsEnabled: true, urlsEnabled: true },
      });
      expect(startAgentSessionOnNodeMock).not.toHaveBeenCalled();
    }
  );
  it.each(['task', 'conversation'] as const)(
    'degraded %s wake preserves interaction policy and original callback identity',
    async (taskMode) => {
      await startSamAwareAgentSession(
        db,
        env(),
        input({
          promptKind: taskMode,
          taskContext: { taskId: 'original-task', taskMode },
          overrides: { permissionMode: 'default', model: 'gpt-6.1-sol' },
        })
      );
      const contract = await sleep();
      vi.clearAllMocks();
      restoreAgentSessionOnNodeMock.mockResolvedValueOnce({ status: 'degraded' });
      await startSamAwareAgentSession(
        db,
        env(),
        input({
          agentSessionId: 'recovery-agent',
          restoreSnapshotChatSessionId: 'chat-1',
          promptKind: 'conversation',
          taskContext: { taskId: 'original-task', taskMode: 'conversation' },
        })
      );
      expect(startAgentSessionOnNodeMock.mock.calls[0]?.[8]).toMatchObject(contract);
      expect(startAgentSessionOnNodeMock.mock.calls[0]?.[9]).toEqual({
        projectId: 'proj-1',
        taskId: 'original-task',
        taskMode,
      });
      expect(startAgentSessionOnNodeMock.mock.calls[0]?.[12]).toEqual(contract.acpInteractions);
      expect(contract.acpInteractions.formsEnabled).toBe(taskMode === 'conversation');
      expect(contract.acpInteractions.urlsEnabled).toBe(taskMode === 'conversation');
      expect(tokenService.storeMcpToken).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({ taskId: 'original-task', taskMode, contextType: taskMode }),
        expect.anything()
      );
    }
  );
  it('freezes resolved project and user defaults rather than re-resolving at wake', async () => {
    sqlite
      .prepare(
        "INSERT INTO projects (id,user_id,name,normalized_name,installation_id,repository,agent_defaults) VALUES ('proj-1','user-1','Project','project','install','owner/repo',?)"
      )
      .run(JSON.stringify({ codex: { model: 'gpt-6.1-sol', permissionMode: 'plan' } }));
    sqlite
      .prepare(
        "INSERT INTO agent_settings (id,user_id,agent_type,model,permission_mode,opencode_provider,opencode_base_url) VALUES ('settings','user-1','codex','user-model','default','custom','https://inference.example.com')"
      )
      .run();
    await startSamAwareAgentSession(db, env(), input());
    const contract = await sleep();
    expect(contract).toMatchObject({
      model: 'gpt-6.1-sol',
      permissionMode: 'plan',
      opencodeProvider: 'custom',
      opencodeBaseUrl: 'https://inference.example.com',
      taskContext: null,
    });
    sqlite
      .prepare('UPDATE projects SET agent_defaults = ?')
      .run(
        JSON.stringify({ codex: { model: 'different-model', permissionMode: 'bypassPermissions' } })
      );
    sqlite
      .prepare(
        "UPDATE agent_settings SET model = 'different-user-model', permission_mode = 'bypassPermissions', opencode_provider = 'opencode-zen', opencode_base_url = NULL"
      )
      .run();
    vi.clearAllMocks();
    await startSamAwareAgentSession(
      db,
      {
        ...env(),
        ACP_INTERACTIONS_ENABLED: 'false',
        ACP_INTERACTION_FORMS_ENABLED: 'false',
        ACP_INTERACTION_URLS_ENABLED: 'false',
      },
      input({ agentSessionId: 'wake', restoreSnapshotChatSessionId: 'chat-1' })
    );
    expect(restoreAgentSessionOnNodeMock.mock.calls[0]?.[5]).toMatchObject({
      runtimeContract: contract,
    });
  });
  it('retains a resolved null model when settings are added after sleep', async () => {
    await startSamAwareAgentSession(db, env(), input({ overrides: { permissionMode: 'default' } }));
    const contract = await sleep();
    expect(contract.model).toBeNull();
    sqlite
      .prepare(
        "INSERT INTO agent_settings (id,user_id,agent_type,model,permission_mode) VALUES ('settings','user-1','codex','new-default','bypassPermissions')"
      )
      .run();
    vi.clearAllMocks();
    restoreAgentSessionOnNodeMock.mockResolvedValueOnce({ status: 'degraded' });
    await startSamAwareAgentSession(
      db,
      env(),
      input({ agentSessionId: 'wake', restoreSnapshotChatSessionId: 'chat-1' })
    );
    expect(startAgentSessionOnNodeMock.mock.calls[0]?.[8]).toMatchObject({
      model: null,
      permissionMode: 'default',
      settingsResolved: true,
    });
  });
  it('legacy snapshot cannot inherit bypass from current defaults', async () => {
    sqlite
      .prepare(
        "INSERT INTO agent_settings (id,user_id,agent_type,permission_mode) VALUES ('settings','user-1','codex','bypassPermissions')"
      )
      .run();
    await startSamAwareAgentSession(db, env(), input({ restoreSnapshotChatSessionId: 'legacy' }));
    expect(restoreAgentSessionOnNodeMock.mock.calls[0]?.[5]).toMatchObject({
      runtimeContract: { permissionMode: 'default' },
    });
  });
  it.each(['not-json', '{"version":2}', '{}'])(
    'fails closed before VM mutations for invalid stored record %s',
    async (json) => {
      await startSamAwareAgentSession(db, env(), input());
      await sleep();
      sqlite.prepare('UPDATE session_snapshots SET runtime_contract_json = ?').run(json);
      vi.clearAllMocks();
      await expect(
        startSamAwareAgentSession(db, env(), input({ restoreSnapshotChatSessionId: 'chat-1' }))
      ).rejects.toThrow();
      expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
      expect(restoreAgentSessionOnNodeMock).not.toHaveBeenCalled();
    }
  );
  it('rejects a conflicting caller task identity before restore admission', async () => {
    await startSamAwareAgentSession(
      db,
      env(),
      input({ promptKind: 'task', taskContext: { taskId: 'original-task', taskMode: 'task' } })
    );
    await sleep();
    vi.clearAllMocks();
    await expect(
      startSamAwareAgentSession(
        db,
        env(),
        input({
          restoreSnapshotChatSessionId: 'chat-1',
          taskContext: { taskId: 'unrelated-task', taskMode: 'task' },
        })
      )
    ).rejects.toThrow('task identity mismatch');
    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(restoreAgentSessionOnNodeMock).not.toHaveBeenCalled();
  });
  it('loads no other user or project snapshot and rejects a conflicting task project', async () => {
    await startSamAwareAgentSession(
      db,
      env(),
      input({ taskContext: { taskId: 'task', taskMode: 'task' } })
    );
    const contract = await sleep();
    expect(await loadSnapshotRuntimeContract(db, 'proj-1', 'other-user', 'chat-1')).toBeNull();
    expect(await loadSnapshotRuntimeContract(db, 'other-project', 'user-1', 'chat-1')).toBeNull();
    contract.taskContext.projectId = 'other-project';
    sqlite
      .prepare('UPDATE session_snapshots SET runtime_contract_json = ?')
      .run(JSON.stringify(contract));
    await expect(loadSnapshotRuntimeContract(db, 'proj-1', 'user-1', 'chat-1')).rejects.toThrow(
      'project mismatch'
    );
    expect(parseSessionRuntimeContract(null)).toBeNull();
  });
});

function seedInstant() {
  sqlite
    .prepare(
      "INSERT INTO nodes (id,user_id,name,status,runtime) VALUES ('node-1','user-1','Instant','sleeping','cf-container')"
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO workspaces (id,node_id,project_id,user_id,name,repository,vm_size,vm_location,status,chat_session_id) VALUES ('ws-1','node-1','proj-1','user-1','Instant','owner/repo','small','auto','sleeping','chat-1')"
    )
    .run();
  return { ...env(), DATABASE: createSqliteD1(sqlite) };
}
describe('Instant recovery loads the persisted session contract', () => {
  it.each(['task', 'conversation'] as const)(
    'retains %s settings and callbacks after defaults change',
    async (taskMode) => {
      await startSamAwareAgentSession(
        db,
        env(),
        input({
          promptKind: taskMode,
          taskContext: { taskId: 'original-task', taskMode },
          overrides: { permissionMode: 'plan', effort: 'xhigh', model: 'gpt-6.1-sol' },
        })
      );
      sqlite
        .prepare(
          "INSERT INTO agent_settings (id,user_id,agent_type,model,permission_mode) VALUES ('settings','user-1','codex','different','bypassPermissions')"
        )
        .run();
      const bindings = seedInstant();
      const context = await loadRuntimeRecoveryContext(bindings, { workspaceId: 'ws-1' });
      expect(context).toMatchObject({
        userId: 'user-1',
        chatSessionId: 'chat-1',
        agentSessionId: 'agent-1',
        runtimeContract: {
          permissionMode: 'plan',
          model: 'gpt-6.1-sol',
          effort: 'xhigh',
          settingsResolved: true,
          promptKind: taskMode,
          taskContext: { projectId: 'proj-1', taskId: 'original-task', taskMode },
        },
      });
      expect(context?.runtimeContract?.acpInteractions.formsEnabled).toBe(
        taskMode === 'conversation'
      );
      expect(context?.runtimeContract?.acpInteractions.urlsEnabled).toBe(
        taskMode === 'conversation'
      );
    }
  );
  it.each(['not-json', '{"version":2}'])(
    'rejects malformed or future persisted contracts %s',
    async (json) => {
      await startSamAwareAgentSession(db, env(), input());
      sqlite.prepare('UPDATE agent_sessions SET runtime_contract_json = ?').run(json);
      await expect(
        loadRuntimeRecoveryContext(seedInstant(), { workspaceId: 'ws-1' })
      ).rejects.toThrow();
    }
  );
  it('cannot recover an agent belonging to another workspace', async () => {
    await startSamAwareAgentSession(db, env(), input());
    expect(
      await loadRuntimeRecoveryContext(seedInstant(), {
        workspaceId: 'ws-1',
        preferredAgentSessionId: 'other-session',
      })
    ).toBeNull();
  });
});

describe('recovery task runner transport preserves completion and delivery mode', () => {
  it.each(['task', 'conversation'] as const)(
    'reactivates original %s task with the persisted mode and output branch',
    async (taskMode) => {
      sqlite
        .prepare(
          "INSERT INTO users (id,name,email) VALUES ('user-1','Developer','developer@example.com')"
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO projects (id,user_id,name,normalized_name,installation_id,repository) VALUES ('proj-1','user-1','Project','project','install','owner/repo')"
        )
        .run();
      await startSamAwareAgentSession(
        db,
        env(),
        input({
          promptKind: taskMode,
          taskContext: { taskId: 'original-task', taskMode },
          overrides: { permissionMode: 'plan', effort: 'max', model: 'gpt-6.1-sol' },
        })
      );
      await sleep();
      const bindings = seedInstant();
      sqlite
        .prepare(
          "UPDATE session_snapshots SET sleeping_at = '2026-10-07T09:00:00.000Z', manifest_json = ?"
        )
        .run(JSON.stringify({ agentType: 'codex' }));
      sqlite
        .prepare(
          "INSERT INTO tasks (id,project_id,user_id,title,status,task_mode,output_branch,chat_session_id,workspace_id) VALUES ('original-task','proj-1','user-1','Deliver change','queued','conversation','sam/original','chat-1','ws-1')"
        )
        .run();
      const context = await loadRecoveryContext(db, 'proj-1', 'chat-1');
      if (!context?.sourceTask) throw new Error('real recovery context unavailable');
      const reactivate = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
      const runnerEnv = {
        ...bindings,
        TASK_RUNNER: { idFromName: vi.fn((id: string) => id), get: vi.fn(() => ({ reactivate })) },
      } as unknown as Env;
      const placement = {
        placement: {
          vmLocation: 'nbg1',
          provider: 'hetzner',
          explicitVmLocation: false,
          resolvedReservation: {
            cpuMillis: 1000,
            memoryMb: 1024,
            diskMb: 10240,
            exclusiveNode: false,
            source: 'platform',
            sourceId: 'platform',
            version: 1,
          },
          vmSizeSource: 'platform',
        },
        effectiveProvider: 'hetzner',
        credentialAttributionUserId: 'user-1',
        credentialAttributionProjectId: null,
        credentialAttributionSource: 'user',
        capacityPoolSelection: null,
      } as unknown as RecoveryPlacementResolution;
      await startRecoveryTask(runnerEnv, context, context.sourceTask, 'chat-1', placement);
      expect(reactivate).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'original-task',
          projectId: 'proj-1',
          userId: 'user-1',
          config: expect.objectContaining({
            taskMode,
            outputBranch: 'sam/original',
            chatSessionId: 'chat-1',
            resumeSnapshotChatSessionId: 'chat-1',
            model: 'gpt-6.1-sol',
            effort: 'max',
            permissionMode: 'plan',
          }),
        })
      );
    }
  );
});

describe('sleep placeholder retains the owned durable runtime contract', () => {
  function placeholder(extra: Record<string, unknown> = {}) {
    return {
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      projectId: 'proj-1',
      userId: 'user-1',
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-1',
      runtime: 'vm' as const,
      ...extra,
    };
  }
  it.each(['vm', 'cf-container'] as const)(
    'preserves a contract during %s recovery when session metadata is absent',
    async (runtime) => {
      await startSamAwareAgentSession(db, env(), input({ overrides: { permissionMode: 'plan' } }));
      const saved = await sleep();
      expect(
        await ensureSessionSnapshotForSleep(
          db,
          env(),
          placeholder({
            runtime,
            workspaceId: 'replacement-ws',
            nodeId: 'replacement-node',
            agentSessionId: null,
          })
        )
      ).toBe(true);
      const row = sqlite
        .prepare('SELECT runtime_contract_json, workspace_id, node_id FROM session_snapshots')
        .get() as Record<string, string>;
      expect(JSON.parse(row.runtime_contract_json)).toEqual(saved);
      expect(row.workspace_id).toBe('replacement-ws');
      expect(row.node_id).toBe('replacement-node');
    }
  );
  it('replaces the saved contract when a new owned session has resolved settings', async () => {
    await startSamAwareAgentSession(db, env(), input());
    const saved = await sleep();
    const replacement = { ...saved, permissionMode: 'plan' };
    sqlite
      .prepare('UPDATE agent_sessions SET runtime_contract_json = ? WHERE id = ?')
      .run(JSON.stringify(replacement), 'agent-1');
    expect(await ensureSessionSnapshotForSleep(db, env(), placeholder())).toBe(true);
    expect(
      JSON.parse(
        (
          sqlite.prepare('SELECT runtime_contract_json FROM session_snapshots').get() as {
            runtime_contract_json: string;
          }
        ).runtime_contract_json
      )
    ).toEqual(replacement);
  });
  it.each([{ userId: 'another-owner' }, { projectId: 'another-project' }, { projectId: null }])(
    'refuses a conflicting owner/project without changing durable recovery state: %j',
    async (conflict) => {
      await startSamAwareAgentSession(db, env(), input());
      await sleep();
      const before = sqlite.prepare('SELECT * FROM session_snapshots').get();
      await expect(
        ensureSessionSnapshotForSleep(db, env(), placeholder({ ...conflict, agentSessionId: null }))
      ).rejects.toThrow('Session snapshot ownership conflict');
      expect(sqlite.prepare('SELECT * FROM session_snapshots').get()).toEqual(before);
    }
  );
  it('keeps a first legacy placeholder contract nullable', async () => {
    expect(
      await ensureSessionSnapshotForSleep(
        db,
        env(),
        placeholder({ agentSessionId: null, projectId: null })
      )
    ).toBe(true);
    expect(
      (
        sqlite.prepare('SELECT runtime_contract_json FROM session_snapshots').get() as {
          runtime_contract_json: null;
        }
      ).runtime_contract_json
    ).toBeNull();
    expect(
      await ensureSessionSnapshotForSleep(
        db,
        env(),
        placeholder({ agentSessionId: null, projectId: null, workspaceId: 'legacy-replacement' })
      )
    ).toBe(true);
    expect(
      (
        sqlite.prepare('SELECT workspace_id FROM session_snapshots').get() as {
          workspace_id: string;
        }
      ).workspace_id
    ).toBe('legacy-replacement');
  });
});
