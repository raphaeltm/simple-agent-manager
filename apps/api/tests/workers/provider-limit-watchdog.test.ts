/** Real cron -> provider admission receipt -> watchdog -> terminal CAS on real D1. */
import { newProviderLimitWait } from '@simple-agent-manager/scheduler-core';
import { DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS } from '@simple-agent-manager/shared';
import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';

import { holdTaskForProviderLimit } from '../../src/durable-objects/task-runner/provider-limit-admission';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner/types';
import type { Env } from '../../src/env';
import { scheduled } from '../../src/scheduled/handler';
import { __resetAdminSettingsCacheForTest } from '../../src/services/admin-settings';
import { resumeProviderLimitTask } from '../../src/services/provider-limit-recovery';
import {
  seedInstallation,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const bindings = env as unknown as Env;
let fixture: { taskId: string; userId: string; projectId: string; old: string };

beforeEach(async () => {
  __resetAdminSettingsCacheForTest();
  const id = crypto.randomUUID();
  fixture = {
    taskId: `limit-watchdog-task-${id}`,
    userId: `limit-watchdog-user-${id}`,
    projectId: `limit-watchdog-project-${id}`,
    old: new Date(Date.now() - DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS - 60 * 60_000).toISOString(),
  };
  await seedUser(fixture.userId);
  await seedInstallation(`install-${id}`, fixture.userId);
  await seedProject(fixture.projectId, fixture.userId, `install-${id}`);
  await seedTask(fixture.taskId, fixture.projectId, fixture.userId, {
    status: 'queued',
    executionStep: 'node_selection',
    updatedAt: fixture.old,
  });
  // Suppress routine cron output; assertions inspect durable state, not log text.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  __resetAdminSettingsCacheForTest();
  await env.DATABASE.prepare("UPDATE tasks SET status='completed' WHERE id=?")
    .bind(fixture.taskId)
    .run();
});

async function task() {
  return env.DATABASE.prepare(
    'SELECT status, workspace_id, error_message, provider_limit_wait_json, admission_state, updated_at FROM tasks WHERE id=?'
  )
    .bind(fixture.taskId)
    .first<{
      status: string;
      workspace_id: string | null;
      error_message: string | null;
      provider_limit_wait_json: string | null;
      admission_state: string | null;
      updated_at: string;
    }>();
}

async function tick(overrides: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  // Deliberately no timeout override: production's parseMs/default resolver runs.
  await scheduled(
    createScheduledController({ cron: '*/5 * * * *' }),
    { ...bindings, ...overrides },
    ctx
  );
  await waitOnExecutionContext(ctx);
}

async function seedElapsedHold() {
  const wait = newProviderLimitWait({
    taskId: fixture.taskId,
    origin: 'admission',
    incidentId: 'five-hour-limit',
    credentialKey: null,
    previous: null,
    now: Date.parse(fixture.old),
    resetsAt: Date.now() - 60_000,
    jitter: 0,
  });
  await env.DATABASE.prepare(
    "UPDATE tasks SET provider_limit_wait_json=?, admission_state='provider_limit_waiting', admission_reason=?, admission_next_retry_at=? WHERE id=?"
  )
    .bind(
      JSON.stringify(wait),
      wait.reason,
      new Date(wait.nextRetryAt).toISOString(),
      fixture.taskId
    )
    .run();
}

async function releaseHold() {
  // This is the node_selection producer, including real profile/credential resolution.
  // This account has no selected credential, so it cannot reject after reset.
  const state = {
    version: 1,
    taskId: fixture.taskId,
    projectId: fixture.projectId,
    userId: fixture.userId,
    currentStep: 'node_selection',
    stepResults: { workspaceId: null, agentStarted: false },
    config: { agentType: 'claude-code', agentProfileHint: null, chatSessionId: null },
  } as TaskRunnerState;
  const rc = {
    env: bindings,
    assertRecoveryAuthority: async () => {},
    ctx: { storage: { setAlarm: vi.fn(), deleteAlarm: vi.fn() } },
  } as unknown as TaskRunnerContext;
  expect(await holdTaskForProviderLimit(state, rc)).toBe(false);
  expect(JSON.parse((await task())!.provider_limit_wait_json!).phase).toBe('released');
  expect((await task())!.admission_state).toBeNull();
}

function afterTaskRead(
  effect: () => Promise<void>,
  read: 'candidate' | 'terminal' = 'candidate'
): D1Database {
  let injected = false;
  return new Proxy(env.DATABASE, {
    get(target, property) {
      if (property !== 'prepare') {
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (query: string) => {
        const prepared = target.prepare(query);
        const matches =
          read === 'candidate'
            ? query.includes(
                'auto_provisioned_node_id, chat_session_id, task_mode, admission_state'
              )
            : query.includes('parent_task_id') &&
              query.includes('FROM tasks') &&
              query.includes('LIMIT 1');
        if (!matches) return prepared;
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(statement, {
            get(stmt, method) {
              if (method === 'bind') return (...values: unknown[]) => wrap(stmt.bind(...values));
              if (method === (read === 'candidate' ? 'all' : 'first'))
                return async () => {
                  const result = read === 'candidate' ? await stmt.all() : await stmt.first();
                  if (!injected) {
                    injected = true;
                    await effect();
                  }
                  return result;
                };
              const value = Reflect.get(stmt, method);
              return typeof value === 'function' ? value.bind(stmt) : value;
            },
          });
        return wrap(prepared);
      };
    },
  });
}

async function expectNoFailure() {
  expect((await task())!.error_message).toBeNull();
  const events = await env.DATABASE.prepare(
    "SELECT id FROM task_status_events WHERE task_id=? AND to_status='failed'"
  )
    .bind(fixture.taskId)
    .all();
  expect(events.results).toHaveLength(0);
}

describe('provider-limit admission and queued watchdog through the real scheduled handler', () => {
  it('preserves a task still held for a provider limit beyond the queued timeout', async () => {
    await seedElapsedHold();
    await tick();
    expect((await task())!.status).toBe('queued');
    expect((await task())!.admission_state).toBe('provider_limit_waiting');
    await expectNoFailure();
  });

  it('does not fail an old provider-limit hold released before the watchdog tick', async () => {
    await seedElapsedHold();
    await releaseHold();
    await tick();
    expect((await task())!.status).toBe('queued');
    await expectNoFailure();
  });

  it('still expires a released hold if runnable orchestration then makes no progress', async () => {
    await seedElapsedHold();
    await releaseHold();
    const releasedAt = (await task())!.updated_at;
    await tick();
    expect((await task())!.status).toBe('queued');
    // Mock Date only; real timers keep Worker RPC and waitUntil cleanup live.
    vi.setSystemTime(Date.now() + DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS + 60_000);
    await releaseHold();
    expect((await task())!.updated_at).toBe(releasedAt);
    await tick();
    expect((await task())!.status).toBe('failed');
    expect((await task())!.error_message).toContain('queued');
  });

  it('does not fail an old blocked admission hold explicitly resumed by its owner before first launch', async () => {
    await seedElapsedHold();
    const project = bindings.PROJECT_DATA.get(bindings.PROJECT_DATA.idFromName(fixture.projectId));
    const chatSessionId = await project.createSession(null, 'Held before first launch');
    await env.DATABASE.prepare(
      `UPDATE tasks SET chat_session_id=?, admission_state='provider_limit_blocked',
       provider_limit_wait_json=json_set(provider_limit_wait_json, '$.phase', 'blocked') WHERE id=?`
    )
      .bind(chatSessionId, fixture.taskId)
      .run();
    const row = await drizzle(env.DATABASE, { schema })
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, fixture.taskId))
      .get();
    const nudge = vi.fn(async () => true);
    const ownerBindings = {
      ...bindings,
      TASK_RUNNER: {
        idFromName: bindings.TASK_RUNNER.idFromName.bind(bindings.TASK_RUNNER),
        get: () => ({ nudge }),
      },
    } as unknown as Env;
    expect(await resumeProviderLimitTask(ownerBindings, row!, fixture.userId)).toMatchObject({
      status: 'waking',
    });
    expect(nudge).toHaveBeenCalledOnce();
    expect((await task())!.provider_limit_wait_json).toBeNull();
    await tick();
    expect((await task())!.status).toBe('queued');
    await expectNoFailure();
  });

  it('does not fail an old provider-limit hold released after the candidate read', async () => {
    await seedElapsedHold();
    let releases = 0;
    await tick({
      DATABASE: afterTaskRead(async () => {
        releases++;
        await releaseHold();
      }),
    });
    expect(releases).toBe(1);
    expect((await task())!.status).toBe('queued');
    await expectNoFailure();
  });

  it('still fails a genuinely stuck queued task with no hold using the production timeout', async () => {
    await tick();
    const current = (await task())!;
    expect(current.status).toBe('failed');
    expect(current.error_message).toContain('queued');
    expect(current.error_message).not.toContain('Node provisioning may have failed silently');
  });

  it.each([
    { read: 'candidate', status: 'delegated', assignWorkspace: true },
    { read: 'terminal', status: 'delegated', assignWorkspace: true },
    { read: 'terminal', status: 'delegated', assignWorkspace: false },
    // Workspace identity can advance while the task remains queued.
    { read: 'terminal', status: 'queued', assignWorkspace: true },
  ] as const)(
    'does not fail after the $read read advances to $status (workspace assignment: $assignWorkspace)',
    async ({ read, status, assignWorkspace }) => {
      const workspaceId = `placed-${fixture.taskId}`;
      await seedWorkspace(workspaceId, null, fixture.userId, { projectId: fixture.projectId });
      let placements = 0;
      await tick({
        DATABASE: afterTaskRead(async () => {
          placements++;
          await env.DATABASE.prepare(
            "UPDATE tasks SET status=?, workspace_id=?, execution_step='workspace_creation', updated_at=? WHERE id=?"
          )
            // Keep updated_at unchanged to prove status/workspace fences independently.
            .bind(status, assignWorkspace ? workspaceId : null, fixture.old, fixture.taskId)
            .run();
        }, read),
      });
      expect(placements).toBe(1);
      expect((await task())!).toMatchObject({
        status,
        workspace_id: assignWorkspace ? workspaceId : null,
      });
      await expectNoFailure();
    }
  );
});
