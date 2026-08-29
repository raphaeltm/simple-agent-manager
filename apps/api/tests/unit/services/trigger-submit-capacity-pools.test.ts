import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  stopSession: vi.fn(),
  requireRepositoryOwnerAccess: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  ensureTaskRunnerStarted: vi.fn(),
  generateTaskTitle: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: mocks.createSession,
  persistMessage: mocks.persistMessage,
  stopSession: mocks.stopSession,
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
  resolveSkillProfile: vi.fn().mockResolvedValue(null),
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
}

describe('submitTriggeredTask capacity-pool integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue('session-1');
    mocks.persistMessage.mockResolvedValue(undefined);
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.requireRepositoryOwnerAccess.mockResolvedValue(undefined);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
    mocks.ensureTaskRunnerStarted.mockResolvedValue(false);
    mocks.generateTaskTitle.mockResolvedValue('Triggered capacity task');
  });

  it('uses centralized placement to persist concrete pool snapshots and start TaskRunner', async () => {
    const { sqlite, env } = createEnv();
    seedTriggerRows(sqlite);

    await submitTriggeredTask(env, {
      triggerId: 'trigger-1',
      triggerExecutionId: 'exec-1',
      projectId: 'project-1',
      userId: 'user-1',
      renderedPrompt: 'Run the scheduled job',
      triggeredBy: 'cron',
      agentProfileId: null,
      skillId: null,
      taskMode: 'task',
      vmSizeOverride: null,
      triggerName: 'Scheduled Capacity',
    });

    const taskRow = sqlite
      .prepare(
        `SELECT
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
    expect(String(taskRow.capacity_pool_candidate_id)).toContain(':hetzner:fsn1:cx23');
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
              location: 'fsn1',
              providerInstanceType: 'cx23',
            }),
          ]),
        }),
      })
    );
  });
});
