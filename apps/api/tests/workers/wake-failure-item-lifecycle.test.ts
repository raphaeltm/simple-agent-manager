/**
 * A failed chat wake is one D1 `asks` error item (inbox slice E). A person writing in the chat
 * closes it, through the REAL ProjectData Durable Object (`persistMessage` ->
 * `persistMessageWithSideEffects` -> `closeQuestionAsks` -> `closeChatErrorAsksForHumanMessage`)
 * against the migrated D1 schema (`.claude/rules/62`, `.claude/rules/28`).
 *
 * Real: the Durable Object and its SQLite, `raiseSessionWakeFailure` run on the object's own SQL,
 * the worker's `inboxErrorsPort` (installed by `setup-d1-migrations.ts`), the notification Durable
 * Object, and the shipped D1 migrations. Nothing is mocked.
 *
 * Runs inside the workerd runtime via @cloudflare/vitest-pool-workers.
 */
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { raiseSessionWakeFailure } from '@simple-agent-manager/project-data/internal/do/wake-failure';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';

interface Seeded {
  projectId: string;
  userId: string;
  stub: DurableObjectStub<ProjectData>;
}

async function seedProject(label: string): Promise<Seeded> {
  const suffix = crypto.randomUUID();
  const projectId = `wake-${label}-${suffix}`;
  const userId = `user-${label}-${suffix}`;
  const installationId = `inst-${label}-${suffix}`;
  const db = env.DATABASE;
  await db
    .prepare(`INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(userId, `${userId}@example.com`, 'Wake owner', Date.now(), Date.now())
    .run();
  await db
    .prepare(
      `INSERT INTO github_installations
         (id, user_id, installation_id, account_type, account_name, created_at, updated_at)
       VALUES (?, ?, ?, 'User', 'wake-lifecycle', datetime('now'), datetime('now'))`
    )
    .bind(installationId, userId, installationId)
    .run();
  await db
    .prepare(
      `INSERT INTO projects
         (id, user_id, created_by, name, normalized_name, installation_id, repository,
          created_at, updated_at)
       VALUES (?, ?, ?, 'Wake project', ?, ?, 'owner/repo', datetime('now'), datetime('now'))`
    )
    .bind(projectId, userId, userId, `wake-${label}-${suffix}`, installationId)
    .run();
  await db
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')`
    )
    .bind(projectId, userId)
    .run();
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
  await stub.ensureProjectId(projectId);
  return { projectId, userId, stub };
}

/** A chat in the project's object with the task bound to it, as the task runner leaves it. */
async function seedChat(project: Seeded, topic: string): Promise<string> {
  const sessionId = await project.stub.createSession(null, topic, null, project.userId);
  await env.DATABASE.prepare(
    `INSERT INTO tasks
       (id, project_id, user_id, chat_session_id, title, status, execution_step, created_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'in_progress', 'running', ?, ?, ?)`
  )
    .bind(
      `task-${sessionId}`,
      project.projectId,
      project.userId,
      sessionId,
      topic,
      project.userId,
      new Date().toISOString(),
      new Date().toISOString()
    )
    .run();
  return sessionId;
}

/** A failed wake of the chat, entered at `raiseSessionWakeFailure` on the object's own SQL. */
async function failWake(project: Seeded, sessionId: string) {
  return runInDurableObject(project.stub, (instance) =>
    raiseSessionWakeFailure(
      (instance as unknown as { sql: SqlStorage }).sql,
      env as unknown as Env,
      project.projectId,
      {
        sessionId,
        deliveryId: crypto.randomUUID(),
        reason: 'wake_refused',
        detail: 'Snapshot expired',
      },
      () => {}
    )
  );
}

async function wakeItem(projectId: string, sessionId: string) {
  return env.DATABASE.prepare(
    `SELECT id, status, answer_json, dedupe_key, failure_count FROM asks
      WHERE project_id = ? AND source_session_id = ? AND kind = 'error'
      ORDER BY created_at DESC, id DESC`
  )
    .bind(projectId, sessionId)
    .all<{
      id: string;
      status: string;
      answer_json: string | null;
      dedupe_key: string | null;
      failure_count: number;
    }>();
}

describe('a person writing in the chat closes its failed-wake item', () => {
  it('closes it as recovered and releases the key when a user message is persisted', async () => {
    const project = await seedProject('human');
    const chat = await seedChat(project, 'Fix the login bug');
    const other = await seedChat(project, 'Another chat');
    await failWake(project, chat);
    await failWake(project, other);
    const before = await wakeItem(project.projectId, chat);
    expect(before.results).toEqual([
      expect.objectContaining({
        status: 'open',
        dedupe_key: `error:wake:${chat}`,
        failure_count: 1,
      }),
    ]);

    await project.stub.persistMessage(chat, 'user', 'Are you there? Please continue.', null);

    const closed = (await wakeItem(project.projectId, chat)).results;
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      id: before.results[0]!.id,
      status: 'done',
      dedupe_key: null,
    });
    expect(JSON.parse(String(closed[0]!.answer_json))).toEqual({ resolution: 'recovered' });
    // Control: a message in a different chat does not close this chat's item, and this chat's
    // message did not close the other chat's.
    expect((await wakeItem(project.projectId, other)).results).toEqual([
      expect.objectContaining({ status: 'open', dedupe_key: `error:wake:${other}` }),
    ]);
  });

  it('files a new item, not a revived one, when the chat fails to wake again after the person wrote', async () => {
    const project = await seedProject('refail');
    const chat = await seedChat(project, 'Fix the login bug');
    await failWake(project, chat);
    await project.stub.persistMessage(chat, 'user', 'Hello?', null);

    await failWake(project, chat);

    const items = (await wakeItem(project.projectId, chat)).results;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.status).sort()).toEqual(['done', 'open']);
    expect(items.find((i) => i.status === 'open')).toMatchObject({
      failure_count: 1,
      dedupe_key: `error:wake:${chat}`,
    });
  });

  it('leaves the item open for an assistant message (control: the message is persisted)', async () => {
    const project = await seedProject('assistant');
    const chat = await seedChat(project, 'Fix the login bug');
    await failWake(project, chat);

    const messageId = await project.stub.persistMessage(
      chat,
      'assistant',
      'Still working...',
      null
    );

    expect(messageId).toEqual(expect.any(String));
    expect((await wakeItem(project.projectId, chat)).results).toEqual([
      expect.objectContaining({ status: 'open', dedupe_key: `error:wake:${chat}` }),
    ]);
  });

  it('does not close another project’s failed-wake item', async () => {
    const mine = await seedProject('scope-a');
    const theirs = await seedProject('scope-b');
    const myChat = await seedChat(mine, 'Fix the login bug');
    const theirChat = await seedChat(theirs, 'Their chat');
    await failWake(mine, myChat);
    await failWake(theirs, theirChat);

    await mine.stub.persistMessage(myChat, 'user', 'Continue please', null);

    // Owner control: the project whose person wrote has its item closed.
    expect((await wakeItem(mine.projectId, myChat)).results[0]).toMatchObject({ status: 'done' });
    // Attack: the other project's item survives (the close is scoped by project and chat).
    expect((await wakeItem(theirs.projectId, theirChat)).results).toEqual([
      expect.objectContaining({ status: 'open', dedupe_key: `error:wake:${theirChat}` }),
    ]);
  });
});
