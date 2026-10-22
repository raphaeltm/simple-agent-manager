/**
 * Agent email vertical slice: an inbound email enters through the real `email()` handler
 * logic, crosses the real trigger admission path into task submission, and the agent's
 * reply leaves through the real reply operation and MCP adapter to a send binding that
 * enforces Cloudflare's documented contract. Real SQLite throughout.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { log } from '../../src/lib/logger';
import { handleReplyToEmail } from '../../src/routes/mcp/agent-email-tools';
import { updateAdminSettings } from '../../src/services/admin-settings';
import {
  handleInboundAgentEmail,
  type InboundEmailMessage,
} from '../../src/services/agent-email/inbound';
import { readLoopbackStatus } from '../../src/services/agent-email/loopback';
import { agentEmailSenderFor } from '../../src/services/agent-email/provider';
import { AgentEmailReplyError, replyToTriggerEmail } from '../../src/services/agent-email/reply';
import type { McpTokenData } from '../../src/services/mcp-token';
import type { TriggerTaskSubmitter } from '../../src/services/trigger-admission';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

const BASE_DOMAIN = 'fixture.example';
const ADDRESS_ID = 'k3j2h7m9q2xw4n8p';
const ADDRESS = `agent+${ADDRESS_ID}@mail.${BASE_DOMAIN}`;
const TRIGGER_ID = 'trigger-email-1';
const PROJECT_ID = 'project-1';
const OTHER_PROJECT_ID = 'project-2';

/** Cloudflare Email Sending headers this feature relies on (allowlisted per the docs). */
const ALLOWED_HEADERS = new Set(['in-reply-to', 'references', 'auto-submitted']);

/** A send binding that enforces the parts of the Email Sending contract we depend on. */
function contractSendBinding() {
  const sent: EmailMessageBuilder[] = [];
  let failNext = false;
  const binding = {
    async send(message: EmailMessageBuilder): Promise<EmailSendResult> {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('E_RATE_LIMIT_EXCEEDED: sending rate limit reached'), {
          code: 'E_RATE_LIMIT_EXCEEDED',
        });
      }
      if (!message.from || !message.subject || !message.to) throw new Error('E_FIELD_MISSING');
      const recipients = [message.to, message.cc ?? [], message.bcc ?? []].flat();
      if (recipients.length > 50) throw new Error('E_TOO_MANY_RECIPIENTS');
      for (const [name, value] of Object.entries(message.headers ?? {})) {
        if (!ALLOWED_HEADERS.has(name.toLowerCase())) throw new Error('E_HEADER_NOT_ALLOWED');
        if (value.length > 2048) throw new Error('E_HEADER_VALUE_TOO_LONG');
        if (/[\r\n]/.test(value)) throw new Error('E_VALIDATION_ERROR');
      }
      if (/[\r\n]/.test(message.subject)) throw new Error('E_VALIDATION_ERROR');
      sent.push(message);
      return { messageId: `<cf-${sent.length}@mail.${BASE_DOMAIN}>` };
    },
  } as unknown as SendEmail;
  return {
    binding,
    sent,
    failOnce() {
      failNext = true;
    },
  };
}

function rawEmail(
  options: {
    from?: string;
    subject?: string;
    messageId?: string | null;
    references?: string;
    headers?: string[];
    body?: string;
  } = {}
): string {
  const lines = [
    `From: ${options.from ?? 'Alice Example <Alice@Example.com>'}`,
    `To: ${ADDRESS}`,
    `Subject: ${options.subject ?? 'Please fix the login bug'}`,
    ...(options.messageId === null
      ? []
      : [`Message-ID: ${options.messageId ?? '<m1@example.com>'}`]),
    ...(options.references ? [`References: ${options.references}`] : []),
    ...(options.headers ?? []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.body ?? 'The login page returns a 500 since this morning. Can you look?',
  ];
  return lines.join('\r\n');
}

function inbound(
  raw: string,
  envelope: { from?: string; to?: string; rawSize?: number } = {}
): InboundEmailMessage & { setReject: ReturnType<typeof vi.fn> } {
  return {
    from: envelope.from ?? 'alice@example.com',
    to: envelope.to ?? ADDRESS,
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    rawSize: envelope.rawSize ?? raw.length,
    setReject: vi.fn(),
  };
}

/** Wrap a D1 adapter so the next "mark this email accepted" write fails once. */
function failNextAcceptedWrite(base: D1Database): { db: D1Database; arm(): void } {
  let armed = false;
  type Statement = { bind: (...params: unknown[]) => Record<string, unknown> };
  const prepare = (sql: string) => {
    const statement = (base as unknown as { prepare(sql: string): Statement }).prepare(sql);
    return {
      ...statement,
      bind: (...params: unknown[]) => {
        const bound = statement.bind(...params);
        // Drizzle orders SET parameters by column, so look for the value, not its position.
        if (
          armed &&
          sql.startsWith('update "trigger_email_messages"') &&
          params.includes('accepted')
        ) {
          armed = false;
          const fail = async () => {
            throw new Error('D1_ERROR: simulated write failure');
          };
          return { ...bound, run: fail, all: fail, raw: fail, first: fail };
        }
        return bound;
      },
    };
  };
  return {
    db: { ...(base as unknown as Record<string, unknown>), prepare } as unknown as D1Database,
    arm: () => {
      armed = true;
    },
  };
}

describe('agent email vertical slice', () => {
  let sqlite: Database.Database;
  let env: Env;
  let mail: ReturnType<typeof contractSendBinding>;
  let submitter: ReturnType<typeof vi.fn<TriggerTaskSubmitter>>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const emailTables = new Set(['triggerEmailConfigs', 'triggerEmailMessages']);
    createAllSchemaTables(
      sqlite,
      Object.fromEntries(Object.entries(schema).filter(([name]) => !emailTables.has(name)))
    );
    // The real email tables, unique dedupe index included, from the shipped migration.
    const migration = readFileSync(
      new URL('../../src/db/migrations/0204_agent_email_triggers.sql', import.meta.url),
      'utf8'
    );
    sqlite.exec(migration.split('-- Widen task_submission_checkpoints')[0]!);
    sqlite.exec(
      readFileSync(
        new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, 'user', 'active')`
      )
      .run('user-1', 'owner@example.com', 'Owner');
    for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
      sqlite
        .prepare(`INSERT INTO projects (id, user_id, name) VALUES (?, 'user-1', ?)`)
        .run(projectId, `Project ${projectId}`);
    }
    sqlite
      .prepare(
        `INSERT INTO triggers
          (id, project_id, user_id, name, description, status, source_type, skip_if_running,
           prompt_template, agent_profile_id, task_mode, max_concurrent, trigger_count,
           next_execution_sequence, created_at, updated_at)
         VALUES (?, ?, 'user-1', 'Support inbox', NULL, 'active', 'email', 0,
                 ?, 'profile-1', 'task', 5, 0, 1, ?, ?)`
      )
      .run(
        TRIGGER_ID,
        PROJECT_ID,
        'Email from {{email.fromName}} <{{email.from}}> to {{email.to}}\nSubject: {{email.subject}}\n\n{{email.text}}',
        now,
        now
      );
    sqlite
      .prepare(
        `INSERT INTO trigger_email_configs (trigger_id, address_key, allowed_senders_json)
         VALUES (?, ?, ?)`
      )
      .run(
        TRIGGER_ID,
        ADDRESS_ID,
        JSON.stringify(['alice@example.com', `agent+loopback@mail.${BASE_DOMAIN}`])
      );

    mail = contractSendBinding();
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN,
      AGENT_EMAIL: mail.binding,
      ENCRYPTION_KEY: 'agent-email-test-encryption-key-0123456789',
    } as Env;
    // Records the task exactly as the real reserved submission does: id = execution id,
    // provenance from the admission input.
    submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => {
      sqlite
        .prepare(
          `INSERT INTO tasks (id, project_id, user_id, title, status, triggered_by, trigger_id,
             trigger_execution_id, created_at, updated_at)
           VALUES (?, ?, ?, 'Email task', 'queued', ?, ?, ?, ?, ?)`
        )
        .run(
          input.triggerExecutionId,
          input.projectId,
          input.userId,
          input.triggeredBy,
          input.triggerId,
          input.triggerExecutionId,
          now,
          now
        );
      return {
        taskId: input.triggerExecutionId,
        sessionId: `chat_${input.triggerExecutionId}`,
        branchName: 'sam/email-task',
      };
    });
  });

  afterEach(() => sqlite.close());

  const token = (taskId: string, projectId = PROJECT_ID): McpTokenData => ({
    taskId,
    projectId,
    userId: 'user-1',
    workspaceId: 'workspace-1',
    createdAt: new Date().toISOString(),
  });

  it('starts one task from an allowed sender and replies to that sender, threaded', async () => {
    const message = inbound(rawEmail({ references: '<root@example.com> <m0@example.com>' }), {
      from: 'alice@example.com',
    });

    const outcome = await handleInboundAgentEmail(message, env, { submitter });

    expect(outcome).toMatchObject({ kind: 'accepted' });
    expect(message.setReject).not.toHaveBeenCalled();
    expect(submitter).toHaveBeenCalledTimes(1);
    const submission = submitter.mock.calls[0]![1];
    expect(submission.triggeredBy).toBe('email');
    expect(submission.renderedPrompt).toContain('Email from Alice Example <alice@example.com>');
    expect(submission.renderedPrompt).toContain(`to ${ADDRESS}`);
    expect(submission.renderedPrompt).toContain('Subject: Please fix the login bug');
    expect(submission.renderedPrompt).toContain('The login page returns a 500');
    const executionId = submission.triggerExecutionId;
    expect(
      sqlite
        .prepare(
          `SELECT status, trigger_execution_id AS executionId, message_id AS messageId
             FROM trigger_email_messages WHERE direction = 'inbound'`
        )
        .all()
    ).toEqual([{ status: 'accepted', executionId, messageId: '<m1@example.com>' }]);

    const reply = await handleReplyToEmail(
      1,
      { body: 'Fixed: the session cookie domain was wrong. Deployed.' },
      token(executionId),
      env
    );

    expect(reply).toMatchObject({ result: { content: [{ type: 'text' }] } });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toEqual({
      from: { email: ADDRESS, name: 'Support inbox' },
      to: 'alice@example.com',
      subject: 'Re: Please fix the login bug',
      text: 'Fixed: the session cookie domain was wrong. Deployed.',
      headers: {
        'In-Reply-To': '<m1@example.com>',
        References: '<root@example.com> <m0@example.com> <m1@example.com>',
        'Auto-Submitted': 'auto-replied',
      },
    });
    expect(
      sqlite
        .prepare(
          `SELECT status, to_address AS toAddress, provider_message_id AS providerMessageId
             FROM trigger_email_messages WHERE direction = 'outbound'`
        )
        .all()
    ).toEqual([
      {
        status: 'sent',
        toAddress: 'alice@example.com',
        providerMessageId: `<cf-1@mail.${BASE_DOMAIN}>`,
      },
    ]);
  });

  describe('inbound refusals (each paired with the accepted path above)', () => {
    const cases: Array<{
      name: string;
      message: () => ReturnType<typeof inbound>;
      reason: RegExp;
    }> = [
      {
        name: 'a sender that is not allowed',
        message: () => inbound(rawEmail({ from: 'Mallory <mallory@example.net>' })),
        reason: /Sender not allowed/,
      },
      {
        name: 'an unknown address key',
        message: () => inbound(rawEmail(), { to: `agent+zzzzzzzzzzzzzzzz@mail.${BASE_DOMAIN}` }),
        reason: /Unknown address/,
      },
      {
        name: 'another domain',
        message: () => inbound(rawEmail(), { to: `agent+${ADDRESS_ID}@mail.elsewhere.example` }),
        reason: /Unknown address/,
      },
      {
        name: 'an automatic reply',
        message: () => inbound(rawEmail({ headers: ['Auto-Submitted: auto-replied'] })),
        reason: /Automatic replies/,
      },
      {
        name: 'bulk mail',
        message: () => inbound(rawEmail({ headers: ['Precedence: bulk'] })),
        reason: /Bulk mail/,
      },
      {
        name: 'mailing-list mail',
        message: () => inbound(rawEmail({ headers: ['List-Id: <team.lists.example.com>'] })),
        reason: /Mailing-list/,
      },
      {
        name: 'a bounce',
        message: () => inbound(rawEmail(), { from: 'MAILER-DAEMON@mx.example.com' }),
        reason: /Bounces/,
      },
      {
        name: 'an oversized message',
        message: () => inbound(rawEmail(), { rawSize: 50 * 1024 * 1024 }),
        reason: /too large/,
      },
      {
        name: 'a message without a Message-ID',
        message: () => inbound(rawEmail({ messageId: null })),
        reason: /Message-ID/,
      },
    ];

    it.each(cases)('rejects $name at SMTP time and starts nothing', async ({ message, reason }) => {
      const delivery = message();

      const outcome = await handleInboundAgentEmail(delivery, env, { submitter });

      expect(outcome).toMatchObject({ kind: 'rejected' });
      expect(delivery.setReject).toHaveBeenCalledWith(expect.stringMatching(reason));
      expect(submitter).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT count(*) AS n FROM trigger_executions').get()).toEqual({
        n: 0,
      });
    });

    it('rejects mail for a paused trigger and records why', async () => {
      sqlite.prepare(`UPDATE triggers SET status = 'paused' WHERE id = ?`).run(TRIGGER_ID);
      const delivery = inbound(rawEmail());

      const outcome = await handleInboundAgentEmail(delivery, env, { submitter });

      expect(outcome).toMatchObject({ kind: 'rejected' });
      expect(delivery.setReject).toHaveBeenCalledWith('This agent address is paused');
      expect(submitter).not.toHaveBeenCalled();
      expect(sqlite.prepare(`SELECT status, reason FROM trigger_email_messages`).all()).toEqual([
        { status: 'rejected', reason: 'paused' },
      ]);
    });

    it('rejects everything when this deployment has no agent email binding', async () => {
      const delivery = inbound(rawEmail());

      const outcome = await handleInboundAgentEmail(
        delivery,
        { ...env, AGENT_EMAIL: undefined },
        { submitter }
      );

      expect(outcome).toMatchObject({ kind: 'rejected' });
      expect(delivery.setReject).toHaveBeenCalledWith(expect.stringMatching(/not enabled/));
      expect(submitter).not.toHaveBeenCalled();
    });

    it('rejects a burst above the per-trigger hourly limit', async () => {
      await updateAdminSettings(env, {
        changes: [{ name: 'agentEmail.inboundPerTriggerPerHour', value: 2 }],
        actorUserId: 'admin-1',
      });
      const outcomes = [];
      for (const id of ['<b1@example.com>', '<b2@example.com>', '<b3@example.com>']) {
        outcomes.push(
          await handleInboundAgentEmail(inbound(rawEmail({ messageId: id })), env, { submitter })
        );
      }

      expect(outcomes.map((outcome) => outcome.kind)).toEqual(['accepted', 'accepted', 'rejected']);
      expect(submitter).toHaveBeenCalledTimes(2);
    });
  });

  it('acknowledges a redelivered Message-ID without starting a second task', async () => {
    const first = await handleInboundAgentEmail(inbound(rawEmail()), env, { submitter });
    const redelivery = inbound(rawEmail());

    const second = await handleInboundAgentEmail(redelivery, env, { submitter });

    expect(first).toMatchObject({ kind: 'accepted' });
    expect(second).toEqual({ kind: 'duplicate' });
    expect(redelivery.setReject).not.toHaveBeenCalled();
    expect(submitter).toHaveBeenCalledTimes(1);
  });

  it('lets a retried delivery run again after a failed submission', async () => {
    submitter.mockRejectedValueOnce(new Error('TaskRunner unavailable'));

    await expect(handleInboundAgentEmail(inbound(rawEmail()), env, { submitter })).rejects.toThrow(
      /TaskRunner unavailable/
    );
    expect(sqlite.prepare(`SELECT status FROM trigger_email_messages`).all()).toEqual([
      { status: 'failed' },
    ]);

    const retry = await handleInboundAgentEmail(inbound(rawEmail()), env, { submitter });

    expect(retry).toMatchObject({ kind: 'accepted' });
    expect(submitter).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare(`SELECT status FROM trigger_email_messages`).all()).toEqual([
      { status: 'accepted' },
    ]);
  });

  it('rejects unreadable mail cleanly instead of crashing, for triggers and the loopback', async () => {
    const parts = Array.from(
      { length: 600 },
      (_, index) => `--b\r\nContent-Type: text/plain\r\n\r\npart ${index}`
    );
    const raw = [
      'From: Alice <alice@example.com>',
      `To: ${ADDRESS}`,
      'Subject: Too many parts',
      'Message-ID: <parts@example.com>',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      ...parts,
      '--b--',
    ].join('\r\n');

    for (const to of [ADDRESS, `agent+loopback@mail.${BASE_DOMAIN}`]) {
      const delivery = inbound(raw, { to });
      const outcome = await handleInboundAgentEmail(delivery, env, { submitter });

      expect(outcome).toEqual({ kind: 'rejected', reason: 'This email could not be read' });
      expect(delivery.setReject).toHaveBeenCalledWith('This email could not be read');
    }
    expect(submitter).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT count(*) AS n FROM trigger_email_messages').get()).toEqual({
      n: 0,
    });
    // Liveness: a well-formed email still goes through afterwards.
    expect(await handleInboundAgentEmail(inbound(rawEmail()), env, { submitter })).toMatchObject({
      kind: 'accepted',
    });
  });

  it("only lets this deployment's agent addresses write the loopback status, and bounds it", async () => {
    const outsider = inbound(rawEmail({ from: 'Mallory <mallory@example.net>' }), {
      from: 'mallory@example.net',
      to: `agent+loopback@mail.${BASE_DOMAIN}`,
    });
    expect(await handleInboundAgentEmail(outsider, env, { submitter })).toMatchObject({
      kind: 'rejected',
    });
    expect((await readLoopbackStatus(env)).lastReceived).toBeNull();

    await updateAdminSettings(env, {
      changes: [{ name: 'agentEmail.loopbackPerHour', value: 2 }],
      actorUserId: 'admin-1',
    });
    const fromAgent = () =>
      inbound(rawEmail({ from: `Support inbox <${ADDRESS}>`, subject: 'Re: loopback' }), {
        from: ADDRESS,
        to: `agent+loopback@mail.${BASE_DOMAIN}`,
      });
    // The outsider above used one of the two slots in this hour.
    expect(await handleInboundAgentEmail(fromAgent(), env, { submitter })).toEqual({
      kind: 'loopback',
    });
    expect(await handleInboundAgentEmail(fromAgent(), env, { submitter })).toMatchObject({
      kind: 'rejected',
      reason: expect.stringMatching(/Too many loopback/),
    });
  });

  it('reports accepted, and never starts a second task, when recording acceptance fails', async () => {
    const errorLog = vi.spyOn(log, 'error');
    const failing = failNextAcceptedWrite(env.DATABASE);
    env.DATABASE = failing.db;
    const realSubmitter = submitter.getMockImplementation()!;
    submitter.mockImplementation(async (submitEnv, input) => {
      const result = await realSubmitter(submitEnv, input);
      failing.arm();
      return result;
    });

    const first = await handleInboundAgentEmail(inbound(rawEmail()), env, { submitter });
    const retry = await handleInboundAgentEmail(inbound(rawEmail()), env, { submitter });

    expect(first).toMatchObject({ kind: 'accepted' });
    // Liveness: the injected failure really happened on the acceptance write.
    expect(errorLog).toHaveBeenCalledWith(
      'agent_email.inbound_bookkeeping_failed',
      expect.objectContaining({ error: expect.stringContaining('update "trigger_email_messages"') })
    );
    expect(retry).toEqual({ kind: 'duplicate' });
    expect(submitter).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 });
    errorLog.mockRestore();
  });

  it('does not resubmit an email whose task exists when a crashed attempt is taken over', async () => {
    const accepted = await handleInboundAgentEmail(inbound(rawEmail()), env, { submitter });
    if (accepted.kind !== 'accepted') throw new Error('fixture email was not accepted');
    // Simulate a Worker that died after submitting: the row is still processing, lease expired.
    sqlite
      .prepare(
        `UPDATE trigger_email_messages SET status = 'processing', lease_expires_at = ?
          WHERE direction = 'inbound'`
      )
      .run('2000-01-01T00:00:00.000Z');

    const redelivery = await handleInboundAgentEmail(inbound(rawEmail()), env, { submitter });

    expect(redelivery).toEqual({ kind: 'duplicate' });
    expect(submitter).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare(`SELECT status FROM trigger_email_messages`).all()).toEqual([
      { status: 'accepted' },
    ]);
  });

  it('records loopback replies without looking up a trigger, even when auto-submitted', async () => {
    const delivery = inbound(
      rawEmail({
        from: `Support inbox <${ADDRESS}>`,
        subject: 'Re: SAM agent email loopback test',
        headers: ['Auto-Submitted: auto-replied'],
      }),
      { from: ADDRESS, to: `agent+loopback@mail.${BASE_DOMAIN}` }
    );

    const outcome = await handleInboundAgentEmail(delivery, env, { submitter });

    expect(outcome).toEqual({ kind: 'loopback' });
    expect(delivery.setReject).not.toHaveBeenCalled();
    expect((await readLoopbackStatus(env)).lastReceived).toMatchObject({
      from: ADDRESS,
      subject: 'Re: SAM agent email loopback test',
      autoSubmitted: 'auto-replied',
    });
  });

  describe('reply_to_email authorization', () => {
    async function acceptedTaskId(): Promise<string> {
      const outcome = await handleInboundAgentEmail(inbound(rawEmail()), env, { submitter });
      if (outcome.kind !== 'accepted') throw new Error('fixture email was not accepted');
      return outcome.executionId;
    }

    it('refuses a task that was not started by an email trigger', async () => {
      const now = new Date().toISOString();
      sqlite
        .prepare(
          `INSERT INTO tasks (id, project_id, user_id, title, status, triggered_by, created_at, updated_at)
           VALUES ('task-user', ?, 'user-1', 'Manual', 'queued', 'user', ?, ?)`
        )
        .run(PROJECT_ID, now, now);

      await expect(
        replyToTriggerEmail(
          env,
          { projectId: PROJECT_ID, taskId: 'task-user', body: 'hi' },
          agentEmailSenderFor(env)
        )
      ).rejects.toMatchObject({ code: 'not_email_task' });
      expect(mail.sent).toHaveLength(0);
    });

    it('refuses a caller from another project even with the real task id', async () => {
      const taskId = await acceptedTaskId();

      await expect(
        replyToTriggerEmail(
          env,
          { projectId: OTHER_PROJECT_ID, taskId, body: 'hi' },
          agentEmailSenderFor(env)
        )
      ).rejects.toMatchObject({ code: 'not_email_task' });
      expect(mail.sent).toHaveLength(0);

      // Owner control: the same task in its own project can reply.
      await replyToTriggerEmail(
        env,
        { projectId: PROJECT_ID, taskId, body: 'hi' },
        agentEmailSenderFor(env)
      );
      expect(mail.sent).toHaveLength(1);
    });

    it('refuses once the email trigger is deleted', async () => {
      const taskId = await acceptedTaskId();
      sqlite.prepare('DELETE FROM trigger_email_configs').run();

      await expect(
        replyToTriggerEmail(
          env,
          { projectId: PROJECT_ID, taskId, body: 'hi' },
          agentEmailSenderFor(env)
        )
      ).rejects.toMatchObject({ code: 'trigger_gone' });
      expect(mail.sent).toHaveLength(0);
    });

    it('caps replies per run, counting failed sends, and lets exactly one racer take the last slot', async () => {
      await updateAdminSettings(env, {
        changes: [{ name: 'agentEmail.maxRepliesPerRun', value: 3 }],
        actorUserId: 'admin-1',
      });
      const taskId = await acceptedTaskId();
      const reply = (body: string) =>
        replyToTriggerEmail(env, { projectId: PROJECT_ID, taskId, body }, agentEmailSenderFor(env));

      mail.failOnce();
      await expect(reply('first')).rejects.toMatchObject({ code: 'send_failed' });
      await reply('second');
      const race = await Promise.allSettled([reply('third-a'), reply('third-b')]);

      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = race.find((result) => result.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(AgentEmailReplyError);
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'cap_reached' });
      expect(mail.sent).toHaveLength(2);
      expect(
        sqlite
          .prepare(
            `SELECT status, count(*) AS n FROM trigger_email_messages
              WHERE direction = 'outbound' GROUP BY status ORDER BY status`
          )
          .all()
      ).toEqual([
        { status: 'failed', n: 1 },
        { status: 'sent', n: 2 },
      ]);
    });

    it('reports a reply as sent even if recording it fails after the email left', async () => {
      const taskId = await acceptedTaskId();
      const realSend = mail.binding.send.bind(mail.binding);
      env.AGENT_EMAIL = {
        async send(message: EmailMessageBuilder) {
          const result = await realSend(message);
          // The provider accepted the email; now the bookkeeping write cannot succeed.
          sqlite.exec('ALTER TABLE trigger_email_messages RENAME TO trigger_email_messages_gone');
          return result;
        },
      } as unknown as SendEmail;

      const result = await replyToTriggerEmail(
        env,
        { projectId: PROJECT_ID, taskId, body: 'Done.' },
        agentEmailSenderFor(env)
      );

      expect(result).toMatchObject({ to: 'alice@example.com', repliesRemaining: 0 });
      expect(mail.sent).toHaveLength(1);
    });

    it('never lets stored inbound header text reach outbound headers unsanitized', async () => {
      const taskId = await acceptedTaskId();
      // postal-mime already folds CR/LF out of decoded subjects; another provider may not.
      // The reply path must sanitize what it reads from storage on its own.
      sqlite
        .prepare(`UPDATE trigger_email_messages SET subject = ? WHERE direction = 'inbound'`)
        .run('Hello\r\nBcc: evil@example.net');

      await replyToTriggerEmail(
        env,
        { projectId: PROJECT_ID, taskId, body: 'ok' },
        agentEmailSenderFor(env)
      );

      expect(mail.sent[0]?.subject).toBe('Re: Hello Bcc: evil@example.net');
      expect(mail.sent[0]?.to).toBe('alice@example.com');
    });
  });
});
