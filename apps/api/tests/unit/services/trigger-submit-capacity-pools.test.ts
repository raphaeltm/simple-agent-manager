import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  stopSession: vi.fn(),
  requireRepositoryOwnerAccess: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  ensureTaskRunnerStarted: vi.fn(),
  generateTaskTitle: vi.fn(),
  resolveSkillProfile: vi.fn(),
  parseSkillResourceRequirementsJson: vi.fn(),
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
  resolveSkillProfile: mocks.resolveSkillProfile,
  parseSkillResourceRequirementsJson: mocks.parseSkillResourceRequirementsJson,
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
    mocks.createSession.mockResolvedValue('session-1');
    mocks.persistMessage.mockResolvedValue(undefined);
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.requireRepositoryOwnerAccess.mockResolvedValue(undefined);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
    mocks.ensureTaskRunnerStarted.mockResolvedValue(false);
    mocks.generateTaskTitle.mockResolvedValue('Triggered capacity task');
    mocks.resolveSkillProfile.mockResolvedValue(null);
    mocks.parseSkillResourceRequirementsJson.mockReturnValue({});
  });

  it('uses centralized placement to persist concrete pool snapshots and start TaskRunner', async () => {
    const { sqlite, env } = createEnv();
    seedTriggerRows(sqlite);
    await seedProjectDefaultPool(env);

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

  it('persists project resource requirements when trigger config omits them', async () => {
    const { sqlite, env } = createEnv();
    seedTriggerRows(sqlite);
    sqlite
      .prepare(
        `UPDATE projects
         SET resource_requirements_json = ?
         WHERE id = 'project-1'`
      )
      .run(JSON.stringify({ minVcpu: 2, exclusiveNode: false, minDiskGb: 0 }));
    await seedProjectDefaultPool(env);

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
      resourceRequirementsJson: null,
      triggerName: 'Scheduled Capacity',
    });

    const taskRow = sqlite
      .prepare(
        `SELECT resource_requirements_json, resource_requirements_source, resolved_reservation_json
         FROM tasks
         WHERE project_id = 'project-1'`
      )
      .get() as {
      resource_requirements_json: string | null;
      resource_requirements_source: string | null;
      resolved_reservation_json: string;
    };
    expect(JSON.parse(taskRow.resource_requirements_json ?? '{}')).toEqual({
      minVcpu: 2,
      exclusiveNode: false,
      minDiskGb: 0,
    });
    expect(taskRow.resource_requirements_source).toBe('project');
    const reservation = JSON.parse(taskRow.resolved_reservation_json) as {
      source: string;
      fieldProvenance: Record<string, { source: string; value: unknown }>;
    };
    expect(reservation.source).toBe('project');
    expect(reservation.fieldProvenance.minDiskGb).toMatchObject({
      source: 'project',
      value: 0,
    });
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        resourceRequirements: {
          minVcpu: 2,
          exclusiveNode: false,
          minDiskGb: 0,
        },
        resolvedReservation: expect.objectContaining({ source: 'project' }),
      })
    );
  });

  it('keeps trigger resource requirements above project defaults with per-field provenance', async () => {
    const { sqlite, env } = createEnv();
    seedTriggerRows(sqlite);
    sqlite
      .prepare(
        `UPDATE projects
         SET resource_requirements_json = ?
         WHERE id = 'project-1'`
      )
      .run(JSON.stringify({ minVcpu: 2, exclusiveNode: false, minDiskGb: 0 }));
    await seedProjectDefaultPool(env);

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
      resourceRequirementsJson: JSON.stringify({ minMemoryGb: 4 }),
      triggerName: 'Scheduled Capacity',
    });

    const taskRow = sqlite
      .prepare(
        `SELECT resource_requirements_json, resource_requirements_source, resolved_reservation_json
         FROM tasks
         WHERE project_id = 'project-1'`
      )
      .get() as {
      resource_requirements_json: string | null;
      resource_requirements_source: string | null;
      resolved_reservation_json: string;
    };
    expect(JSON.parse(taskRow.resource_requirements_json ?? '{}')).toEqual({ minMemoryGb: 4 });
    expect(taskRow.resource_requirements_source).toBe('trigger');
    const reservation = JSON.parse(taskRow.resolved_reservation_json) as {
      source: string;
      fieldProvenance: Record<string, { source: string; value: unknown }>;
    };
    expect(reservation.source).toBe('trigger');
    expect(reservation.fieldProvenance.minMemoryGb).toMatchObject({
      source: 'trigger',
      value: 4,
    });
    expect(reservation.fieldProvenance.minVcpu).toMatchObject({
      source: 'project',
      value: 2,
    });
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        resourceRequirements: { minMemoryGb: 4 },
        resolvedReservation: expect.objectContaining({ source: 'trigger' }),
      })
    );
  });

  it('persists trigger, skill, profile, and project layers in the versioned plan', async () => {
    const { sqlite, env } = createEnv();
    seedTriggerRows(sqlite);
    sqlite
      .prepare(`UPDATE projects SET resource_requirements_json = ? WHERE id = 'project-1'`)
      .run(JSON.stringify({ exclusiveNode: false }));
    mocks.resolveSkillProfile.mockResolvedValueOnce({
      profileId: 'profile-1',
      skillId: 'skill-1',
      agentType: 'claude-code',
      model: null,
      effort: 'auto',
      permissionMode: null,
      systemPromptAppend: null,
      vmSizeOverride: null,
      skillVmSizeOverride: null,
      agentProfileVmSizeOverride: null,
      provider: null,
      vmLocation: null,
      workspaceProfile: null,
      runtime: null,
      devcontainerConfigName: null,
      taskMode: null,
      resourceRequirementsJson: JSON.stringify({ minMemoryGb: 12 }),
      agentProfileResourceRequirementsJson: JSON.stringify({ minDiskGb: 0 }),
    });
    await seedProjectDefaultPool(env);

    await submitTriggeredTask(env, {
      triggerId: 'trigger-1',
      triggerExecutionId: 'exec-1',
      projectId: 'project-1',
      userId: 'user-1',
      renderedPrompt: 'Run the scheduled job',
      triggeredBy: 'cron',
      agentProfileId: 'profile-1',
      skillId: 'skill-1',
      taskMode: 'task',
      vmSizeOverride: null,
      resourceRequirementsJson: JSON.stringify({ minVcpu: 4 }),
      triggerName: 'Scheduled Capacity',
    });

    const taskRow = sqlite
      .prepare(
        `SELECT resource_requirements_json, resource_requirement_plan_json,
          resource_requirements_source, resolved_reservation_json
         FROM tasks
         WHERE project_id = 'project-1'`
      )
      .get() as {
      resource_requirements_json: string | null;
      resource_requirement_plan_json: string;
      resource_requirements_source: string | null;
      resolved_reservation_json: string;
    };
    expect(JSON.parse(taskRow.resource_requirements_json ?? '{}')).toEqual({ minVcpu: 4 });
    expect(taskRow.resource_requirements_source).toBe('trigger');
    const plan = JSON.parse(taskRow.resource_requirement_plan_json) as {
      intent: Record<string, unknown>;
    };
    expect(plan.intent).toMatchObject({
      trigger: { minVcpu: 4 },
      skill: { minMemoryGb: 12 },
      agentProfile: { minDiskGb: 0 },
      project: { exclusiveNode: false },
    });
    const reservation = JSON.parse(taskRow.resolved_reservation_json) as {
      cpuMillis: number;
      memoryMb: number;
      diskMb: number;
      exclusiveNode: boolean;
      fieldProvenance: Record<string, { source: string; value: unknown }>;
    };
    expect(reservation).toMatchObject({
      cpuMillis: 4000,
      memoryMb: 12 * 1024,
      diskMb: 0,
      exclusiveNode: false,
    });
    expect(reservation.fieldProvenance.minVcpu).toMatchObject({
      source: 'trigger',
      value: 4,
    });
    expect(reservation.fieldProvenance.minMemoryGb).toMatchObject({
      source: 'skill',
      value: 12,
    });
    expect(reservation.fieldProvenance.minDiskGb).toMatchObject({
      source: 'agent-profile',
      value: 0,
    });
  });

  it('rejects removed trigger execution principals before task/session/runner side effects', async () => {
    const { sqlite, env } = createEnv();
    seedTriggerRows(sqlite);
    sqlite
      .prepare(
        `UPDATE project_members
         SET status = 'removed'
         WHERE project_id = 'project-1' AND user_id = 'user-1'`
      )
      .run();

    await expect(
      submitTriggeredTask(env, {
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
        resourceRequirementsJson: null,
        triggerName: 'Scheduled Capacity',
      })
    ).rejects.toThrow(/execution principal is not a current project member/);

    expect(mocks.resolveSkillProfile).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.persistMessage).not.toHaveBeenCalled();
    expect(mocks.requireRepositoryOwnerAccess).not.toHaveBeenCalled();
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
  });

  it('allows active trigger execution principals to use shared project credentials', async () => {
    const { sqlite, env } = createEnv();
    seedTriggerRows(sqlite);
    sqlite
      .prepare(
        `INSERT INTO users (id, email, name, role, status, github_id)
         VALUES ('member-1', 'member-1@example.com', 'Member One', 'user', 'active', '67890')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status)
         VALUES ('project-1', 'member-1', 'maintainer', 'active')`
      )
      .run();
    await seedProjectDefaultPool(env);

    await submitTriggeredTask(env, {
      triggerId: 'trigger-1',
      triggerExecutionId: 'exec-1',
      projectId: 'project-1',
      userId: 'member-1',
      renderedPrompt: 'Run the scheduled job',
      triggeredBy: 'cron',
      agentProfileId: null,
      skillId: null,
      taskMode: 'task',
      vmSizeOverride: null,
      resourceRequirementsJson: null,
      triggerName: 'Scheduled Capacity',
    });

    const taskRow = sqlite
      .prepare(
        `SELECT user_id, credential_attribution_user_id, credential_attribution_project_id,
          credential_attribution_source, placement_credential_source
         FROM tasks
         WHERE project_id = 'project-1'`
      )
      .get() as Record<string, unknown>;
    expect(taskRow).toMatchObject({
      user_id: 'member-1',
      credential_attribution_user_id: 'member-1',
      credential_attribution_project_id: 'project-1',
      credential_attribution_source: 'project',
      placement_credential_source: 'project',
    });
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        userId: 'member-1',
        credentialAttributionUserId: 'member-1',
        credentialAttributionProjectId: 'project-1',
        credentialAttributionSource: 'project',
      })
    );
  });
});
