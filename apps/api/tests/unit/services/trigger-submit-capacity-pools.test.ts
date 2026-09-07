import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  createReservedTaskSessionWithInitialMessage: vi.fn(),
  stopSession: vi.fn(),
  getSession: vi.fn(),
  resolveSkillProfile: vi.fn(),
  requireRepositoryOwnerAccess: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  ensureTaskRunnerStarted: vi.fn(),
  generateTaskTitle: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  createReservedTaskSessionWithInitialMessage: mocks.createReservedTaskSessionWithInitialMessage,
  stopSession: mocks.stopSession,
  getSession: mocks.getSession,
}));

vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryOwnerAccess: mocks.requireRepositoryOwnerAccess,
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
  ensureTaskRunnerStarted: mocks.ensureTaskRunnerStarted,
}));

vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: mocks.generateTaskTitle,
  getTaskTitleConfig: vi.fn(() => ({})),
}));

vi.mock('../../../src/services/agent-profiles', () => ({
  resolveAgentProfile: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/services/skills', () => ({
  resolveSkillProfile: mocks.resolveSkillProfile,
  parseSkillResourceRequirementsJson: vi.fn(() => ({})),
}));

const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');

function createEnv() {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  return {
    sqlite,
    env: {
      DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
      BASE_DOMAIN: 'sammy.party',
      BRANCH_NAME_PREFIX: 'sam/',
      BRANCH_NAME_MAX_LENGTH: '60',
      DEFAULT_TASK_AGENT_TYPE: 'opencode',
    } as Env,
  };
}

function seedTriggerRows(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO users (id, email, name, role, status, github_id)
       VALUES ('user-1', 'user-1@example.com', 'User One', 'user', 'active', '12345')`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO projects (
         id, user_id, name, normalized_name, installation_id, repository,
         default_branch, default_provider, default_location, default_vm_size,
         status, created_by
       )
       VALUES (
         'project-1', 'user-1', 'Capacity Project', 'capacity-project',
         'installation-1', 'acme/capacity-project', 'main',
         'hetzner', 'fsn1', 'small', 'active', 'user-1'
       )`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, status)
       VALUES ('project-1', 'user-1', 'owner', 'active')`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO credentials (
         id, user_id, project_id, provider, credential_type, credential_kind,
         is_active, encrypted_token, iv, created_at, updated_at
       )
       VALUES (
         'project-cloud-1', 'user-1', 'project-1', 'hetzner',
         'cloud-provider', 'api-key', 1, 'encrypted-token', 'iv',
         '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z'
       )`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO trigger_executions (
         id, trigger_id, project_id, status, rendered_prompt, scheduled_at,
         sequence_number, created_at
       )
       VALUES (
         'exec-1', 'trigger-1', 'project-1', 'queued', 'Run the scheduled job',
         '2026-09-07T00:00:00.000Z', 1, '2026-09-07T00:00:00.000Z'
       )`
    )
    .run();
}

async function seedProjectDefaultPool(env: Env): Promise<void> {
  await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
    userId: 'user-1',
    projectId: 'project-1',
    includeInstallation: false,
  });
}

describe('submitTriggeredTask capacity-pool integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createReservedTaskSessionWithInitialMessage.mockResolvedValue({
      outcome: 'created',
      sessionId: 'chat_exec-1',
      initialMessageId: 'msg_exec-1',
      sessionInserted: true,
      initialMessageInserted: true,
    });
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.getSession.mockResolvedValue({ id: 'chat_exec-1', taskId: 'exec-1', createdByUserId: 'user-1', status: 'active' });
    mocks.resolveSkillProfile.mockResolvedValue(null);
    mocks.requireRepositoryOwnerAccess.mockResolvedValue(undefined);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
    mocks.ensureTaskRunnerStarted.mockResolvedValue(false);
    mocks.generateTaskTitle.mockResolvedValue('Triggered capacity task');
  });

  it.each([null, 'skill-1'])('uses centralized placement and persists selected skill %s through reserved task submission', async (skillId) => {
    const { sqlite, env } = createEnv();
    seedTriggerRows(sqlite);
    await seedProjectDefaultPool(env);
    if (skillId) mocks.resolveSkillProfile.mockResolvedValue({
      skillId, skillHint: skillId, profileId: null, agentType: 'opencode', resourceRequirementsJson: null,
    });

    await submitTriggeredTask(env, {
      triggerId: 'trigger-1',
      triggerExecutionId: 'exec-1',
      projectId: 'project-1',
      userId: 'user-1',
      renderedPrompt: 'Run the scheduled job',
      triggeredBy: 'cron',
      agentProfileId: null,
      skillId,
      taskMode: 'task',
      vmSizeOverride: null,
      triggerName: 'Scheduled Capacity',
    });

    const taskRow = sqlite
      .prepare(
        `SELECT
           skill_id, skill_hint,
           capacity_pool_id,
           capacity_pool_scope,
           capacity_source_id,
           capacity_pool_candidate_id,
           placement_credential_source,
           placement_credential_reference,
           provider_instance_type,
           provider_instance_vcpu_count,
           provider_instance_memory_mb,
           provider_instance_disk_gb
         FROM tasks
         WHERE project_id = 'project-1'`
      )
      .get() as Record<string, unknown>;

    expect(taskRow).toMatchObject({
      skill_id: skillId, skill_hint: skillId,
      capacity_pool_id: 'cap-pool-default:project:project-1',
      capacity_pool_scope: 'project',
      capacity_source_id: 'cap-source-default:project:project-cloud-1',
      placement_credential_source: 'project',
      placement_credential_reference: 'credentials:project-cloud-1',
      provider_instance_type: 'cx23',
      provider_instance_vcpu_count: 2,
      provider_instance_memory_mb: 4096,
      provider_instance_disk_gb: 40,
    });
    if (skillId) expect(mocks.resolveSkillProfile).toHaveBeenCalledWith(
      expect.anything(), 'project-1', null, skillId, 'user-1', env
    );
    expect(String(taskRow.capacity_pool_candidate_id)).toContain(':hetzner:nbg1:cx23');
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        taskId: expect.any(String),
        projectId: 'project-1',
        userId: 'user-1',
        cloudProvider: 'hetzner',
        credentialAttributionProjectId: 'project-1',
        credentialAttributionSource: 'project',
        capacityPoolSelection: expect.objectContaining({
          poolId: 'cap-pool-default:project:project-1',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              provider: 'hetzner',
              location: 'nbg1',
              providerInstanceType: 'cx23',
            }),
          ]),
        }),
      })
    );
  });
});
