/**
 * The new Connector tools, called the way an app calls them: JSON-RPC `tools/call` over the real
 * `/connect/mcp` adapter with a personal access token, through the shared operations, into the
 * real ProjectData Durable Object and D1. Nothing below the HTTP request is mocked, so a renamed
 * Durable Object method, a schema the adapter cannot carry, or a lost requestKey fails here.
 */
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { hmacToken } from '../../src/routes/api-tokens';
import { createSession, persistMessageBatch } from '../../src/services/project-data';
import { seedInstallation, seedProject, seedTask, seedUser } from './helpers/seed-d1';

const suffix = crypto.randomUUID();
const testEnv = env as unknown as Env;
const owner = `connector-tools-owner-${suffix}`;
const outsider = `connector-tools-outsider-${suffix}`;
const project = `connector-tools-project-${suffix}`;
const rootTask = `connector-tools-root-${suffix}`;
const subtask = `connector-tools-subtask-${suffix}`;
const ownerPat = `sam_pat_owner${suffix.replaceAll('-', '')}`;
const outsiderPat = `sam_pat_outsider${suffix.replaceAll('-', '')}`;
let chat: string;

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
  // The Connector wraps every result as { data, link, untrustedContent }.
  structuredContent?: { data: unknown };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  pat = ownerPat
): Promise<ToolResult> {
  const response = await SELF.fetch('https://api.test.example.com/connect/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const line = text.split('\n').find((candidate) => candidate.startsWith('data:'));
  const wire = JSON.parse(text.startsWith('event:') && line ? line.slice(5).trim() : text) as {
    result: ToolResult;
  };
  return wire.result;
}

/** The operation's own result, or a failure naming the error the adapter returned. */
async function data(name: string, args: Record<string, unknown>) {
  const result = await callTool(name, args);
  if (result.isError || !result.structuredContent) {
    throw new Error(`${name} failed: ${result.content[0]?.text}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wire JSON, asserted below
  return result.structuredContent.data as Record<string, any>;
}

beforeAll(async () => {
  for (const [user, pat] of [
    [owner, ownerPat],
    [outsider, outsiderPat],
  ] as const) {
    await seedUser(user);
    await env.DATABASE.prepare("UPDATE users SET status='active' WHERE id=?").bind(user).run();
    await env.DATABASE.prepare(
      'INSERT INTO smoke_test_tokens (id,user_id,token_hash,name) VALUES (?,?,?,?)'
    )
      .bind(`pat-${user}`, user, await hmacToken(pat, testEnv.ENCRYPTION_KEY), 'Connector tools')
      .run();
  }
  await seedInstallation(`connector-tools-install-${suffix}`, owner);
  await seedProject(project, owner, `connector-tools-install-${suffix}`);
  chat = await createSession(testEnv, project, null, 'Release review', rootTask, owner);
  await seedTask(rootTask, project, owner, {
    title: 'Release review',
    status: 'in_progress',
    chatSessionId: chat,
    triggeredBy: 'user',
  });
  await seedTask(subtask, project, owner, { title: 'Check the changelog', triggeredBy: 'mcp' });
  await env.DATABASE.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?')
    .bind(rootTask, subtask)
    .run();
  // An agent reply arrives as one stored row per streamed chunk.
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, seconds)).toISOString();
  await persistMessageBatch(testEnv, project, chat, [
    {
      messageId: `u1-${suffix}`,
      role: 'user',
      content: 'Is the release ready?',
      toolMetadata: null,
      timestamp: at(0),
    },
    {
      messageId: `a1-${suffix}`,
      role: 'assistant',
      content: 'The release ',
      toolMetadata: null,
      timestamp: at(1),
    },
    {
      messageId: `a2-${suffix}`,
      role: 'assistant',
      content: 'is ready; ',
      toolMetadata: null,
      timestamp: at(2),
    },
    {
      messageId: `a3-${suffix}`,
      role: 'assistant',
      content: 'checks pass.',
      toolMetadata: null,
      timestamp: at(3),
    },
  ]);
});

describe('new Connector tools through the real MCP adapter', () => {
  it('reads whole messages from the ProjectData object', async () => {
    const read = await data('sam_chat_read', { projectId: project, sessionId: chat });

    expect(read.paginationUnit).toBe('logical_messages');
    expect(read.messages).toMatchObject([
      {
        kind: 'message',
        role: 'assistant',
        messageId: `a1-${suffix}`,
        content: 'The release is ready; checks pass.',
      },
      { kind: 'message', role: 'user', content: 'Is the release ready?' },
    ]);
    expect(read.latest).toMatchObject({
      assistant: { messageId: `a1-${suffix}`, inPage: true },
      user: { messageId: `u1-${suffix}`, inPage: true },
    });
  });

  it('continues a message by offset, and a non-member learns nothing', async () => {
    const part = await data('sam_chat_message_get', {
      projectId: project,
      sessionId: chat,
      messageId: `a2-${suffix}`,
      offset: 4,
      maxChars: 8,
    });
    expect(part.message).toMatchObject({
      messageId: `a1-${suffix}`,
      content: 'release ',
      contentLength: 'The release is ready; checks pass.'.length,
      truncated: true,
      nextOffset: 12,
    });

    const denied = await callTool(
      'sam_chat_message_get',
      { projectId: project, sessionId: chat, messageId: `a2-${suffix}` },
      outsiderPat
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toMatch(/^not_found:/);
    expect(JSON.stringify(denied)).not.toContain('release');
  });

  it('summarizes a task and its subtask with the chat state read from ProjectData', async () => {
    const team = await data('sam_team_status', { projectId: project, taskId: rootTask });

    expect(team.tasks.map((task: { taskId: string }) => task.taskId)).toEqual([rootTask, subtask]);
    expect(team.tasks[0]).toMatchObject({ relation: 'root', chat: { sessionId: chat } });
    expect(team.tasks[0].chat.status).not.toBe('unknown');
    expect(team.sources).toMatchObject({ sessions: 'project_data' });
    expect(team.deployments).toMatchObject({ deployedCommit: 'not_recorded' });
  });

  it('schedules a message once per requestKey, reads it back, and cancels it', async () => {
    const create = {
      projectId: project,
      requestKey: `schedule-${suffix}`,
      runAt: new Date(Date.now() + 86_400_000).toISOString(),
      action: { kind: 'message_session', sessionId: chat, message: 'Any blockers?' },
    };
    const first = await data('sam_schedule_create', create);
    const retried = await data('sam_schedule_create', create);
    expect(first).toMatchObject({
      kind: 'one_off',
      state: 'pending',
      action: { kind: 'message_session', targetSessionId: chat },
      receipt: { accepted: true, meaning: 'scheduled_not_started' },
    });
    const scheduleId = first.scheduleId as string;
    expect(retried.scheduleId).toBe(scheduleId);

    const got = await data('sam_schedule_get', { projectId: project, scheduleId });
    expect(got).toMatchObject({ scheduleId, kind: 'one_off', creator: { isYou: true } });
    expect(got.prompt.text).toContain('Any blockers?');
    const listed = await data('sam_schedules_list', { projectId: project });
    expect(listed.oneOff.map((item: { scheduleId: string }) => item.scheduleId)).toContain(
      scheduleId
    );

    const cancelled = await data('sam_schedule_cancel', {
      projectId: project,
      scheduleId,
      expectedVersion: got.version,
      requestKey: `cancel-${suffix}`,
    });
    expect(cancelled).toMatchObject({
      scheduleId,
      state: 'cancelled',
      receipt: { cancelled: true, meaning: 'cancelled_will_not_run' },
    });
  });

  it('lists coordination channels from ProjectData', async () => {
    const channels = await data('sam_channels_list', { projectId: project });
    expect(channels).toMatchObject({
      channels: [],
      nextCursor: null,
      includeDirect: false,
      hiddenDirectChannels: 0,
    });
  });
});
