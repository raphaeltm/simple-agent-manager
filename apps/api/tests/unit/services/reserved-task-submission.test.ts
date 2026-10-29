import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  closeExhausted,
  recordIntake,
  scheduleRetry,
} from '../../../src/services/agent-email/inbound-delivery';
import type { InboundAgentEmail } from '../../../src/services/agent-email/inbound-message';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import type { startTaskRunnerDO } from '../../../src/services/task-runner-do';
import { admitAndSubmitTriggerExecution } from '../../../src/services/trigger-admission';
import { TriggerTaskSubmissionPendingError } from '../../../src/services/trigger-submission';
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
    getSession: vi.fn(async (_env, projectId, sessionId) => {
      const session = sessions.get(sessionId);
      if (!session || session.projectId !== projectId) return null;
      return {
        id: session.id,
        taskId: session.taskId,
        createdByUserId: session.createdByUserId,
        topic: session.topic,
        status: session.status,
        messageCount: session.messages.size,
      };
    }),
  };
});

vi.mock('../../../src/services/project-data', () => ({
  createReservedTaskSessionWithInitialMessage:
    projectDataBoundary.createReservedTaskSessionWithInitialMessage,
  stopSession: projectDataBoundary.stopSession,
  getSession: projectDataBoundary.getSession,
}));

const { reservedIdentitiesForTriggerExecution, submitReservedTask } =
  await import('../../../src/services/reserved-task-submission');
const { buildCronContext, renderTemplate } = await import('../../../src/services/trigger-template');
const { validateReservedTaskSubmissionInput } =
  await import('../../../src/services/reserved-task-submission-intent');

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

  function scheduleFixture(kind: 'schedule' | 'standing_watch' = 'schedule') {
    const fixture = seedReservedFixture(`creator-authority-${kind}`);
    fixture.input.source = { ...fixture.input.source, kind, triggeredBy: 'cron' };
    fixture.sqlite
      .prepare(
        `UPDATE project_members SET role = 'maintainer' WHERE project_id = ? AND user_id = ?`
      )
      .run(fixture.projectId, fixture.userId);
    return fixture;
  }

  it.each(['schedule', 'standing_watch'] as const)(
    'rejects %s creator demotion during title generation before creating a task',
    async (kind) => {
      const fixture = scheduleFixture(kind);
      let releaseTitle!: () => void;
      let titleStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        titleStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseTitle = resolve;
      });
      const { deps } = createSubmissionDependencies({
        generateTitle: vi.fn(async () => {
          titleStarted();
          await release;
          return 'Scheduled title';
        }),
      });
      const submission = submitReservedTask(fixture.env, fixture.input, deps);
      await started;
      fixture.sqlite
        .prepare(`UPDATE project_members SET role = 'viewer' WHERE project_id = ? AND user_id = ?`)
        .run(fixture.projectId, fixture.userId);
      releaseTitle();
      expect(await submission).toMatchObject({
        outcome: 'conflict',
        reason: 'authority_unavailable',
      });
      expect(deps.requireRepositoryAccess).toHaveBeenCalled();
      expect(deps.startTaskRunner).not.toHaveBeenCalled();
      expectNoSubmission(fixture);
    }
  );

  it.each(['suspended-user', 'removed-member', 'viewer-member'] as const)(
    'fences a %s after ProjectData admission while repository access remains available',
    async (revocation) => {
      const fixture = scheduleFixture();
      const { deps } = createSubmissionDependencies({
        afterProjectDataCommit: () => {
          if (revocation === 'suspended-user') {
            fixture.sqlite
              .prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`)
              .run(fixture.userId);
          } else {
            const assignment =
              revocation === 'removed-member' ? "status = 'removed'" : "role = 'viewer'";
            fixture.sqlite
              .prepare(
                `UPDATE project_members SET ${assignment} WHERE project_id = ? AND user_id = ?`
              )
              .run(fixture.projectId, fixture.userId);
          }
        },
      });
      expect(await submitReservedTask(fixture.env, fixture.input, deps)).toMatchObject({
        outcome: 'conflict',
        reason: 'authority_unavailable',
      });
      expect(
        projectDataBoundary.sessions.get(fixture.input.identities.chatSessionId)
      ).toBeDefined();
      expect(deps.requireRepositoryAccess).toHaveBeenCalledTimes(2);
      expect(deps.startTaskRunner).not.toHaveBeenCalled();
    }
  );

  it.each(['owner', 'admin', 'maintainer'] as const)(
    'allows an active %s to start a scheduled task',
    async (role) => {
      const fixture = scheduleFixture();
      fixture.sqlite
        .prepare(`UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?`)
        .run(role, fixture.projectId, fixture.userId);
      const { deps } = createSubmissionDependencies();
      expect(await submitReservedTask(fixture.env, fixture.input, deps)).toMatchObject({
        outcome: 'admitted',
      });
      expect(deps.startTaskRunner).toHaveBeenCalledTimes(1);
    }
  );

  it('reconciles a lost scheduled start receipt after creator revocation without restarting', async () => {
    const fixture = scheduleFixture();
    let started = false;
    const { deps } = createSubmissionDependencies({
      startTaskRunner: vi.fn(async () => {
        started = true;
        throw new Error('lost start response');
      }),
      ensureTaskRunnerStarted: vi
        .fn()
        .mockRejectedValueOnce(new Error('status unavailable'))
        .mockImplementation(async () => started),
    });
    expect(await submitReservedTask(fixture.env, fixture.input, deps)).toMatchObject({
      outcome: 'pending',
    });
    fixture.sqlite
      .prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`)
      .run(fixture.userId);
    expect(await submitReservedTask(fixture.env, fixture.input, deps)).toMatchObject({
      outcome: 'admitted',
      startState: 'confirmed_after_lost_ack',
    });
    expect(deps.startTaskRunner).toHaveBeenCalledTimes(1);
  });

  it('keeps an unconfirmed scheduled start pending after creator revocation', async () => {
    const fixture = scheduleFixture();
    const { deps } = createSubmissionDependencies({
      startTaskRunner: vi.fn(async () => {
        throw new Error('lost start response');
      }),
      ensureTaskRunnerStarted: vi.fn(async () => false),
    });
    expect(await submitReservedTask(fixture.env, fixture.input, deps)).toMatchObject({
      outcome: 'pending',
    });
    fixture.sqlite
      .prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`)
      .run(fixture.userId);
    expect(await submitReservedTask(fixture.env, fixture.input, deps)).toMatchObject({
      outcome: 'pending',
    });
    expect(deps.startTaskRunner).toHaveBeenCalledTimes(1);
    expect(taskRow(fixture.sqlite, fixture.input.identities.taskId)).toMatchObject({
      status: 'queued',
    });
    expect(projectDataBoundary.stopSession).not.toHaveBeenCalled();
  });

  it('converges simultaneous same-intent submissions to one task, status, chat, and prompt', async () => {
    const fixture = seedReservedFixture('same-intent');
    // Provision the pool before racing submissions: catalog bootstrap has its own
    // lifecycle and must not turn this test into a provider-catalog setup race.
    await ensureDefaultCapacityPoolsForExistingCredentials(
      drizzle(fixture.env.DATABASE, { schema }),
      {
        userId: fixture.userId,
        projectId: fixture.projectId,
        includeInstallation: false,
      }
    );
    const { deps, startedTaskIds } = createSubmissionDependencies();

    const [first, second] = await Promise.all([
      submitReservedTask(fixture.env, fixture.input, deps),
      submitReservedTask(fixture.env, fixture.input, deps),
    ]);

    expect([first.outcome, second.outcome], JSON.stringify([first, second])).toEqual([
      'admitted',
      'admitted',
    ]);
    expect(new Set([first.taskId, second.taskId])).toEqual(
      new Set([fixture.input.identities.taskId])
    );
    expect(startedTaskIds).toEqual(new Set([fixture.input.identities.taskId]));
    expectOneSubmission(fixture);
  });

  it('accepts real rendered multiline cron and webhook prompts above the identity limit', async () => {
    const cronPrompt = renderTemplate(
      `Scheduled trigger fired.

Project: {{project.name}}
Trigger: {{trigger.name}}
Execution: {{execution.id}}
When: {{schedule.time}} ({{schedule.timezone}})

Please inspect the current repository state, review today's activity, and write a concise implementation note with any follow-up risks you find.`,
      buildCronContext(
        {
          id: 'trigger-rendered-cron',
          name: 'Daily implementation note',
          description: 'Create a daily note from project state',
          triggerCount: 41,
          cronTimezone: 'UTC',
          projectId: 'project-rendered-cron',
        },
        new Date('2026-09-07T09:30:00.000Z'),
        'Rendered Cron Project',
        'execution-rendered-cron',
        42
      )
    ).rendered;
    const webhookPrompt = renderTemplate(
      `Take a look at the following information, received from a webhook:

---

Received At: {{webhook.receivedAt}}

Source: {{webhook.sourceLabel}}

Payload:
\`\`\`
{{webhook.payload}}
\`\`\`

Headers: {{webhook.headers}}

---

From that information, derive the repository change request and append a short note to the project README.`,
      {
        webhook: {
          receivedAt: '2026-09-07T10:15:30.000Z',
          sourceLabel: '',
          payload: { action: 'created', issue: { number: 42, title: 'Ship a longer prompt' } },
          headers: {},
        },
      }
    ).rendered;

    for (const [label, prompt] of [
      ['cron', cronPrompt],
      ['webhook', webhookPrompt],
    ] as const) {
      expect(prompt.length).toBeGreaterThan(160);
      const fixture = seedReservedFixture(`rendered-${label}`);
      const input = { ...fixture.input, prompt };
      const { deps } = createSubmissionDependencies();

      await expect(submitReservedTask(fixture.env, input, deps)).resolves.toMatchObject({
        outcome: 'admitted',
      });
      expectOneSubmission(fixture, input);
      expect(taskRow(fixture.sqlite, input.identities.taskId)).toMatchObject({
        description: prompt,
      });
    }
  });

  it('separates identity caps from the configured prompt message limit', async () => {
    const fixture = seedReservedFixture('prompt-limit');
    const multibytePrompt = 'é'.repeat(161);
    const encodedBytes = new TextEncoder().encode(multibytePrompt).length;
    fixture.env.MAX_TASK_MESSAGE_LENGTH = '161';

    expect(encodedBytes).toBeGreaterThan(multibytePrompt.length);
    await expect(
      submitReservedTask(
        fixture.env,
        { ...fixture.input, prompt: multibytePrompt },
        createSubmissionDependencies().deps
      )
    ).resolves.toMatchObject({ outcome: 'admitted' });

    const overLimitFixture = seedReservedFixture('prompt-over-limit');
    overLimitFixture.env.MAX_TASK_MESSAGE_LENGTH = '160';
    const rejected = await submitReservedTask(
      overLimitFixture.env,
      { ...overLimitFixture.input, prompt: multibytePrompt },
      createSubmissionDependencies().deps
    );
    expect(rejected).toMatchObject({
      outcome: 'conflict',
      reason: 'invalid_input',
      message: 'prompt must be 160 characters or fewer',
    });
    expectNoSubmission(overLimitFixture);
  });

  it('validates identity, display and reason fields with separate boundaries', () => {
    const fixture = seedReservedFixture('identity-validation');
    const validIdentity = 'x'.repeat(160);
    const oversizedIdentity = 'x'.repeat(161);
    const base: ReservedTaskSubmissionInput = {
      ...fixture.input,
      identities: {
        taskId: validIdentity,
        chatSessionId: 'c'.repeat(160),
        initialMessageId: 'm'.repeat(160),
        initialStatusEventId: 's'.repeat(160),
      },
      branchNameSeed: 'b'.repeat(512),
      source: {
        ...fixture.input.source,
        sourceId: validIdentity,
        sourceExecutionId: validIdentity,
        triggerId: validIdentity,
        triggerExecutionId: validIdentity,
        displayName: 'd'.repeat(512),
        repositoryAccessFlow: 'f'.repeat(512),
        initialStatusReason: 'r'.repeat(1_024),
      },
    };

    expect(validateReservedTaskSubmissionInput(base, fixture.env)).toBeNull();
    expect(
      validateReservedTaskSubmissionInput(
        {
          ...base,
          identities: { ...base.identities, taskId: oversizedIdentity },
        },
        fixture.env
      )
    ).toBe('identities.taskId must be 160 characters or fewer');
    expect(
      validateReservedTaskSubmissionInput(
        {
          ...base,
          branchNameSeed: 'b'.repeat(513),
        },
        fixture.env
      )
    ).toBe('branchNameSeed must be 512 characters or fewer');
    expect(
      validateReservedTaskSubmissionInput(
        {
          ...base,
          source: { ...base.source, displayName: 'd'.repeat(513) },
        },
        fixture.env
      )
    ).toBe('source.displayName must be 512 characters or fewer');
    expect(
      validateReservedTaskSubmissionInput(
        {
          ...base,
          source: { ...base.source, repositoryAccessFlow: 'f'.repeat(513) },
        },
        fixture.env
      )
    ).toBe('source.repositoryAccessFlow must be 512 characters or fewer');
    expect(
      validateReservedTaskSubmissionInput(
        {
          ...base,
          source: { ...base.source, initialStatusReason: 'r'.repeat(1_025) },
        },
        fixture.env
      )
    ).toBe('source.initialStatusReason must be 1024 characters or fewer');

    expect(
      validateReservedTaskSubmissionInput(
        {
          ...base,
          source: { ...base.source, repositoryAccessFlow: 'f'.repeat(13) },
        },
        { ...fixture.env, RESERVED_TASK_REPOSITORY_ACCESS_FLOW_MAX_LENGTH: '12' }
      )
    ).toBe('source.repositoryAccessFlow must be 12 characters or fewer');
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

  it('fences a managed queue reservation that expires while preparation is in flight', async () => {
    const fixture = seedReservedFixture('queue-expiry-race');
    fixture.sqlite
      .prepare("UPDATE trigger_executions SET queue_expires_at=?,status='queued' WHERE id=?")
      .run(new Date(Date.now() + 60000).toISOString(), fixture.input.source.sourceExecutionId);
    const { deps } = createSubmissionDependencies();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const generateTitle = deps.generateTitle;
    deps.generateTitle = async (...args) => {
      entered = true;
      await gate;
      if (!generateTitle) throw new Error('Missing title boundary');
      return generateTitle(...args);
    };
    const work = submitReservedTask(fixture.env, fixture.input, deps);
    await vi.waitFor(() => expect(entered).toBe(true));
    fixture.sqlite
      .prepare(
        "UPDATE trigger_executions SET status='dropped',skip_reason='queue_expired',queue_expires_at='2000-01-01' WHERE id=?"
      )
      .run(fixture.input.source.sourceExecutionId);
    release();
    await expect(work).rejects.toThrow('can no longer start a task');
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

  it('signed GitHub ingress retries overlapping leases through real task submission once', async () => {
    const [
      { Hono },
      { createHmac },
      { handleGitHubWebhook },
      recovery,
      runner,
      title,
      repository,
      producer,
    ] = await Promise.all([
      import('hono'),
      import('node:crypto'),
      import('../../../src/routes/github-webhook'),
      import('../../../src/services/github-trigger-recovery'),
      import('../../../src/services/task-runner-do'),
      import('../../../src/services/task-title'),
      import('../../../src/routes/projects/_helpers'),
      import('../../../src/services/github-project-event-producer'),
    ]);
    const fixture = seedReservedFixture('signed-github');
    fixture.env.GITHUB_WEBHOOK_SECRET = 'synthetic-signed-secret';
    fixture.sqlite.prepare('DELETE FROM trigger_executions WHERE id=?').run(fixture.executionId);
    fixture.sqlite
      .prepare('UPDATE github_installations SET external_installation_id=?')
      .run('12345');
    fixture.sqlite
      .prepare("UPDATE projects SET github_repo_id=9876, repository='acme/synthetic'")
      .run();
    fixture.sqlite
      .prepare(
        "UPDATE triggers SET source_type='github',next_execution_sequence=1,max_concurrent=1,skip_if_running=1,trigger_count=0"
      )
      .run();
    fixture.sqlite
      .prepare(
        "INSERT INTO github_trigger_configs(id,trigger_id,event_type,filters_json) VALUES('config',?,'issues','{}')"
      )
      .run(fixture.triggerId);
    fixture.sqlite.exec(
      'DROP TABLE github_trigger_inbox; ALTER TABLE trigger_executions DROP COLUMN github_delivery_id; ALTER TABLE trigger_executions DROP COLUMN admission_snapshot_json; ALTER TABLE trigger_executions DROP COLUMN submission_recorded_at;'
    );
    const { readFileSync } = await import('node:fs');
    fixture.sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0195_github_trigger_recovery.sql', import.meta.url),
        'utf8'
      )
    );
    const started = new Set<string>();
    let unblock!: () => void;
    const suspended = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let entered!: () => void;
    const boundary = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let physicalStarts = 0;
    const startSpy = vi
      .spyOn(runner, 'startTaskRunnerDO')
      .mockImplementation(async (_env, input) => {
        physicalStarts++;
        started.add(input.taskId);
        entered();
        await suspended;
      });
    const ensureSpy = vi
      .spyOn(runner, 'ensureTaskRunnerStarted')
      .mockImplementation(async (_env, id) => started.has(id));
    const titleSpy = vi
      .spyOn(title, 'generateTaskTitle')
      .mockResolvedValue('Synthetic trigger test');
    const accessSpy = vi
      .spyOn(repository, 'requireRepositoryOwnerAccess')
      .mockResolvedValue(undefined);
    const producerSpy = vi.spyOn(producer, 'admitGitHubWebhookProjectEvents').mockResolvedValue({
      processed: false,
      deliveryId: 'signed-overlap',
      eventType: 'issues',
      admittedEvents: [],
      reason: 'test_boundary',
    });
    const app = new Hono<{ Bindings: Env }>();
    app.post('/api/github/webhook', handleGitHubWebhook);
    const payload = JSON.stringify({
      action: 'opened',
      installation: { id: 12345 },
      repository: { id: 9876, full_name: 'acme/synthetic' },
      sender: { login: 'synthetic', type: 'User' },
      issue: { number: 1, title: 'Synthetic only', body: null, labels: [] },
    });
    const pending: Promise<unknown>[] = [];
    try {
      const response = await app.request(
        '/api/github/webhook',
        {
          method: 'POST',
          headers: {
            'x-github-event': 'issues',
            'x-github-delivery': 'signed-overlap',
            'x-hub-signature-256': `sha256=${createHmac('sha256', fixture.env.GITHUB_WEBHOOK_SECRET).update(payload).digest('hex')}`,
          },
          body: payload,
        },
        fixture.env,
        { waitUntil: (p) => pending.push(p), passThroughOnException: () => {} }
      );
      expect(response.status).toBe(200);
      await boundary;
      fixture.sqlite.prepare("UPDATE github_trigger_inbox SET lease_until='2000-01-01'").run();
      await recovery.runGitHubTriggerRecovery(fixture.env);
      expect(physicalStarts).toBe(1);
      unblock();
      await Promise.all(pending);
      expect(scalar(fixture.sqlite, 'SELECT COUNT(*) AS value FROM tasks')).toBe(1);
      expect(scalar(fixture.sqlite, 'SELECT COUNT(*) AS value FROM trigger_executions')).toBe(1);
      expect(
        scalar(fixture.sqlite, 'SELECT COUNT(*) AS value FROM task_submission_checkpoints')
      ).toBe(1);
      expect(
        fixture.sqlite.prepare('SELECT state,payload_json FROM github_trigger_inbox').get()
      ).toEqual({ state: 'completed', payload_json: null });
      expect(scalar(fixture.sqlite, 'SELECT trigger_count AS value FROM triggers')).toBe(1);
    } finally {
      unblock();
      await Promise.allSettled(pending);
      startSpy.mockRestore();
      ensureSpy.mockRestore();
      titleSpy.mockRestore();
      accessSpy.mockRestore();
      producerSpy.mockRestore();
      fixture.sqlite.close();
    }
  });

  it.each(['afterD1Commit', 'afterProjectDataCommit', 'afterRunnerStartConfirmed'] as const)(
    'GitHub keyed admission reuses actual task/checkpoint after %s crash',
    async (hook) => {
      const fixture = seedReservedFixture(`github-${hook}`);
      fixture.sqlite.prepare('DELETE FROM trigger_executions WHERE id=?').run(fixture.executionId);
      fixture.sqlite
        .prepare(
          'CREATE UNIQUE INDEX github_execution_identity ON trigger_executions(github_delivery_id,trigger_id) WHERE github_delivery_id IS NOT NULL'
        )
        .run();
      fixture.sqlite
        .prepare(
          'UPDATE triggers SET next_execution_sequence=1,max_concurrent=1,skip_if_running=1,trigger_count=0 WHERE id=?'
        )
        .run(fixture.triggerId);
      const [trigger] = await drizzle(fixture.env.DATABASE, { schema })
        .select()
        .from(schema.triggers)
        .where(eq(schema.triggers.id, fixture.triggerId));
      const base = createSubmissionDependencies();
      let failOnce = true;
      const deps = {
        ...base.deps,
        [hook]: () => {
          if (failOnce) {
            failOnce = false;
            throw new Error('synthetic crash');
          }
        },
      };
      const submitter: Parameters<typeof admitAndSubmitTriggerExecution>[2] = async (
        _env,
        input
      ) => {
        const result = await submitReservedTask(
          fixture.env,
          {
            ...fixture.input,
            identities: reservedIdentitiesForTriggerExecution(input.triggerExecutionId),
            prompt: input.renderedPrompt,
            source: {
              ...fixture.input.source,
              sourceExecutionId: input.triggerExecutionId,
              triggerExecutionId: input.triggerExecutionId,
            },
          },
          deps
        );
        if (result.outcome === 'admitted')
          return {
            taskId: result.taskId,
            sessionId: result.sessionId,
            branchName: result.branchName,
          };
        if (result.outcome === 'pending')
          throw new TriggerTaskSubmissionPendingError({
            taskId: result.taskId,
            sessionId: result.sessionId,
            branchName: result.branchName,
          });
        throw new Error(result.outcome);
      };
      const input = {
        trigger: trigger!,
        githubDeliveryId: 'synthetic-delivery',
        eventType: 'github.issues.opened',
        triggeredBy: 'github' as const,
        renderPrompt: () => fixture.input.prompt,
      };
      const first = await admitAndSubmitTriggerExecution(fixture.env, input, submitter);
      expect(first.outcome).toBe('failed');
      const retry = await admitAndSubmitTriggerExecution(fixture.env, input, submitter);
      expect(retry.outcome).toBe('submitted');
      expect(scalar(fixture.sqlite, 'SELECT COUNT(*) AS value FROM trigger_executions')).toBe(1);
      expect(scalar(fixture.sqlite, 'SELECT COUNT(*) AS value FROM tasks')).toBe(1);
      expect(
        scalar(fixture.sqlite, 'SELECT COUNT(*) AS value FROM task_submission_checkpoints')
      ).toBe(1);
      expect(base.startInputs).toHaveLength(1);
      expect(scalar(fixture.sqlite, 'SELECT trigger_count AS value FROM triggers')).toBe(1);
      fixture.sqlite.close();
    }
  );

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

  it('keeps an ambiguous negative start probe pending until a delayed original start is visible', async () => {
    const fixture = seedReservedFixture('delayed-original-start');
    const startedTaskIds = new Set<string>();
    let commitDelayedOriginalStart: (() => void) | null = null;
    let tick = 0;
    const deps: ReservedTaskSubmissionDependencies = {
      now: () => `2026-09-07T00:03:${String(++tick).padStart(2, '0')}.000Z`,
      generateTitle: vi.fn(async () => 'Reserved task title'),
      requireRepositoryAccess: vi.fn(async () => undefined) as NonNullable<
        ReservedTaskSubmissionDependencies['requireRepositoryAccess']
      >,
      startTaskRunner: vi.fn(async (_env: Env, startInput: TaskRunnerStartInput) => {
        commitDelayedOriginalStart = () => startedTaskIds.add(startInput.taskId);
        throw new Error('lost acknowledgement before durable state was observable');
      }) as typeof startTaskRunnerDO,
      ensureTaskRunnerStarted: vi.fn(async (_env: Env, taskId: string) =>
        startedTaskIds.has(taskId)
      ),
    };

    const first = await submitReservedTask(fixture.env, fixture.input, deps);
    expect(first).toMatchObject({ outcome: 'pending', pendingAt: 'task_runner_start' });
    expect(taskRow(fixture.sqlite, fixture.input.identities.taskId)).toMatchObject({
      status: 'queued',
    });
    expect(projectDataBoundary.stopSession).not.toHaveBeenCalled();

    commitDelayedOriginalStart?.();
    const retry = await submitReservedTask(fixture.env, fixture.input, deps);

    expect(retry).toMatchObject({
      outcome: 'admitted',
      startState: 'confirmed_after_lost_ack',
    });
    expect(deps.startTaskRunner).toHaveBeenCalledTimes(1);
    expectOneSubmission(fixture);
  });

  it.each(['delegated', 'in_progress'] as const)(
    'returns admitted when a lost start acknowledgement races with a %s D1 winner',
    async (winnerStatus) => {
      const fixture = seedReservedFixture(`${winnerStatus}-winner`);
      let tick = 0;
      const deps: ReservedTaskSubmissionDependencies = {
        now: () => `2026-09-07T00:04:${String(++tick).padStart(2, '0')}.000Z`,
        generateTitle: vi.fn(async () => 'Reserved task title'),
        requireRepositoryAccess: vi.fn(async () => undefined) as NonNullable<
          ReservedTaskSubmissionDependencies['requireRepositoryAccess']
        >,
        startTaskRunner: vi.fn(async () => {
          throw new Error('lost acknowledgement');
        }) as typeof startTaskRunnerDO,
        ensureTaskRunnerStarted: vi.fn(async () => {
          fixture.sqlite
            .prepare(`UPDATE tasks SET status = ? WHERE id = ?`)
            .run(winnerStatus, fixture.input.identities.taskId);
          return false;
        }),
      };

      const result = await submitReservedTask(fixture.env, fixture.input, deps);

      expect(result).toMatchObject({ outcome: 'admitted', startState: 'already_started' });
      expect(projectDataBoundary.stopSession).not.toHaveBeenCalled();
      expect(
        fixture.sqlite
          .prepare('SELECT terminal_observed_at FROM task_submission_checkpoints WHERE task_id = ?')
          .get(fixture.input.identities.taskId)
      ).toEqual({ terminal_observed_at: null });
    }
  );

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

describe('agent email executions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectDataBoundary.reset();
  });

  const RECEIVED = new Date('2026-09-07T00:00:00.000Z');
  const LEASE_MS = 120_000;
  const ADDRESS = 'agent+k3j2h7m9q2xw4n8p@agents.example.com';

  function inboundEmail(messageId: string): InboundAgentEmail {
    return {
      envelopeFrom: 'alice@example.com',
      envelopeTo: ADDRESS,
      from: 'alice@example.com',
      fromName: 'Alice',
      subject: 'Please look at this',
      messageId,
      inReplyTo: null,
      references: [],
      text: 'Hello',
      textTruncated: false,
      attachments: [],
      autoSubmitted: null,
      precedence: null,
      hasListId: false,
    };
  }

  /**
   * An email stored the way the email() handler stores it, for the fixture's trigger, with its
   * execution reserved under the email's own execution id, as admission reserves it.
   */
  async function storedEmail(fixture: ReservedFixture, messageId: string, sequence: number) {
    const db = drizzle(fixture.env.DATABASE, { schema });
    fixture.sqlite
      .prepare(`UPDATE triggers SET source_type = 'email', max_concurrent = 1 WHERE id = ?`)
      .run(fixture.triggerId);
    const intake = await recordIntake(
      db,
      {
        triggerId: fixture.triggerId,
        projectId: fixture.projectId,
        messageId,
        referencesHeader: null,
        fromAddress: 'alice@example.com',
        toAddress: ADDRESS,
        subject: 'Please look at this',
        rawSize: 512,
      },
      { email: inboundEmail(messageId), receivedAt: RECEIVED.toISOString() },
      RECEIVED,
      LEASE_MS
    );
    if (intake.kind !== 'new') throw new Error('expected a newly stored email');
    const { executionId } = intake.delivery;
    fixture.sqlite
      .prepare(
        `INSERT INTO trigger_executions (
           id, trigger_id, project_id, status, rendered_prompt, scheduled_at, sequence_number,
           created_at
         ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`
      )
      .run(
        executionId,
        fixture.triggerId,
        fixture.projectId,
        fixture.input.prompt,
        RECEIVED.toISOString(),
        sequence,
        RECEIVED.toISOString()
      );
    const input: ReservedTaskSubmissionInput = {
      ...fixture.input,
      identities: reservedIdentitiesForTriggerExecution(executionId),
      source: {
        ...fixture.input.source,
        triggeredBy: 'email',
        repositoryAccessFlow: 'trigger-email',
        sourceExecutionId: executionId,
        triggerExecutionId: executionId,
      },
    };
    return { db, delivery: intake.delivery, input };
  }

  /** Submission dependencies whose title generation waits until released. */
  function pausedAtTitle() {
    let titleStarted!: () => void;
    let releaseTitle!: () => void;
    const started = new Promise<void>((resolve) => {
      titleStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTitle = resolve;
    });
    const submission = createSubmissionDependencies({
      generateTitle: vi.fn(async () => {
        titleStarted();
        await release;
        return 'Slow title';
      }),
    });
    return { ...submission, started, release: () => releaseTitle() };
  }

  it('refuses a late task for an email SAM gave up on mid-submission, after another email took its slot', async () => {
    const fixture = seedReservedFixture('email-late-task');
    const first = await storedEmail(fixture, '<first@example.com>', 2);
    const slow = pausedAtTitle();
    // The attempt passed every check and is on its way to creating the task.
    const late = submitReservedTask(fixture.env, first.input, slow.deps);
    await slow.started;

    // Its lease ran out and every attempt is used, so the sweep gives the email up. That
    // releases the run slot the email held.
    expect(
      await closeExhausted(first.db, new Date(RECEIVED.getTime() + LEASE_MS + 1), 1, 10)
    ).toEqual({ gaveUp: 1, accepted: 0 });
    expect(
      fixture.sqlite
        .prepare('SELECT status, task_id FROM trigger_executions WHERE id = ?')
        .get(first.delivery.executionId)
    ).toEqual({ status: 'failed', task_id: null });

    // The trigger's next email takes the slot and starts its task.
    const second = await storedEmail(fixture, '<second@example.com>', 3);
    const fast = createSubmissionDependencies();
    expect(await submitReservedTask(fixture.env, second.input, fast.deps)).toMatchObject({
      outcome: 'admitted',
    });

    slow.release();
    await expect(late).rejects.toThrow(/can no longer start a task/);

    expectNoSubmission(fixture, first.input);
    expectOneSubmission(fixture, second.input);
    expect(slow.deps.startTaskRunner).not.toHaveBeenCalled();
    expect(
      scalar(
        fixture.sqlite,
        'SELECT COUNT(*) AS value FROM tasks WHERE trigger_id = ?',
        fixture.triggerId
      )
    ).toBe(1);
  });

  it('still creates the task of an email that is only waiting for a retry', async () => {
    const fixture = seedReservedFixture('email-retry-wait');
    const first = await storedEmail(fixture, '<first@example.com>', 2);
    const slow = pausedAtTitle();
    const late = submitReservedTask(fixture.env, first.input, slow.deps);
    await slow.started;

    // An attempt failed and scheduled a retry: the email is still SAM's to deliver.
    expect(
      await scheduleRetry(first.db, first.delivery, RECEIVED, 60_000, 'TaskRunner unavailable')
    ).toBe(true);

    slow.release();
    expect(await late).toMatchObject({ outcome: 'admitted' });
    expectOneSubmission(fixture, first.input);
  });
});
