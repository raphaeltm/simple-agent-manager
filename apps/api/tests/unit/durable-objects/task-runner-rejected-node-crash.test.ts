/** Real TaskRunner → provisioning → provider HTTP → SQLite deletion, including restart. */
import Database from 'better-sqlite3';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { discardProviderRejectedNode } from '../../../src/durable-objects/task-runner/node-provisioning-rejected-node';
import { handleNodeProvisioning } from '../../../src/durable-objects/task-runner/node-provisioning-step';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import type { Env } from '../../../src/env';
import { encrypt } from '../../../src/services/encryption';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const encryptionKey = Buffer.alloc(32, 9).toString('base64');
const { privateKey } = await generateKeyPair('RS256', { extractable: true });
const jwtPrivateKey = await exportPKCS8(privateKey);
const isolateLost = new Error('simulated isolate loss after rejected node deletion');
let sqlite: Database.Database;
let rc: TaskRunnerContext;
let saved: TaskRunnerState;
let crashed: boolean;
let interruptDeletion: boolean;
let proofAtDeletion: string | null | undefined;
let providerCalls: ReturnType<typeof vi.fn>;

function initialState(): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task',
    projectId: 'project',
    userId: 'user',
    currentStep: 'node_provisioning',
    createdAt: Date.now(),
    lastStepAt: Date.now(),
    completed: false,
    retryCount: 0,
    stepResults: {
      nodeId: null,
      autoProvisioned: false,
      provisionedVmSize: null,
      workspaceId: null,
      chatSessionId: null,
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
    },
    config: {
      vmSize: 'small',
      vmLocation: 'hel1',
      cloudProvider: 'hetzner',
      taskMode: 'conversation',
      taskTitle: 'Wake preserved work',
      preferredNodeId: null,
    },
  } as TaskRunnerState;
}

/** Inject process loss AFTER the actual SQL delete commits; later DO writes cannot run. */
function databaseWithCrashBoundary(): D1Database {
  const database = createSqliteD1(sqlite);
  const afterDelete = () => {
    if (!interruptDeletion) return;
    proofAtDeletion = saved.stepResults.providerRejectedNodeId;
    crashed = true;
    throw isolateLost;
  };
  return {
    ...database,
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const wrap = (bound: D1PreparedStatement): D1PreparedStatement =>
        ({
          ...bound,
          bind: (...args: unknown[]) => wrap(statement.bind(...args)),
          run: async () => {
            const result = await bound.run();
            if (/DELETE FROM ["`]?nodes/i.test(sql)) afterDelete();
            return result;
          },
        }) as D1PreparedStatement;
      return wrap(statement);
    },
  } as D1Database;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  crashed = false;
  interruptDeletion = true;
  proofAtDeletion = undefined;
  saved = initialState();
  sqlite.exec(`
    INSERT INTO users (id, email, status) VALUES ('user', 'user@example.test', 'active');
    INSERT INTO projects (id, user_id, name) VALUES ('project', 'user', 'Project');
    INSERT INTO project_members (project_id, user_id, role, status) VALUES ('project', 'user', 'owner', 'active');
    INSERT INTO tasks (id, project_id, user_id, title, status) VALUES ('task', 'project', 'user', 'Wake', 'delegated');
  `);
  const encrypted = await encrypt('test-hetzner-token', encryptionKey);
  sqlite
    .prepare(
      `INSERT INTO credentials (id, user_id, provider, credential_type, credential_kind, is_active, encrypted_token, iv)
    VALUES ('credential', 'user', 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?)`
    )
    .run(encrypted.ciphertext, encrypted.iv);
  const env = {
    DATABASE: databaseWithCrashBoundary(),
    BASE_DOMAIN: 'example.test',
    ENVIRONMENT: 'test',
    ENCRYPTION_KEY: encryptionKey,
    JWT_PRIVATE_KEY: jwtPrivateKey,
    VM_ADMISSION_CONTROL_MODE: 'off',
    COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
    MAX_NODES_PER_USER: '10',
    HETZNER_CAPACITY_MAX_ATTEMPTS: '1',
    KV: { get: async () => null, put: async () => undefined },
  } as unknown as Env;
  rc = {
    env,
    ctx: {
      storage: {
        put: async (_key: string, value: TaskRunnerState) => {
          if (crashed) throw isolateLost;
          saved = structuredClone(value);
        },
        setAlarm: vi.fn(async () => undefined),
      },
    },
    updateD1ExecutionStep: async () => undefined,
    assertRecoveryAuthority: async () => undefined,
    advanceToStep: vi.fn(async (state: TaskRunnerState, step: TaskRunnerState['currentStep']) => {
      state.currentStep = step;
    }),
    getProvisionPollIntervalMs: () => 1000,
    getProvisionTimeoutMs: () => 600000,
  } as unknown as TaskRunnerContext;
  providerCalls = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/servers') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          error: { code: 'resource_limit_exceeded', message: 'shared core limit exceeded' },
        }),
        { status: 403 }
      );
    }
    throw new Error(`Unexpected external request: ${init?.method} ${String(url)}`);
  });
  vi.stubGlobal('fetch', providerCalls);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.close();
});

describe('provider rejection survives TaskRunner process loss', () => {
  it('records rejection proof before real provisioning deletes the claimed node, then resumes safely', async () => {
    await expect(handleNodeProvisioning(initialState(), rc)).rejects.toBe(isolateLost);
    expect(providerCalls).toHaveBeenCalledOnce();
    const rejectedNodeId = saved.stepResults.nodeId;
    expect(rejectedNodeId).toEqual(expect.any(String));
    expect(proofAtDeletion).toBe(rejectedNodeId);
    expect(sqlite.prepare('SELECT id FROM nodes WHERE id = ?').get(rejectedNodeId)).toBeUndefined();

    crashed = false;
    interruptDeletion = false;
    // Stop only at the NEXT allocation authority boundary: reaching it proves the
    // restart settled the old claim and passed normal missing-node validation.
    const nextAllocation = new Error('next allocation reached');
    rc.assertRecoveryAuthority = vi.fn(async () => {
      throw nextAllocation;
    });
    const resumed = structuredClone(saved);
    await expect(handleNodeProvisioning(resumed, rc)).rejects.toBe(nextAllocation);
    expect(rc.assertRecoveryAuthority).toHaveBeenCalledOnce();
    expect(saved.stepResults).toMatchObject({
      nodeId: null,
      autoProvisioned: false,
      providerRejectedNodeId: null,
    });
    expect(
      sqlite.prepare('SELECT auto_provisioned_node_id FROM tasks WHERE id = ?').get('task')
    ).toEqual({ auto_provisioned_node_id: null });
    expect(providerCalls).toHaveBeenCalledOnce();
  });

  it('keeps the node row when durable rejection proof cannot be written', async () => {
    interruptDeletion = false;
    const persist = rc.ctx.storage.put;
    let storageUnavailable = false;
    rc.ctx.storage.put = (async (key: string, value: TaskRunnerState) => {
      if (value.stepResults.providerRejectedNodeId) storageUnavailable = true;
      if (storageUnavailable) throw new Error('Durable storage unavailable');
      await persist(key, value);
    }) as typeof rc.ctx.storage.put;

    await expect(handleNodeProvisioning(initialState(), rc)).rejects.toThrow(
      'Durable storage unavailable'
    );

    expect(providerCalls).toHaveBeenCalledOnce();
    expect(saved.stepResults.nodeId).toEqual(expect.any(String));
    expect(saved.stepResults.providerRejectedNodeId).toBeUndefined();
    expect(
      sqlite.prepare('SELECT id FROM nodes WHERE id = ?').get(saved.stepResults.nodeId)
    ).toEqual({ id: saved.stepResults.nodeId });
  });

  it('keeps an unexplained missing claimed node terminal instead of allocating again', async () => {
    const state = initialState();
    state.stepResults.nodeId = 'missing';
    state.stepResults.autoProvisioned = true;
    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining('disappeared'),
    });
    expect(state.stepResults.nodeId).toBe('missing');
    expect(state.stepResults.autoProvisioned).toBe(false);
    expect(providerCalls).not.toHaveBeenCalled();
  });

  it.each([
    { user: 'other-user', providerId: null },
    { user: 'user', providerId: 'live-provider-vm' },
  ])(
    'never deletes a rejected-id collision with protected node %o',
    async ({ user, providerId }) => {
      interruptDeletion = false;
      sqlite
        .prepare(
          `INSERT INTO nodes (id, user_id, status, provider_instance_id) VALUES ('protected', ?, 'creating', ?)`
        )
        .run(user, providerId);
      const state = initialState();
      state.stepResults.nodeId = 'protected';
      state.stepResults.autoProvisioned = true;
      await discardProviderRejectedNode(state, rc, 'protected');
      expect(
        sqlite
          .prepare('SELECT user_id, provider_instance_id FROM nodes WHERE id = ?')
          .get('protected')
      ).toEqual({ user_id: user, provider_instance_id: providerId });
    }
  );
});
