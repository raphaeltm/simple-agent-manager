import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { startTaskRunnerDO } from '../../../src/services/task-runner-do';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

const projectDataBoundary = vi.hoisted(() => {
  type Message = { id: string; role: string; content: string; toolMetadata: string | null };
  type Session = {
    projectId: string;
    id: string;
    taskId: string | null;
    createdByUserId: string | null;
    topic: string | null;
    status: 'active' | 'stopped' | 'failed';
    messages: Map<string, Message>;
  };

  const sessions = new Map<string, Session>();

  function findMessage(id: string): { session: Session; message: Message } | null {
    for (const session of sessions.values()) {
      const message = session.messages.get(id);
      if (message) return { session, message };
    }
    return null;
  }

  return {
    sessions,
    reset: () => sessions.clear(),
    createReservedTaskSessionWithInitialMessage: vi.fn(async (_env, projectId, input) => {
      const existingSession = sessions.get(input.sessionId) ?? null;
      if (existingSession?.status === 'stopped' || existingSession?.status === 'failed') {
        return {
          outcome: 'conflict',
          reason: 'session_terminal',
          message: `Session ${input.sessionId} is ${existingSession.status}`,
        };
      }
      if (
        existingSession &&
        (existingSession.projectId !== projectId ||
          existingSession.taskId !== input.taskId ||
          existingSession.createdByUserId !== input.createdByUserId ||
          existingSession.topic !== input.topic)
      ) {
        return {
          outcome: 'conflict',
          reason: 'session_identity_conflict',
          message: `Session ${input.sessionId} already belongs to a different task submission`,
        };
      }

      const existingMessage = findMessage(input.initialMessageId);
      if (
        existingMessage &&
        (existingMessage.session.id !== input.sessionId ||
          existingMessage.message.role !== input.initialMessageRole ||
          existingMessage.message.content !== input.initialMessageContent)
      ) {
        return {
          outcome: 'conflict',
          reason: 'initial_message_conflict',
          message: `Message id ${input.initialMessageId} already belongs to a different transcript entry`,
        };
      }

      const sessionInserted = !existingSession;
      const session = existingSession ?? {
        projectId,
        id: input.sessionId,
        taskId: input.taskId,
        createdByUserId: input.createdByUserId,
        topic: input.topic,
        status: 'active',
        messages: new Map<string, Message>(),
      };
      sessions.set(input.sessionId, session);

      const initialMessageInserted = !session.messages.has(input.initialMessageId);
      if (initialMessageInserted) {
        session.messages.set(input.initialMessageId, {
          id: input.initialMessageId,
          role: input.initialMessageRole,
          content: input.initialMessageContent,
          toolMetadata: input.initialMessageToolMetadata,
        });
      }

      return {
        outcome: 'created',
        sessionId: input.sessionId,
        initialMessageId: input.initialMessageId,
        sessionInserted,
        initialMessageInserted,
      };
    }),
    stopSession: vi.fn(async (_env, _projectId, sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return false;
      session.status = 'stopped';
      return true;
    }),
  };
});

vi.mock('../../../src/services/project-data', () => ({
  createReservedTaskSessionWithInitialMessage:
    projectDataBoundary.createReservedTaskSessionWithInitialMessage,
  stopSession: projectDataBoundary.stopSession,
}));

const { reservedIdentitiesForTriggerExecution, submitReservedTask } =
  await import('../../../src/services/reserved-task-submission');

type ReservedTaskSubmissionDependencies = NonNullable<Parameters<typeof submitReservedTask>[2]>;
type ReservedTaskSubmissionInput = Parameters<typeof submitReservedTask>[1];
type TaskRunnerStartInput = Parameters<typeof startTaskRunnerDO>[1];

type ReservedFixture = {
  sqlite: Database.Database;
  env: Env;
  userId: string;
  projectId: string;
  triggerId: string;
  executionId: string;
  input: ReservedTaskSubmissionInput;
};

let counter = 0;

function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function createReservedIndexes(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE UNIQUE INDEX idx_task_submission_checkpoints_chat_session
      ON task_submission_checkpoints(chat_session_id);
    CREATE UNIQUE INDEX idx_task_submission_checkpoints_initial_message
      ON task_submission_checkpoints(initial_message_id);
    CREATE UNIQUE INDEX idx_task_submission_checkpoints_initial_status_event
      ON task_submission_checkpoints(initial_status_event_id);
    CREATE UNIQUE INDEX idx_task_submission_checkpoints_source
      ON task_submission_checkpoints(project_id, source_kind, source_id, source_execution_id);
  `);
}

function createEnv(): { sqlite: Database.Database; env: Env } {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  createReservedIndexes(sqlite);
  return {
    sqlite,
    env: {
      DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
      BRANCH_NAME_PREFIX: 'sam/',
      BRANCH_NAME_MAX_LENGTH: '60',
      DEFAULT_TASK_AGENT_TYPE: 'opencode',
    } as Env,
  };
}

function seedReservedFixture(label: string): ReservedFixture {
  const { sqlite, env } = createEnv();
  const suffix = unique(label);
  const userId = `user-${suffix}`;
  const installationId = `installation-${suffix}`;
  const externalInstallationId = `external-${suffix}`;
  const projectId = `project-${suffix}`;
  const triggerId = `trigger-${suffix}`;
  const executionId = `exec-${suffix}`;
  const prompt = `Run reserved task ${suffix}`;
  const timestamp = '2026-09-07T00:00:00.000Z';

  sqlite
    .prepare(
      `INSERT INTO users (id, email, name, github_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', 'active', ?, ?)`
    )
    .run(userId, `${suffix}@example.com`, `User ${suffix}`, `gh-${suffix}`, timestamp, timestamp);
  sqlite
    .prepare(
      `INSERT INTO github_installation_accounts (
         installation_id, account_type, account_name, normalized_account_name, created_at, updated_at
       ) VALUES (?, 'personal', ?, ?, ?, ?)`
    )
    .run(externalInstallationId, `acct-${suffix}`, `acct-${suffix}`, timestamp, timestamp);
  sqlite
    .prepare(
      `INSERT INTO github_installations (
         id, user_id, installation_id, external_installation_id, account_type, account_name,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`
    )
    .run(
      installationId,
      userId,
      externalInstallationId,
      externalInstallationId,
      `acct-${suffix}`,
      timestamp,
      timestamp
    );
  sqlite
    .prepare(
      `INSERT INTO projects (
         id, user_id, name, normalized_name, installation_id, repository, default_branch,
         repo_provider, default_provider, default_location, default_vm_size, status, created_by,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'main', 'github', 'hetzner', 'nbg1', 'small', 'active', ?, ?, ?)`
    )
    .run(
      projectId,
      userId,
      `Project ${suffix}`,
      `project-${suffix}`,
      installationId,
      `acme/${suffix}`,
      userId,
      timestamp,
      timestamp
    );
  sqlite
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, status, invited_by, created_at, updated_at)
       VALUES (?, ?, 'owner', 'active', ?, ?, ?)`
    )
    .run(projectId, userId, userId, timestamp, timestamp);
  sqlite
    .prepare(
      `INSERT INTO credentials (
         id, user_id, project_id, provider, credential_type, credential_kind, is_active,
         encrypted_token, iv, created_at, updated_at
       ) VALUES (?, ?, ?, 'hetzner', 'cloud-provider', 'api-key', 1, 'encrypted-token', 'iv', ?, ?)`
    )
    .run(`credential-${suffix}`, userId, projectId, timestamp, timestamp);
  sqlite
    .prepare(
      `INSERT INTO triggers (
         id, project_id, user_id, name, status, source_type, prompt_template, task_mode,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'Reserved trigger', 'active', 'cron', ?, 'task', ?, ?)`
    )
    .run(triggerId, projectId, userId, prompt, timestamp, timestamp);
  sqlite
    .prepare(
      `INSERT INTO trigger_executions (
         id, trigger_id, project_id, status, rendered_prompt, scheduled_at, sequence_number,
         created_at
       ) VALUES (?, ?, ?, 'queued', ?, ?, 1, ?)`
    )
    .run(executionId, triggerId, projectId, prompt, timestamp, timestamp);

  const input: ReservedTaskSubmissionInput = {
    identities: reservedIdentitiesForTriggerExecution(executionId),
    projectId,
    userId,
    prompt,
    branchNameSeed: 'Reserved Trigger',
    agentProfileId: null,
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    source: {
      kind: 'trigger',
      sourceId: triggerId,
      sourceExecutionId: executionId,
      triggeredBy: 'cron',
      displayName: 'Reserved Trigger',
      repositoryAccessFlow: 'trigger-cron',
      initialStatusReason: `Triggered by cron (trigger: ${triggerId})`,
      initialStatusActorType: 'system',
      initialStatusActorId: null,
      triggerId,
      triggerExecutionId: executionId,
    },
  };

  return { sqlite, env, userId, projectId, triggerId, executionId, input };
}

function createSubmissionDependencies(overrides: ReservedTaskSubmissionDependencies = {}): {
  deps: ReservedTaskSubmissionDependencies;
  startedTaskIds: Set<string>;
  startInputs: TaskRunnerStartInput[];
} {
  const startedTaskIds = new Set<string>();
  const startInputs: TaskRunnerStartInput[] = [];
  let tick = 0;
  const deps: ReservedTaskSubmissionDependencies = {
    now: () => `2026-09-07T00:00:${String(++tick).padStart(2, '0')}.000Z`,
    generateTitle: vi.fn(async () => 'Reserved task title'),
    requireRepositoryAccess: vi.fn(async () => undefined) as NonNullable<
      ReservedTaskSubmissionDependencies['requireRepositoryAccess']
    >,
    startTaskRunner: vi.fn(async (_env: Env, input: TaskRunnerStartInput) => {
      startedTaskIds.add(input.taskId);
      startInputs.push(input);
    }) as typeof startTaskRunnerDO,
    ensureTaskRunnerStarted: vi.fn(async (_env: Env, taskId: string) => startedTaskIds.has(taskId)),
    ...overrides,
  };
  return { deps, startedTaskIds, startInputs };
}

function scalar(sqlite: Database.Database, sql: string, ...bindings: unknown[]): number {
  const row = sqlite.prepare(sql).get(...bindings) as { value: number | string | null } | undefined;
  return Number(row?.value ?? 0);
}

function taskRow(sqlite: Database.Database, taskId: string): Record<string, unknown> | null {
  return (
    (sqlite
      .prepare(
        `SELECT id, status, execution_step, chat_session_id, title, description,
                task_mode, output_branch, triggered_by, trigger_id, trigger_execution_id,
                requested_vm_size, requested_vm_size_source,
                credential_attribution_user_id, credential_attribution_project_id,
                credential_attribution_source
           FROM tasks
          WHERE id = ?`
      )
      .get(taskId) as Record<string, unknown> | undefined) ?? null
  );
}

function expectOneSubmission(fixture: ReservedFixture, input = fixture.input): void {
  expect(
    scalar(
      fixture.sqlite,
      'SELECT COUNT(*) AS value FROM tasks WHERE id = ?',
      input.identities.taskId
    )
  ).toBe(1);
  expect(
    scalar(
      fixture.sqlite,
      'SELECT COUNT(*) AS value FROM task_status_events WHERE task_id = ?',
      input.identities.taskId
    )
  ).toBe(1);
  expect(
    scalar(
      fixture.sqlite,
      'SELECT COUNT(*) AS value FROM task_status_events WHERE id = ?',
      input.identities.initialStatusEventId
    )
  ).toBe(1);
  expect(
    scalar(
      fixture.sqlite,
      'SELECT COUNT(*) AS value FROM task_submission_checkpoints WHERE task_id = ?',
      input.identities.taskId
    )
  ).toBe(1);
  expect(
    fixture.sqlite
      .prepare('SELECT task_id FROM trigger_executions WHERE id = ?')
      .get(input.source.sourceExecutionId)
  ).toEqual({ task_id: input.identities.taskId });

  const session = projectDataBoundary.sessions.get(input.identities.chatSessionId);
  expect(session).toBeDefined();
  expect(session?.messages.size).toBe(1);
  expect(session?.messages.get(input.identities.initialMessageId)).toMatchObject({
    id: input.identities.initialMessageId,
    role: 'user',
    content: input.prompt,
  });
}

function expectNoSubmission(fixture: ReservedFixture, input = fixture.input): void {
  expect(
    scalar(
      fixture.sqlite,
      'SELECT COUNT(*) AS value FROM tasks WHERE id = ?',
      input.identities.taskId
    )
  ).toBe(0);
  expect(
    scalar(
      fixture.sqlite,
      'SELECT COUNT(*) AS value FROM task_status_events WHERE task_id = ?',
      input.identities.taskId
    )
  ).toBe(0);
  expect(
    scalar(
      fixture.sqlite,
      'SELECT COUNT(*) AS value FROM task_submission_checkpoints WHERE task_id = ?',
      input.identities.taskId
    )
  ).toBe(0);
  expect(projectDataBoundary.sessions.get(input.identities.chatSessionId)).toBeUndefined();
}

describe('submitReservedTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectDataBoundary.reset();
  });

  it('converges simultaneous same-intent submissions to one task, status, chat, and prompt', async () => {
    const fixture = seedReservedFixture('same-intent');
    const { deps, startedTaskIds } = createSubmissionDependencies();

    const [first, second] = await Promise.all([
      submitReservedTask(fixture.env, fixture.input, deps),
      submitReservedTask(fixture.env, fixture.input, deps),
    ]);

    expect([first.outcome, second.outcome]).toEqual(['admitted', 'admitted']);
    expect(new Set([first.taskId, second.taskId])).toEqual(
      new Set([fixture.input.identities.taskId])
    );
    expect(startedTaskIds).toEqual(new Set([fixture.input.identities.taskId]));
    expectOneSubmission(fixture);
  });

  it('rejects a missing source reservation before creating any task effects', async () => {
    const fixture = seedReservedFixture('missing-source');
    fixture.sqlite
      .prepare('DELETE FROM trigger_executions WHERE id = ?')
      .run(fixture.input.source.sourceExecutionId);

    const result = await submitReservedTask(
      fixture.env,
      fixture.input,
      createSubmissionDependencies().deps
    );

    expect(result).toMatchObject({ outcome: 'conflict', reason: 'source_reservation_missing' });
    expectNoSubmission(fixture);
  });

  it('rejects a trigger execution reserved for another task before creating effects', async () => {
    const fixture = seedReservedFixture('source-conflict');
    fixture.sqlite
      .prepare('UPDATE trigger_executions SET task_id = ? WHERE id = ?')
      .run('other-task', fixture.input.source.sourceExecutionId);

    const result = await submitReservedTask(
      fixture.env,
      fixture.input,
      createSubmissionDependencies().deps
    );

    expect(result).toMatchObject({ outcome: 'conflict', reason: 'source_reservation_conflict' });
    expectNoSubmission(fixture);
  });

  it('rejects conflicting reuse of the reserved task identity before new effects', async () => {
    const fixture = seedReservedFixture('conflict');
    const { deps } = createSubmissionDependencies();

    await expect(submitReservedTask(fixture.env, fixture.input, deps)).resolves.toMatchObject({
      outcome: 'admitted',
    });
    const conflicting = await submitReservedTask(
      fixture.env,
      { ...fixture.input, prompt: `${fixture.input.prompt} changed` },
      createSubmissionDependencies().deps
    );

    expect(conflicting).toMatchObject({
      outcome: 'conflict',
      reason: 'intent_fingerprint_mismatch',
    });
    expectOneSubmission(fixture);
  });

  it.each([
    ['D1 commit', 'afterD1Commit'],
    ['ProjectData commit', 'afterProjectDataCommit'],
    ['TaskRunner confirmation', 'afterRunnerStartConfirmed'],
  ] as const)('recovers after interruption following the %s boundary', async (_label, hookName) => {
    const fixture = seedReservedFixture(`interrupt-${hookName}`);
    let failOnce = true;
    const base = createSubmissionDependencies();
    const deps: ReservedTaskSubmissionDependencies = {
      ...base.deps,
      [hookName]: () => {
        if (!failOnce) return;
        failOnce = false;
        throw new Error(`interrupted after ${hookName}`);
      },
    };

    await expect(submitReservedTask(fixture.env, fixture.input, deps)).rejects.toThrow(
      `interrupted after ${hookName}`
    );
    const retry = await submitReservedTask(fixture.env, fixture.input, base.deps);

    expect(retry).toMatchObject({ outcome: 'admitted', taskId: fixture.input.identities.taskId });
    expectOneSubmission(fixture);
  });

  it('recovers a lost TaskRunner acknowledgement on retry without starting a second task', async () => {
    const fixture = seedReservedFixture('lost-ack');
    const startedTaskIds = new Set<string>();
    const startInputs: TaskRunnerStartInput[] = [];
    let tick = 0;
    const deps: ReservedTaskSubmissionDependencies = {
      now: () => `2026-09-07T00:01:${String(++tick).padStart(2, '0')}.000Z`,
      generateTitle: vi.fn(async () => 'Reserved task title'),
      requireRepositoryAccess: vi.fn(async () => undefined) as NonNullable<
        ReservedTaskSubmissionDependencies['requireRepositoryAccess']
      >,
      startTaskRunner: vi.fn(async (_env: Env, startInput: TaskRunnerStartInput) => {
        startedTaskIds.add(startInput.taskId);
        startInputs.push(startInput);
        throw new Error('network response lost after start');
      }) as typeof startTaskRunnerDO,
      ensureTaskRunnerStarted: vi
        .fn()
        .mockRejectedValueOnce(new Error('TaskRunner status unavailable'))
        .mockImplementation(async (_env: Env, taskId: string) => startedTaskIds.has(taskId)),
    };

    const first = await submitReservedTask(fixture.env, fixture.input, deps);
    const retry = await submitReservedTask(fixture.env, fixture.input, deps);

    expect(first).toMatchObject({ outcome: 'pending', pendingAt: 'task_runner_start' });
    expect(retry).toMatchObject({
      outcome: 'admitted',
      startState: 'confirmed_after_lost_ack',
    });
    expect(startInputs).toHaveLength(1);
    expectOneSubmission(fixture);
  });

  it('does not fail, stop, or restart a terminal task on a late retry', async () => {
    const fixture = seedReservedFixture('terminal');
    const base = createSubmissionDependencies();

    await submitReservedTask(fixture.env, fixture.input, base.deps);
    fixture.sqlite
      .prepare(
        `UPDATE tasks
            SET status = 'completed', completed_at = ?, updated_at = ?
          WHERE id = ?`
      )
      .run('2026-09-07T00:02:00.000Z', '2026-09-07T00:02:00.000Z', fixture.input.identities.taskId);

    const retryDeps = createSubmissionDependencies();
    const retry = await submitReservedTask(fixture.env, fixture.input, retryDeps.deps);

    expect(retry).toMatchObject({ outcome: 'terminal', status: 'completed' });
    expect(retryDeps.startInputs).toHaveLength(0);
    expect(projectDataBoundary.stopSession).not.toHaveBeenCalled();
    expectOneSubmission(fixture);
  });

  it('revalidates repository authority immediately before physical start', async () => {
    const fixture = seedReservedFixture('authority');
    const { deps, startInputs } = createSubmissionDependencies({
      requireRepositoryAccess: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Repository access revoked')) as NonNullable<
        ReservedTaskSubmissionDependencies['requireRepositoryAccess']
      >,
    });

    const result = await submitReservedTask(fixture.env, fixture.input, deps);

    expect(result).toMatchObject({ outcome: 'conflict', reason: 'authority_unavailable' });
    expect(startInputs).toHaveLength(0);
    expectOneSubmission(fixture);
    expect(taskRow(fixture.sqlite, fixture.input.identities.taskId)).toMatchObject({
      status: 'queued',
    });
  });

  it('rejects unavailable skills before creating a task', async () => {
    const fixture = seedReservedFixture('skill-missing');
    const { deps } = createSubmissionDependencies();
    const result = await submitReservedTask(
      fixture.env,
      { ...fixture.input, skillId: 'missing-skill' },
      deps
    );

    expect(result).toMatchObject({ outcome: 'conflict', reason: 'profile_unavailable' });
    expect(
      scalar(
        fixture.sqlite,
        'SELECT COUNT(*) AS value FROM tasks WHERE id = ?',
        fixture.input.identities.taskId
      )
    ).toBe(0);
  });

  it('rejects stopped chat-session reuse from ProjectData without starting the runner', async () => {
    const fixture = seedReservedFixture('archive-conflict');
    const stoppedSessionId = `stopped-${fixture.input.identities.chatSessionId}`;
    projectDataBoundary.sessions.set(stoppedSessionId, {
      projectId: fixture.projectId,
      id: stoppedSessionId,
      taskId: fixture.input.identities.taskId,
      createdByUserId: fixture.userId,
      topic: 'Stopped reserved identity',
      status: 'stopped',
      messages: new Map(),
    });
    const withStoppedSession: ReservedTaskSubmissionInput = {
      ...fixture.input,
      identities: { ...fixture.input.identities, chatSessionId: stoppedSessionId },
    };
    const { deps, startInputs } = createSubmissionDependencies();

    const result = await submitReservedTask(fixture.env, withStoppedSession, deps);

    expect(result).toMatchObject({ outcome: 'conflict', reason: 'project_data_conflict' });
    expect(startInputs).toHaveLength(0);
  });

  it('persists canonical placement and credential attribution in D1 and TaskRunner input', async () => {
    const fixture = seedReservedFixture('placement');
    const { deps, startInputs } = createSubmissionDependencies();
    const input: ReservedTaskSubmissionInput = {
      ...fixture.input,
      taskMode: 'conversation',
      vmSizeOverride: 'medium',
    };

    const result = await submitReservedTask(fixture.env, input, deps);

    expect(result).toMatchObject({ outcome: 'admitted' });
    expect(taskRow(fixture.sqlite, input.identities.taskId)).toMatchObject({
      id: input.identities.taskId,
      status: 'queued',
      chat_session_id: input.identities.chatSessionId,
      task_mode: 'conversation',
      triggered_by: 'cron',
      trigger_id: fixture.triggerId,
      trigger_execution_id: fixture.executionId,
      requested_vm_size: 'medium',
      requested_vm_size_source: 'trigger',
      credential_attribution_user_id: fixture.userId,
      credential_attribution_project_id: fixture.projectId,
      credential_attribution_source: 'project',
    });
    expect(startInputs).toHaveLength(1);
    expect(startInputs[0]).toMatchObject({
      taskId: input.identities.taskId,
      projectId: fixture.projectId,
      userId: fixture.userId,
      vmSize: 'medium',
      vmLocation: 'nbg1',
      taskMode: 'conversation',
      credentialAttributionUserId: fixture.userId,
      credentialAttributionProjectId: fixture.projectId,
      credentialAttributionSource: 'project',
      cloudProvider: 'hetzner',
    });
  });
});
