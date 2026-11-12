/** Shared real-SQLite owner HTTP slice. Only auth/decryption and the runner boundary are doubled. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { runMigrations } from '../../src/durable-objects/migrations';
import { syncProviderLimitAttention } from '../../src/durable-objects/project-data/provider-limit-attention';
import { resolveSessionAccess } from '../../src/durable-objects/project-data/session-access';
import { getSession } from '../../src/durable-objects/project-data/session-reads';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { providerLimitResumeRoutes } from '../../src/routes/tasks/provider-limit-resume';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';
import {
  newProviderLimitWait,
  type ProviderLimitWait,
} from '../../src/services/provider-limit-policy';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';
import { pickStarterMachines } from './capacity-pool-picks';
import { createAllSchemaTables } from './sqlite-d1';
import { createEvictionEnv, seedEvictionOwnerAndNode } from './workspace-eviction-route-harness';

const boundary = vi.hoisted(() => ({
  userId: 'user-1',
  start: vi.fn(),
  nudge: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  status: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  selected: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
  sql: null as unknown as SqlStorage,
}));
vi.mock('../../src/middleware/auth', () => ({
  getUserId: () => boundary.userId,
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
// Credential decryption is outside this slice. Profile resolution, source generation,
// credential reference comparison and every persistence predicate remain real.
vi.mock('../../src/services/agent-key-resolution', () => ({
  getSelectedAgentCredentialReference: (...args: unknown[]) => boundary.selected(...args),
}));
vi.mock('../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: (...args: unknown[]) => boundary.start(...args),
  ensureTaskRunnerStarted: vi.fn(async () => false),
  nudgeTaskRunnerDO: (...args: unknown[]) => boundary.nudge(...args),
  getTaskRunnerStatus: (...args: unknown[]) => boundary.status(...args),
}));
vi.mock('../../src/services/project-data', () => ({
  getSessionAccess: async (_env: unknown, _project: string, sessionId: string, userId: string) => ({
    session: getSession(boundary.sql, sessionId),
    access: resolveSessionAccess(boundary.sql, sessionId, userId),
  }),
  getSession: async (_env: unknown, _project: string, sessionId: string) =>
    getSession(boundary.sql, sessionId),
  syncProviderLimitAttention: async (
    env: Env,
    projectId: string,
    taskId: string,
    sessionId: string
  ) => syncProviderLimitAttention(boundary.sql, env.DATABASE, { projectId, taskId, sessionId }),
}));

export { boundary };

export async function createOwnerResumeHarness(vars: Partial<Env> = {}) {
  const d1 = new Database(':memory:');
  createAllSchemaTables(d1, schema);
  const env = createEvictionEnv(d1, { ENCRYPTION_KEY: 'test-key', ...vars });
  seedEvictionOwnerAndNode(d1);
  const db = drizzle(env.DATABASE, { schema });
  // External catalog fixture; pool publication, owner picks and placement stay real.
  await ensureDefaultCapacityPoolsForExistingCredentials(db, {
    userId: 'user-1',
    projectId: 'project-1',
    includeInstallation: true,
    env,
    offeringResolver: async () => [
      {
        provider: 'hetzner',
        location: 'nbg1',
        providerInstanceType: 'cx23',
        providerInstanceSku: null,
        displayName: 'Test VM',
        vcpu: 2,
        memoryMb: 4096,
        diskGb: 40,
        currency: 'EUR',
        priceMonthly: 10,
        catalogSource: 'api',
        catalogLastSeenAt: new Date().toISOString(),
        available: true,
      },
    ],
  });
  await pickStarterMachines(db);
  const local = new Database(':memory:');
  boundary.sql = createSqlStorage(local);
  runMigrations(boundary.sql);
  boundary.sql
    .exec(`INSERT INTO chat_sessions(id,task_id,created_by_user_id,status,topic,message_count,started_at,created_at,updated_at)
      VALUES ('chat-1','task-1','user-1','sleeping','Task',1,1,1,1)`);
  d1.exec(`INSERT INTO agent_profiles(id,project_id,user_id,name,agent_type)
      VALUES ('profile-1','project-1','user-1','Claude','claude-code');
      INSERT INTO workspaces(id,user_id,project_id,node_id,status,branch,vm_size,vm_location,workspace_profile,created_at,updated_at)
      VALUES ('workspace-1','user-1','project-1','node-1','deleted','main','small','nbg1','lightweight',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO tasks(id,project_id,user_id,chat_session_id,agent_profile_hint,title,status,priority,task_mode,dispatch_depth,triggered_by,created_by,created_at,updated_at)
      VALUES ('task-1','project-1','user-1','chat-1','profile-1','Task','queued',0,'task',0,'mcp','user-1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO agent_sessions(id,workspace_id,user_id,status,agent_type,agent_profile_id,agent_credential_reference,agent_credential_generation)
      VALUES ('source-1','workspace-1','user-1','stopped','claude-code','profile-1','cc_credentials:account-1',7);
      INSERT INTO session_snapshots(id,project_id,user_id,chat_session_id,workspace_id,node_id,runtime,status,degradation,manifest_r2_key,manifest_json,expires_at,sleeping_at,sleep_status,recovery_status,recovery_task_id,recovery_attempt_id,recovery_attempts,sleep_attempts,created_at,updated_at)
      VALUES ('snapshot-1','project-1','user-1','chat-1','workspace-1','node-1','vm','available','none','retained/wip','{}','2099-01-01T00:00:00Z',CURRENT_TIMESTAMP,'sleeping','waking','task-1','existing-claim',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  setWait({
    ...newProviderLimitWait({
      taskId: 'task-1',
      origin: 'callback',
      incidentId: 'rejected-prompt-1',
      credentialKey: 'cc_credentials:account-1',
      previous: null,
      now: Date.now(),
      resetsAt: Date.now() + 8 * 60 * 60_000,
      jitter: 0,
    }),
    sourceAgentSessionId: 'source-1',
    sourceCredentialGeneration: 7,
  });
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode)
      : c.json({ error: String(error) }, 500)
  );
  app.route('/projects/:projectId/tasks', providerLimitResumeRoutes);
  function task() {
    return d1.prepare("SELECT * FROM tasks WHERE id='task-1'").get() as Record<string, unknown>;
  }
  function claim() {
    return d1.prepare('SELECT * FROM session_snapshots').get() as Record<string, unknown>;
  }
  function wait(): ProviderLimitWait {
    return JSON.parse(task().provider_limit_wait_json as string);
  }
  function setWait(value: ProviderLimitWait) {
    d1.prepare(
      "UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_waiting',admission_reason=?,admission_next_retry_at=? WHERE id='task-1'"
    ).run(JSON.stringify(value), value.reason, new Date(value.nextRetryAt).toISOString());
  }
  function resume(project = 'project-1') {
    return app.request(
      `/projects/${project}/tasks/task-1/provider-limit/start-anyway`,
      { method: 'POST' },
      env
    );
  }
  return {
    d1,
    local,
    env,
    task,
    claim,
    wait,
    setWait,
    resume,
    close: () => {
      d1.close();
      local.close();
    },
  };
}
