/**
 * Finding 4 — offboarding must follow the trigger's EFFECTIVE executor.
 *
 * `triggers.user_id` is the creator; `triggers.execution_user_id` is the
 * principal a keep-active transfer authorized, and it is what the runtime
 * actually executes as. Offboarding inventoried by creator, so:
 *
 *  - transfer A -> B, then offboard B: the trigger was never inventoried, and B
 *    was removed while the trigger still executed as B; and
 *  - self-offboarding installed the departing actor as the principal, and the
 *    removal below then left the trigger executing as a removed member.
 *
 * Everything runs against a real SQL engine through the real preview/apply
 * services and the real trigger-admission path — the inventory fix IS a SQL
 * predicate, so a mock that ignores its WHERE clause would pass with it deleted
 * (rule 28), and the "next actual execution" claim is only meaningful when the
 * production admission code chooses the principal (rule 62).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { type AppDb, requireProjectCapability } from '../../../src/middleware/project-auth';
import { applyProjectMemberOffboarding } from '../../../src/services/project-offboarding-apply';
import { createProjectMemberOffboardingPreview } from '../../../src/services/project-offboarding-preview';
import { admitAndSubmitTriggerExecution } from '../../../src/services/trigger-admission';
import { resolveTriggerExecutionUserId } from '../../../src/services/trigger-execution-principal';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT_ID = 'proj-1';
const NOW = '2026-09-07T00:00:00.000Z';

interface Fixture {
  sqlite: Database.Database;
  env: Env;
  db: AppDb;
  project: schema.Project;
}

function seedMember(sqlite: Database.Database, userId: string, role: string): void {
  sqlite
    .prepare(
      `INSERT INTO users (id, email, role, status) VALUES (?, ?, 'user', 'active')`
    )
    .run(userId, `${userId}@example.com`);
  sqlite
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`
    )
    .run(PROJECT_ID, userId, role, NOW, NOW);
}

/**
 * Project-level credential coverage owned by a member who is NOT departing.
 * Without it every trigger recommends break_and_flag and the keep-active path is
 * never reached.
 */
function seedProjectCoverage(sqlite: Database.Database, ownerId: string): void {
  const rows: ReadonlyArray<[kind: string, target: string]> = [
    ['agent', 'claude-code'],
    ['compute', 'hetzner'],
  ];
  for (const [kind, target] of rows) {
    sqlite
      .prepare(
        `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active,
           created_at, updated_at)
         VALUES (?, ?, ?, 'api-key', 'enc', 'iv', 1, ?, ?)`
      )
      .run(`cred-${kind}`, ownerId, `${kind} credential`, NOW, NOW);
    sqlite
      .prepare(
        `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target,
           credential_id, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(`conf-${kind}`, ownerId, `${kind} config`, kind, target, `cred-${kind}`, NOW, NOW);
    sqlite
      .prepare(
        `INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target,
           user_id, project_id, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(`att-${kind}`, `conf-${kind}`, kind, target, ownerId, PROJECT_ID, NOW, NOW);
  }
}

function seedTrigger(
  sqlite: Database.Database,
  input: { id: string; creatorUserId: string; executionUserId?: string | null }
): void {
  sqlite
    .prepare(
      `INSERT INTO triggers (
         id, project_id, user_id, name, source_type, status, prompt_template,
         task_mode, skip_if_running, max_concurrent, next_execution_sequence,
         cron_expression, execution_user_id, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, 'cron', 'active', 'Do the thing', 'task', 0, 1, 1,
         '0 9 * * *', ?, ?, ?)`
    )
    .run(
      input.id,
      PROJECT_ID,
      input.creatorUserId,
      `Trigger ${input.id}`,
      input.executionUserId ?? null,
      NOW,
      NOW
    );
}

function createFixture(members: ReadonlyArray<[userId: string, role: string]>): Fixture {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  const [ownerId] = members[0]!;
  sqlite
    .prepare(
      `INSERT INTO projects (
         id, user_id, name, normalized_name, installation_id, repository, default_branch,
         default_provider, default_agent_type, status, created_by, created_at, updated_at
       )
       VALUES (?, ?, 'Shared', 'shared', 'inst-1', 'acme/repo', 'main', 'hetzner',
         'claude-code', 'active', ?, ?, ?)`
    )
    .run(PROJECT_ID, ownerId, ownerId, NOW, NOW);
  for (const [userId, role] of members) seedMember(sqlite, userId, role);

  const env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'sammy.party' } as Env;
  const db = drizzle(env.DATABASE, { schema }) as AppDb;
  const project = sqlite.prepare(`SELECT * FROM projects WHERE id = ?`).get(PROJECT_ID) as never;
  return {
    sqlite,
    env,
    db,
    project: {
      id: PROJECT_ID,
      defaultAgentType: 'claude-code',
      defaultProvider: 'hetzner',
      ...(project as object),
    } as schema.Project,
  };
}

function storedTrigger(sqlite: Database.Database, id: string) {
  return sqlite.prepare(`SELECT * FROM triggers WHERE id = ?`).get(id) as unknown as {
    id: string;
    status: string;
    user_id: string;
    execution_user_id: string | null;
    execution_user_authorized_by: string | null;
    execution_user_authorized_at: string | null;
    credential_blocked_reason: string | null;
    project_id: string;
  };
}

async function previewAndApply(input: {
  fixture: Fixture;
  memberUserId: string;
  actorUserId: string;
  action: string;
}) {
  const preview = await createProjectMemberOffboardingPreview({
    db: input.fixture.db,
    database: input.fixture.env.DATABASE,
    project: input.fixture.project,
    memberUserId: input.memberUserId,
    requestedBy: input.actorUserId,
    defaultAgentType: 'claude-code',
  });

  const applied = await applyProjectMemberOffboarding({
    db: input.fixture.db,
    project: input.fixture.project,
    memberUserId: input.memberUserId,
    actorUserId: input.actorUserId,
    planId: preview.offboardingPlanId,
    actions: preview.resources.map((resource) => ({
      resourceKind: resource.resourceKind,
      resourceId: resource.resourceId,
      action: input.action as never,
    })),
    finalMemberStatus: 'removed',
    defaultAgentType: 'claude-code',
  });
  return { preview, applied };
}

/**
 * Drive the REAL trigger-admission path and capture the principal it hands the
 * submitter — this is the userId the next actual execution runs as.
 */
async function nextExecutionPrincipal(fixture: Fixture, triggerId: string): Promise<string> {
  const trigger = fixture.sqlite
    .prepare(
      `SELECT id, project_id AS projectId, user_id AS userId, execution_user_id AS executionUserId,
              status, name, source_type AS sourceType, agent_profile_id AS agentProfileId,
              skill_id AS skillId, task_mode AS taskMode, vm_size_override AS vmSizeOverride,
              resource_requirements_json AS resourceRequirementsJson,
              skip_if_running AS skipIfRunning, max_concurrent AS maxConcurrent
         FROM triggers WHERE id = ?`
    )
    .get(triggerId) as unknown as schema.TriggerRow;

  const submitter = vi.fn().mockResolvedValue({
    taskId: 'task-x',
    sessionId: 'session-x',
    branchName: 'sam/x',
  });
  const result = await admitAndSubmitTriggerExecution(
    fixture.env,
    {
      trigger,
      eventType: 'cron',
      triggeredBy: 'cron',
      renderPrompt: () => 'rendered prompt',
    },
    submitter as never
  );
  expect(result.outcome).toBe('submitted');
  // Clear the reservation this probe created so a later probe is admitted (or
  // rejected) on authority, never on the concurrency reservation.
  fixture.sqlite.prepare(`DELETE FROM trigger_executions`).run();
  return (submitter.mock.calls[0]?.[1] as { userId: string }).userId;
}

/** The exact gate submitTriggeredTask runs on the principal at execution time. */
async function principalPassesExecutionGate(db: AppDb, userId: string): Promise<boolean> {
  try {
    await requireProjectCapability(db, PROJECT_ID, userId, 'task:write');
    return true;
  } catch (err) {
    if (err instanceof AppError) return false;
    throw err;
  }
}

describe('offboarding follows the effective trigger execution principal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inventories a trigger transferred A -> B when B is offboarded', async () => {
    const fixture = createFixture([
      ['owner-1', 'owner'],
      ['user-a', 'admin'],
      ['user-b', 'admin'],
    ]);
    try {
      // A created it; a previous keep-active transfer moved execution to B.
      seedTrigger(fixture.sqlite, {
        id: 'trigger-1',
        creatorUserId: 'user-a',
        executionUserId: 'user-b',
      });

      const preview = await createProjectMemberOffboardingPreview({
        db: fixture.db,
        database: fixture.env.DATABASE,
        project: fixture.project,
        memberUserId: 'user-b',
        requestedBy: 'owner-1',
        defaultAgentType: 'claude-code',
      });

      const triggerResource = preview.resources.find(
        (resource) => resource.resourceKind === 'trigger'
      );
      expect(triggerResource).toBeDefined();
      // Attribution names the departing EXECUTOR, not the creator.
      expect(triggerResource?.attributionUserIdBefore).toBe('user-b');
      expect(triggerResource?.details).toMatchObject({
        creatorUserId: 'user-a',
        effectiveExecutionUserId: 'user-b',
      });
      expect(preview.canApply).toBe(false);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('does not flag a departing creator whose access the trigger no longer consumes', async () => {
    const fixture = createFixture([
      ['owner-1', 'owner'],
      ['user-a', 'admin'],
      ['user-b', 'admin'],
    ]);
    try {
      seedTrigger(fixture.sqlite, {
        id: 'trigger-1',
        creatorUserId: 'user-a',
        executionUserId: 'user-b',
      });

      const preview = await createProjectMemberOffboardingPreview({
        db: fixture.db,
        database: fixture.env.DATABASE,
        project: fixture.project,
        memberUserId: 'user-a',
        requestedBy: 'owner-1',
        defaultAgentType: 'claude-code',
      });

      expect(preview.resources.filter((r) => r.resourceKind === 'trigger')).toHaveLength(0);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('A -> B -> C: each transfer moves the principal and the next execution follows it', async () => {
    const fixture = createFixture([
      ['owner-1', 'owner'],
      ['user-a', 'admin'],
      ['user-b', 'admin'],
      ['user-c', 'admin'],
    ]);
    try {
      seedProjectCoverage(fixture.sqlite, 'owner-1');
      seedTrigger(fixture.sqlite, { id: 'trigger-1', creatorUserId: 'user-a' });

      // A departs; B (the acting admin) takes the principal.
      await previewAndApply({
        fixture,
        memberUserId: 'user-a',
        actorUserId: 'user-b',
        action: 'reattach_to_project',
      });
      expect(storedTrigger(fixture.sqlite, 'trigger-1').execution_user_id).toBe('user-b');
      expect(await nextExecutionPrincipal(fixture, 'trigger-1')).toBe('user-b');

      // B departs. Pre-fix this trigger was invisible here.
      const { preview } = await previewAndApply({
        fixture,
        memberUserId: 'user-b',
        actorUserId: 'user-c',
        action: 'reattach_to_project',
      });
      expect(preview.resources.some((r) => r.resourceKind === 'trigger')).toBe(true);

      const after = storedTrigger(fixture.sqlite, 'trigger-1');
      expect(after.execution_user_id).toBe('user-c');
      expect(after.status).toBe('active');
      // Creator attribution is untouched — only the executor moved.
      expect(after.user_id).toBe('user-a');
      expect(after.execution_user_authorized_by).toBe('user-c');
      expect(after.execution_user_authorized_at).toBe(after.execution_user_authorized_at);

      // Both departed members are actually removed...
      for (const removed of ['user-a', 'user-b']) {
        expect(
          (
            fixture.sqlite
              .prepare(`SELECT status FROM project_members WHERE user_id = ?`)
              .get(removed) as { status: string }
          ).status
        ).toBe('removed');
        expect(await principalPassesExecutionGate(fixture.db, removed)).toBe(false);
      }

      // ...and the next ACTUAL execution runs as an authorized remaining member.
      const principal = await nextExecutionPrincipal(fixture, 'trigger-1');
      expect(principal).toBe('user-c');
      expect(await principalPassesExecutionGate(fixture.db, principal)).toBe(true);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('self-offboarding installs another authorized owner, never the departing actor', async () => {
    const fixture = createFixture([
      ['owner-1', 'owner'],
      ['owner-2', 'owner'],
    ]);
    try {
      seedProjectCoverage(fixture.sqlite, 'owner-2');
      seedTrigger(fixture.sqlite, { id: 'trigger-1', creatorUserId: 'owner-1' });

      // owner-1 offboards themselves.
      await previewAndApply({
        fixture,
        memberUserId: 'owner-1',
        actorUserId: 'owner-1',
        action: 'reattach_to_project',
      });

      const after = storedTrigger(fixture.sqlite, 'trigger-1');
      expect(after.execution_user_id).toBe('owner-2');
      expect(after.execution_user_id).not.toBe('owner-1');
      expect(after.status).toBe('active');
      // The departing actor is still recorded as the approver of the transfer.
      expect(after.execution_user_authorized_by).toBe('owner-1');

      const principal = await nextExecutionPrincipal(fixture, 'trigger-1');
      expect(principal).toBe('owner-2');
      expect(await principalPassesExecutionGate(fixture.db, principal)).toBe(true);
      expect(await principalPassesExecutionGate(fixture.db, 'owner-1')).toBe(false);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('withholds reattach and keeps break_and_flag when no authorized member remains', async () => {
    // The departing member is an admin (so the sole-owner guard does not fire)
    // and every remaining member is a viewer, which cannot execute a trigger.
    const fixture = createFixture([
      ['admin-1', 'admin'],
      ['viewer-1', 'viewer'],
    ]);
    try {
      seedProjectCoverage(fixture.sqlite, 'viewer-1');
      seedTrigger(fixture.sqlite, { id: 'trigger-1', creatorUserId: 'admin-1' });

      const preview = await createProjectMemberOffboardingPreview({
        db: fixture.db,
        database: fixture.env.DATABASE,
        project: fixture.project,
        memberUserId: 'admin-1',
        requestedBy: 'admin-1',
        defaultAgentType: 'claude-code',
      });
      const triggerResource = preview.resources.find((r) => r.resourceKind === 'trigger');
      expect(triggerResource).toBeDefined();
      expect(triggerResource?.availableActions).not.toContain('reattach_to_project');
      expect(triggerResource?.availableActions).toContain('break_and_flag');
      expect(triggerResource?.details).toMatchObject({
        hasAuthorizedRemainingExecutionPrincipal: false,
      });

      // break_and_flag still disables the trigger rather than leaving it live
      // under a principal that cannot execute it.
      const applied = await applyProjectMemberOffboarding({
        db: fixture.db,
        project: fixture.project,
        memberUserId: 'admin-1',
        actorUserId: 'admin-1',
        planId: preview.offboardingPlanId,
        actions: preview.resources.map((resource) => ({
          resourceKind: resource.resourceKind,
          resourceId: resource.resourceId,
          action: 'break_and_flag' as never,
        })),
        finalMemberStatus: 'removed',
        defaultAgentType: 'claude-code',
      });
      expect(applied.status).toBe('removed');
      const after = storedTrigger(fixture.sqlite, 'trigger-1');
      expect(after.status).toBe('disabled');
      expect(after.credential_blocked_reason).toBe('member_removed');
    } finally {
      fixture.sqlite.close();
    }
  });

  it('never touches another project’s trigger', async () => {
    const fixture = createFixture([
      ['owner-1', 'owner'],
      ['user-b', 'admin'],
    ]);
    try {
      seedProjectCoverage(fixture.sqlite, 'owner-1');
      seedTrigger(fixture.sqlite, { id: 'trigger-1', creatorUserId: 'user-b' });
      // Same departing executor, different project.
      fixture.sqlite
        .prepare(
          `INSERT INTO triggers (id, project_id, user_id, name, source_type, status,
             prompt_template, task_mode, skip_if_running, max_concurrent,
             next_execution_sequence, execution_user_id, created_at, updated_at)
           VALUES ('trigger-other', 'proj-2', 'user-b', 'Other', 'cron', 'active', 'p',
             'task', 0, 1, 1, 'user-b', ?, ?)`
        )
        .run(NOW, NOW);

      const preview = await createProjectMemberOffboardingPreview({
        db: fixture.db,
        database: fixture.env.DATABASE,
        project: fixture.project,
        memberUserId: 'user-b',
        requestedBy: 'owner-1',
        defaultAgentType: 'claude-code',
      });
      expect(preview.resources.map((r) => r.resourceId)).toEqual(['trigger-1']);

      await applyProjectMemberOffboarding({
        db: fixture.db,
        project: fixture.project,
        memberUserId: 'user-b',
        actorUserId: 'owner-1',
        planId: preview.offboardingPlanId,
        actions: preview.resources.map((resource) => ({
          resourceKind: resource.resourceKind,
          resourceId: resource.resourceId,
          action: 'reattach_to_project' as never,
        })),
        finalMemberStatus: 'removed',
        defaultAgentType: 'claude-code',
      });

      const other = storedTrigger(fixture.sqlite, 'trigger-other');
      expect(other.execution_user_id).toBe('user-b');
      expect(other.status).toBe('active');
      expect(resolveTriggerExecutionUserId({
        executionUserId: other.execution_user_id,
        userId: other.user_id,
      } as never)).toBe('user-b');
    } finally {
      fixture.sqlite.close();
    }
  });
});
