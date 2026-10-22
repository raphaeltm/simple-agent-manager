/**
 * Agent email replies: the one operation behind the `reply_to_email` tool.
 *
 * Only a task started by an email trigger may reply, and only to that email's sender, from
 * the trigger's own address. This is the first concrete rule SAM platform policy must express
 * (idea 01KS4X8CWMQFHYNJXJZ1MR7Q5M); until that engine exists it lives here, on the server.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { agentEmailAddress } from './address';
import {
  parseMessageIdList,
  replyReferences,
  replySubject,
  sanitizeDisplayName,
  sanitizeHeaderText,
} from './headers';
import type { AgentEmailSender } from './provider';
import { getAgentEmailLimits } from './settings';

export type AgentEmailReplyErrorCode =
  | 'unavailable'
  | 'invalid_body'
  | 'not_email_task'
  | 'trigger_gone'
  | 'cap_reached'
  | 'send_failed';

export class AgentEmailReplyError extends Error {
  constructor(
    readonly code: AgentEmailReplyErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AgentEmailReplyError';
  }
}

export interface AgentEmailReplyInput {
  projectId: string;
  taskId: string;
  body: string;
}

export interface AgentEmailReplyResult {
  to: string;
  subject: string;
  providerMessageId: string;
  repliesRemaining: number;
}

/** The email that started this task, scoped to the caller's project at every hop. */
async function loadReplyContext(env: Env, projectId: string, taskId: string) {
  const db = drizzle(env.DATABASE, { schema });
  const task = await db
    .select({
      triggeredBy: schema.tasks.triggeredBy,
      triggerId: schema.tasks.triggerId,
      triggerExecutionId: schema.tasks.triggerExecutionId,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.projectId, projectId)))
    .get();
  if (!task || task.triggeredBy !== 'email' || !task.triggerId || !task.triggerExecutionId) {
    throw new AgentEmailReplyError(
      'not_email_task',
      'reply_to_email only works in a task started by an email trigger'
    );
  }
  const inbound = await db
    .select()
    .from(schema.triggerEmailMessages)
    .where(
      and(
        eq(schema.triggerEmailMessages.triggerExecutionId, task.triggerExecutionId),
        eq(schema.triggerEmailMessages.triggerId, task.triggerId),
        eq(schema.triggerEmailMessages.projectId, projectId),
        eq(schema.triggerEmailMessages.direction, 'inbound'),
        eq(schema.triggerEmailMessages.status, 'accepted')
      )
    )
    .get();
  if (!inbound?.messageId) {
    throw new AgentEmailReplyError(
      'not_email_task',
      'No accepted email is recorded for this task, so there is nothing to reply to'
    );
  }
  const trigger = await db
    .select({ name: schema.triggers.name, addressKey: schema.triggerEmailConfigs.addressKey })
    .from(schema.triggers)
    .innerJoin(
      schema.triggerEmailConfigs,
      eq(schema.triggerEmailConfigs.triggerId, schema.triggers.id)
    )
    .where(and(eq(schema.triggers.id, task.triggerId), eq(schema.triggers.projectId, projectId)))
    .get();
  if (!trigger) {
    throw new AgentEmailReplyError(
      'trigger_gone',
      'The email trigger for this task was deleted, so its address can no longer send'
    );
  }
  return { db, inbound, trigger, executionId: task.triggerExecutionId };
}

/**
 * Claim one outbound slot for the run, atomically: two concurrent calls cannot both take
 * the last slot. Failed sends keep their slot, so retries cannot exceed the cap.
 */
async function claimReplySlot(
  env: Env,
  values: {
    id: string;
    triggerId: string;
    projectId: string;
    executionId: string;
    fromAddress: string;
    toAddress: string;
    subject: string;
    referencesHeader: string;
    now: string;
  },
  cap: number
): Promise<boolean> {
  const result = await env.DATABASE.prepare(
    `INSERT INTO trigger_email_messages
       (id, trigger_id, project_id, trigger_execution_id, direction, status,
        references_header, from_address, to_address, subject, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'outbound', 'sending', ?, ?, ?, ?, ?, ?
      WHERE (SELECT count(*) FROM trigger_email_messages
              WHERE trigger_execution_id = ? AND direction = 'outbound') < ?`
  )
    .bind(
      values.id,
      values.triggerId,
      values.projectId,
      values.executionId,
      values.referencesHeader,
      values.fromAddress,
      values.toAddress,
      values.subject,
      values.now,
      values.now,
      values.executionId,
      cap
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function replyToTriggerEmail(
  env: Env,
  input: AgentEmailReplyInput,
  sender: AgentEmailSender | null,
  now: Date = new Date()
): Promise<AgentEmailReplyResult> {
  if (!sender) {
    throw new AgentEmailReplyError('unavailable', 'Agent email is not enabled on this deployment');
  }
  const limits = await getAgentEmailLimits(env);
  const body = input.body.replace(/\r\n?/g, '\n').trim();
  if (!body) throw new AgentEmailReplyError('invalid_body', 'body must not be empty');
  if (body.length > limits.maxReplyChars) {
    throw new AgentEmailReplyError(
      'invalid_body',
      `body is longer than the ${limits.maxReplyChars}-character limit`
    );
  }

  const { inbound, trigger, executionId, db } = await loadReplyContext(
    env,
    input.projectId,
    input.taskId
  );
  const fromAddress = agentEmailAddress(env.BASE_DOMAIN, trigger.addressKey);
  const subject = replySubject(inbound.subject);
  const references = replyReferences(
    parseMessageIdList(inbound.referencesHeader),
    inbound.messageId ?? ''
  ).join(' ');
  const rowId = ulid();
  const claimed = await claimReplySlot(
    env,
    {
      id: rowId,
      triggerId: inbound.triggerId,
      projectId: input.projectId,
      executionId,
      fromAddress,
      toAddress: inbound.fromAddress,
      subject,
      referencesHeader: references,
      now: now.toISOString(),
    },
    limits.maxRepliesPerRun
  );
  if (!claimed) {
    throw new AgentEmailReplyError(
      'cap_reached',
      `This run already used its ${limits.maxRepliesPerRun} email replies`
    );
  }

  let providerMessageId: string;
  try {
    ({ providerMessageId } = await sender.send({
      from: { email: fromAddress, name: sanitizeDisplayName(trigger.name) || 'SAM agent' },
      to: inbound.fromAddress,
      subject,
      text: body,
      headers: {
        'In-Reply-To': inbound.messageId ?? '',
        References: references,
        'Auto-Submitted': 'auto-replied',
      },
    }));
  } catch (error) {
    const reason = sanitizeHeaderText(error instanceof Error ? error.message : String(error), 300);
    await db
      .update(schema.triggerEmailMessages)
      .set({ status: 'failed', reason, updatedAt: new Date().toISOString() })
      .where(eq(schema.triggerEmailMessages.id, rowId));
    log.error('agent_email.reply_failed', {
      projectId: input.projectId,
      taskId: input.taskId,
      triggerId: inbound.triggerId,
      reason,
    });
    throw new AgentEmailReplyError('send_failed', `The email could not be sent: ${reason}`);
  }

  // The email has left. A bookkeeping failure below must not report the send as failed,
  // or the agent would retry and the sender would get the reply twice; the claimed row
  // still counts against the cap either way.
  let used = limits.maxRepliesPerRun;
  try {
    await db
      .update(schema.triggerEmailMessages)
      .set({ status: 'sent', providerMessageId, updatedAt: new Date().toISOString() })
      .where(eq(schema.triggerEmailMessages.id, rowId));
    used = await db.$count(
      schema.triggerEmailMessages,
      and(
        eq(schema.triggerEmailMessages.triggerExecutionId, executionId),
        eq(schema.triggerEmailMessages.direction, 'outbound')
      )
    );
  } catch (error) {
    log.error('agent_email.reply_bookkeeping_failed', {
      projectId: input.projectId,
      taskId: input.taskId,
      providerMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  log.info('agent_email.reply_sent', {
    projectId: input.projectId,
    taskId: input.taskId,
    triggerId: inbound.triggerId,
    providerMessageId,
  });
  return {
    to: inbound.fromAddress,
    subject,
    providerMessageId,
    repliesRemaining: Math.max(0, limits.maxRepliesPerRun - used),
  };
}
