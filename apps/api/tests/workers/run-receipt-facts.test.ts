/**
 * The run receipt's ProjectData read (`do/run-receipt-facts.ts`) on the real Durable Object SQLite,
 * through the service wrapper the operation port calls. Tool calls are counted by distinct
 * `toolCallId` inside the window, a malformed metadata row costs only itself, and questions come
 * from `needs_input` markers.
 */
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { getRunReceiptFacts } from '../../src/services/project-data';

const MIN = 60_000;
const T0 = 1_794_000_000_000;

function getStub(projectId: string): DurableObjectStub<ProjectData> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
}

async function seed(projectId: string) {
  const stub = getStub(projectId);
  await stub.ensureProjectId(projectId);
  const sessionId = await stub.createSession(null, 'Receipt chat');
  const otherSession = await stub.createSession(null, 'Other chat');
  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    let sequence = 0;
    const message = (session: string, role: string, at: number, meta: string | null) => {
      sequence += 1;
      sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
         VALUES (?, ?, ?, '', ?, ?, ?)`,
        `m-${sequence}`,
        session,
        role,
        meta,
        at,
        sequence
      );
    };
    const tool = (id: string, kind: string) =>
      JSON.stringify({ toolCallId: id, kind, status: 'completed' });
    message(sessionId, 'tool', T0 - MIN, tool('before-window', 'execute')); // outside the window
    message(sessionId, 'user', T0 + MIN, null);
    message(sessionId, 'tool', T0 + 2 * MIN, tool('call-a', 'execute'));
    message(sessionId, 'tool', T0 + 3 * MIN, tool('call-a', 'execute')); // update of call-a
    message(sessionId, 'tool', T0 + 4 * MIN, tool('call-b', 'read'));
    message(sessionId, 'tool', T0 + 5 * MIN, '{not json'); // malformed row
    message(sessionId, 'tool', T0 + 6 * MIN, tool('call-c', 'edit'));
    message(sessionId, 'assistant', T0 + 7 * MIN, null);
    message(sessionId, 'user', T0 + 9 * MIN, null);
    message(otherSession, 'tool', T0 + 3 * MIN, tool('foreign-call', 'execute'));
    sql.exec(
      `INSERT INTO session_attention_markers (id, session_id, kind, source, reason, created_at, resolved_at)
       VALUES ('q1', ?, 'needs_input', 'request_human_input', 'Use backoff?', ?, ?),
              ('q2', ?, 'needs_input', 'request_human_input', 'Still there?', ?, NULL),
              ('q3', ?, 'reconciliation_checkin', 'reconciliation', 'not a question', ?, NULL),
              ('q4', ?, 'needs_input', 'request_human_input', 'other chat', ?, NULL)`,
      sessionId,
      T0 + 2 * MIN,
      T0 + 4 * MIN,
      sessionId,
      T0 + 8 * MIN,
      sessionId,
      T0 + 3 * MIN,
      otherSession,
      T0 + 3 * MIN
    );
    sql.exec(
      `INSERT INTO acp_sessions (id, chat_session_id, status, created_at, updated_at)
       VALUES ('acp-old', ?, 'completed', ?, ?), ('acp-new', ?, 'running', ?, ?)`,
      sessionId,
      T0,
      T0,
      sessionId,
      T0 + MIN,
      T0 + MIN
    );
  });
  return { stub, sessionId };
}

const input = (sessionId: string, overrides: Record<string, unknown> = {}) => ({
  sessionId,
  fromMs: T0,
  toMs: T0 + 10 * MIN,
  messageScanMaxRows: 1000,
  waitingMaxIntervals: 50,
  ...overrides,
});

describe('getRunReceiptFacts', () => {
  it('counts tool calls by kind in the window, once per call, and tolerates a malformed row', async () => {
    const projectId = 'receipt-facts-counts';
    const { sessionId } = await seed(projectId);
    const facts = await getRunReceiptFacts(env as unknown as Env, projectId, input(sessionId));
    expect(facts.sessionFound).toBe(true);
    expect(facts.messagesArchived).toBe(false);
    expect(facts.toolCalls.byKind).toEqual([
      { kind: 'edit', count: 1 },
      { kind: 'execute', count: 1 },
      { kind: 'other', count: 1 },
      { kind: 'read', count: 1 },
    ]);
    expect(facts.toolCalls.total).toBe(4);
    // Eight messages in the window: two user, one assistant, five tool rows.
    expect(facts.toolCalls.examinedMessages).toBe(8);
    expect(facts.toolCalls.scanLimited).toBe(false);
    // Exactly at the cap is not a floor.
    const exact = await getRunReceiptFacts(
      env as unknown as Env,
      projectId,
      input(sessionId, { messageScanMaxRows: 8 })
    );
    expect(exact.toolCalls.scanLimited).toBe(false);
    expect(exact.toolCalls.total).toBe(4);
    expect(facts.waitingIntervals).toEqual([
      { startMs: T0 + 2 * MIN, endMs: T0 + 4 * MIN, reason: 'Use backoff?' },
      { startMs: T0 + 8 * MIN, endMs: null, reason: 'Still there?' },
    ]);
    expect(facts.lastAgentMessageAt).toBe(T0 + 7 * MIN);
    expect(facts.lastMessageAt).toBe(T0 + 9 * MIN);
    expect(facts.acpSessionIds).toEqual(['acp-new', 'acp-old']);
  });

  it('caps messages read, not tool rows matched, says so, and bounds the questions', async () => {
    const projectId = 'receipt-facts-cap';
    const { sessionId } = await seed(projectId);
    const facts = await getRunReceiptFacts(
      env as unknown as Env,
      projectId,
      input(sessionId, { messageScanMaxRows: 3, waitingMaxIntervals: 1 })
    );
    expect(facts.toolCalls.examinedMessages).toBe(3);
    expect(facts.toolCalls.scanLimited).toBe(true);
    // The first three messages are the user prompt and two rows of call-a: the user message
    // spends the cap too, so a chat with few tool calls cannot make the read walk the session.
    expect(facts.toolCalls.byKind).toEqual([{ kind: 'execute', count: 1 }]);
    expect(facts.waitingIntervals).toHaveLength(1);
    expect(facts.waitingLimited).toBe(true);
  });

  it('does not count an archived chat, and reports a missing chat as not found', async () => {
    const projectId = 'receipt-facts-archived';
    const { stub, sessionId } = await seed(projectId);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE chat_sessions SET archive_state = 'source_deleted' WHERE id = ?`,
        sessionId
      );
    });
    const archived = await getRunReceiptFacts(env as unknown as Env, projectId, input(sessionId));
    expect(archived.messagesArchived).toBe(true);
    expect(archived.toolCalls.total).toBe(0);
    expect(archived.waitingIntervals).toHaveLength(2);

    const missing = await getRunReceiptFacts(
      env as unknown as Env,
      projectId,
      input('no-such-chat')
    );
    expect(missing.sessionFound).toBe(false);
    expect(missing.toolCalls.total).toBe(0);
  });
});
