import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

import * as schema from '../../../src/db/schema';
import { NodeLifecycle } from '../../../src/durable-objects/node-lifecycle';
import { TaskRunner } from '../../../src/durable-objects/task-runner';
import type { StartTaskInput } from '../../../src/durable-objects/task-runner/types';
import { VmAgentContainer } from '../../../src/durable-objects/vm-agent-container';
import type { Env } from '../../../src/env';
import {
  isSessionRecoverySourceTaskGuardFullyValidForEnv,
  isSessionRecoveryTaskAndEventAuthorized,
  isSessionRecoveryTaskAuthorized,
  type SessionRecoverySourceTaskGuard,
} from '../../../src/services/session-recovery-authority';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

const guard: SessionRecoverySourceTaskGuard = {
  taskId: 'root',
  projectId: 'project',
  chatSessionId: 'chat',
  projectEventWake: { batchId: 'batch', subscriptionId: 'subscription' },
};
const recoveryInput = {
  recoveryTaskId: 'T2',
  sourceTaskId: 'root',
  projectId: 'project',
  chatSessionId: 'chat',
  projectEventWake: guard.projectEventWake,
};

function fixture() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createSchemaTables(sqlite, [schema.tasks, schema.sessionSnapshots]);
  sqlite.exec(`
    INSERT INTO tasks (id, project_id, user_id, status, superseded_by_task_id)
      VALUES ('root', 'project', 'user', 'cancelled', 'T2');
    INSERT INTO tasks (id, project_id, user_id, status, recovery_source_task_id,
                       triggered_by, superseded_by_task_id)
      VALUES ('T1', 'project', 'user', 'cancelled', 'root', 'session-recovery', 'T2');
    INSERT INTO tasks (id, project_id, user_id, status, recovery_source_task_id,
                       triggered_by, chat_session_id)
      VALUES ('T2', 'project', 'user', 'queued', 'root', 'session-recovery', 'chat');
    INSERT INTO session_snapshots (id, project_id, chat_session_id, recovery_task_id, recovery_status)
      VALUES ('snapshot', 'project', 'chat', 'T2', 'waking');
  `);
  const database = createSqliteD1(sqlite);
  const validateEvent = vi.fn(async (_input: unknown) => true);
  const projectStub = {
    ensureProjectId: vi.fn(async () => undefined),
    validateProjectEventWakeRecoveryAuthority: validateEvent,
  };
  const env = {
    DATABASE: database,
    PROJECT_DATA: { idFromName: (id: string) => id, get: () => projectStub },
  } as unknown as Env;
  return { sqlite, database, validateEvent, env };
}

describe('recovery event authority at final asynchronous boundaries', () => {
  it('authorizes the exact queued T2 snapshot claim after T0 and T1 were superseded', async () => {
    const f = fixture();
    await expect(isSessionRecoveryTaskAuthorized(f.database, recoveryInput)).resolves.toBe(true);
    await expect(
      isSessionRecoveryTaskAndEventAuthorized(f.database, recoveryInput, f.validateEvent)
    ).resolves.toBe(true);
    await expect(isSessionRecoverySourceTaskGuardFullyValidForEnv(f.env, guard)).resolves.toBe(
      true
    );
  });

  it.each([
    ['cancelled replacement', "UPDATE tasks SET status = 'cancelled' WHERE id = 'T2'"],
    ['reassigned snapshot', "UPDATE session_snapshots SET recovery_task_id = 'other'"],
    ['revoked root marker', "UPDATE tasks SET superseded_by_task_id = NULL WHERE id = 'root'"],
  ])('rejects %s committed while the event RPC awaited', async (_label, mutation) => {
    const f = fixture();
    const validate = vi.fn(async () => {
      f.sqlite.exec(mutation);
      return true;
    });
    await expect(
      isSessionRecoveryTaskAndEventAuthorized(f.database, recoveryInput, validate)
    ).resolves.toBe(false);
    expect(validate).toHaveBeenCalledOnce();
  });

  it('requires an event validator and rejects its negative result', async () => {
    const f = fixture();
    await expect(isSessionRecoveryTaskAndEventAuthorized(f.database, recoveryInput)).resolves.toBe(
      false
    );
    await expect(
      isSessionRecoveryTaskAndEventAuthorized(f.database, recoveryInput, async () => false)
    ).resolves.toBe(false);
  });

  it('runs the production TaskRunner guard against cancellation during its final event RPC', async () => {
    const f = fixture();
    f.validateEvent.mockImplementation(async () => {
      f.sqlite.exec("UPDATE tasks SET status = 'cancelled' WHERE id = 'T2'");
      return true;
    });
    const runner = Object.assign(Object.create(TaskRunner.prototype), { env: f.env }) as {
      hasRecoveryAuthority(input: StartTaskInput): Promise<boolean>;
    };
    await expect(
      runner.hasRecoveryAuthority({
        taskId: 'T2',
        projectId: 'project',
        userId: 'user',
        config: {
          recoverySourceTaskId: 'root',
          resumeSnapshotChatSessionId: 'chat',
          projectEventWakeGuard: guard.projectEventWake,
        },
      } as StartTaskInput)
    ).resolves.toBe(false);
    expect(f.validateEvent).toHaveBeenCalledWith({
      projectId: 'project',
      sourceTaskId: 'root',
      chatSessionId: 'chat',
      batchId: 'batch',
      subscriptionId: 'subscription',
    });
  });

  it.each(['event cancellation', 'D1 cancellation'] as const)(
    'withholds actual container transport after final %s',
    async (revocation) => {
      const f = fixture();
      let reachedRuntimeState = false;
      f.validateEvent.mockImplementation(async () => {
        if (!reachedRuntimeState) return true;
        if (revocation === 'event cancellation') return false;
        f.sqlite.exec("UPDATE tasks SET status = 'cancelled' WHERE id = 'T2'");
        return true;
      });
      const values = new Map<string, unknown>([['lifecycleStatus', 'running']]);
      const containerFetch = vi.fn(() => new Response('delivered'));
      const container = Object.assign(Object.create(VmAgentContainer.prototype), {
        env: f.env,
        defaultPort: 8080,
        lifecycleChain: Promise.resolve(),
        ctx: {
          storage: {
            get: async (key: string) => values.get(key),
            put: async (key: string, value: unknown) => {
              values.set(key, value);
            },
            delete: async (key: string) => values.delete(key),
          },
        },
        getState: async () => {
          reachedRuntimeState = true;
          return { status: 'running' };
        },
        containerFetch,
      }) as VmAgentContainer;
      const response = await container.proxyHttpGuarded(
        new Request('http://container/prompt', { method: 'POST' }),
        undefined,
        guard
      );
      expect(response.status).toBe(409);
      expect(f.validateEvent).toHaveBeenCalledTimes(2);
      expect(containerFetch).not.toHaveBeenCalled();
    }
  );

  it('rejects an already-cancelled event before reading container preparation state', async () => {
    const f = fixture();
    f.validateEvent.mockResolvedValue(false);
    const get = vi.fn(async (_key: string) => undefined);
    const container = Object.assign(Object.create(VmAgentContainer.prototype), {
      env: f.env,
      lifecycleChain: Promise.resolve(),
      ctx: { storage: { get } },
    }) as VmAgentContainer;
    const response = await container.proxyHttpGuarded(
      new Request('http://container/prompt', { method: 'POST' }),
      undefined,
      guard
    );
    expect(response.status).toBe(409);
    expect(get).not.toHaveBeenCalledWith('lifecycleStatus');
  });

  it('keeps a newer event wake owner when a stale event guard is revoked', async () => {
    const f = fixture();
    f.validateEvent.mockResolvedValue(false);
    const newer = {
      ...guard,
      projectEventWake: { batchId: 'newer', subscriptionId: 'subscription' },
    };
    const values = new Map<string, unknown>([['sourceTaskWakeGuard', newer]]);
    const stop = vi.fn();
    const container = Object.assign(Object.create(VmAgentContainer.prototype), {
      env: f.env,
      lifecycleChain: Promise.resolve(),
      stop,
      ctx: { storage: { get: async (key: string) => values.get(key) } },
    }) as VmAgentContainer;
    await container.proxyHttpGuarded(
      new Request('http://container/prompt', { method: 'POST' }),
      undefined,
      guard
    );
    expect(stop).not.toHaveBeenCalled();
    expect(values.get('sourceTaskWakeGuard')).toEqual(newer);
  });
});

describe('atomic warm-node claim for the current recovery generation', () => {
  it.each([
    ['exact queued successor', undefined, 'claimed'],
    [
      'cancelled without supersession',
      "UPDATE tasks SET superseded_by_task_id = NULL WHERE id = 'root'",
      'source_task_revoked',
    ],
    [
      'different successor',
      "UPDATE tasks SET superseded_by_task_id = 'T1' WHERE id = 'root'",
      'source_task_revoked',
    ],
    [
      'stale snapshot claim',
      "UPDATE session_snapshots SET recovery_task_id = 'T1'",
      'source_task_revoked',
    ],
    [
      'cancelled replacement',
      "UPDATE tasks SET status = 'cancelled' WHERE id = 'T2'",
      'source_task_revoked',
    ],
  ])('%s', async (_label, mutation, expected) => {
    const f = fixture();
    if (mutation) f.sqlite.exec(mutation);
    const lifecycle = Object.assign(Object.create(NodeLifecycle.prototype), { env: f.env }) as {
      persistWarmClaim(
        nodeId: string,
        taskId: string,
        source: SessionRecoverySourceTaskGuard
      ): Promise<string>;
    };
    await expect(lifecycle.persistWarmClaim('warm-node', 'T2', guard)).resolves.toBe(expected);
    expect(
      f.sqlite.prepare("SELECT claimed_warm_node_id FROM tasks WHERE id = 'T2'").get()
    ).toEqual({ claimed_warm_node_id: expected === 'claimed' ? 'warm-node' : null });
  });
});
