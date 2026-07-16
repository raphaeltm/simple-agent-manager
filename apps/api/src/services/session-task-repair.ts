import { DEFAULT_TASK_TITLE_MAX_LENGTH } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import * as projectDataService from './project-data';
import { truncateTitle } from './task-title';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface EnsureSessionTaskBackedInput {
  projectId: string;
  sessionId: string;
  fallbackUserId: string;
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function repairedTaskStatus(sessionStatus: string | null): 'in_progress' | 'completed' | 'failed' {
  if (sessionStatus === 'failed') return 'failed';
  if (sessionStatus === 'stopped') return 'completed';
  return 'in_progress';
}

async function findTaskBySession(db: Db, sessionId: string): Promise<schema.Task | null> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.chatSessionId, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Lazily materialize a conversation Task for a legacy taskless ProjectData chat.
 * The D1 partial unique index is the concurrency guard; a losing writer reuses
 * the winner and links that identity into ProjectData.
 */
export async function ensureSessionTaskBacked(
  db: Db,
  env: Env,
  input: EnsureSessionTaskBackedInput
): Promise<schema.Task> {
  const session = await projectDataService.getSession(env, input.projectId, input.sessionId);
  if (!session) throw new Error('Chat session not found');

  const existingTaskId = stringField(session, 'taskId');
  if (existingTaskId) {
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, existingTaskId), eq(schema.tasks.projectId, input.projectId)))
      .limit(1);
    if (rows[0]) {
      if (!rows[0].chatSessionId) {
        await db
          .update(schema.tasks)
          .set({
            chatSessionId: input.sessionId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.tasks.id, existingTaskId));
      }
      return { ...rows[0], chatSessionId: input.sessionId };
    }
  }

  const existing = await findTaskBySession(db, input.sessionId);
  if (existing) {
    await projectDataService.linkSessionToTask(env, input.projectId, input.sessionId, existing.id);
    return existing;
  }

  const taskId = ulid();
  const createdAt = stringField(session, 'createdAt') ?? new Date().toISOString();
  const userId = stringField(session, 'createdByUserId') ?? input.fallbackUserId;
  const topic = stringField(session, 'topic') ?? 'Recovered conversation';
  const status = repairedTaskStatus(stringField(session, 'status'));
  const completedAt = status === 'completed' ? stringField(session, 'endedAt') : null;

  try {
    await db.insert(schema.tasks).values({
      id: taskId,
      projectId: input.projectId,
      userId,
      chatSessionId: input.sessionId,
      workspaceId: stringField(session, 'workspaceId'),
      title: truncateTitle(topic, DEFAULT_TASK_TITLE_MAX_LENGTH) || 'Recovered conversation',
      description: 'Conversation task materialized from a legacy taskless chat session.',
      status,
      executionStep: 'legacy_session_repair',
      taskMode: 'conversation',
      triggeredBy: 'legacy-session-repair',
      credentialAttributionUserId: userId,
      credentialAttributionSource: 'user',
      createdBy: userId,
      completedAt,
      createdAt,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const winner = await findTaskBySession(db, input.sessionId);
    if (!winner) throw err;
    await projectDataService.linkSessionToTask(env, input.projectId, input.sessionId, winner.id);
    log.info('session_task_repair.conflict_reused', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      taskId: winner.id,
    });
    return winner;
  }

  await projectDataService.linkSessionToTask(env, input.projectId, input.sessionId, taskId);
  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId,
    fromStatus: null,
    toStatus: status,
    actorType: 'system',
    actorId: null,
    reason: 'Legacy taskless chat repaired',
    createdAt: new Date().toISOString(),
  });
  log.info('session_task_repair.created', {
    projectId: input.projectId,
    sessionId: input.sessionId,
    taskId,
  });

  const created = await findTaskBySession(db, input.sessionId);
  if (!created) throw new Error('Repaired task could not be reloaded');
  return created;
}
