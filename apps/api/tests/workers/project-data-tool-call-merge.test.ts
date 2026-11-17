import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import { canonicalToolRowId } from '@simple-agent-manager/project-data/internal/do/tool-call-merge';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';
import { profileObject, type WriteSample } from './helpers/archive-write-profile';

const source = {
  workspaceId: 'tool-workspace',
  callbackGeneration: 'generation-a',
  outboxIncarnation: 'outbox-a',
};
const now = Date.now();
function notification(
  sequence: number,
  metadata: Record<string, unknown>,
  content = '(tool update)'
) {
  return {
    messageId: `report-${sequence}`,
    role: 'tool',
    content,
    toolMetadata: JSON.stringify({ toolCallId: 'call-a', ...metadata }),
    timestamp: new Date(now + sequence).toISOString(),
    sequence,
  };
}
async function fixture(enabled = true, textEnabled = false) {
  vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
    enabled: textEnabled,
    toolUpdatesEnabled: enabled,
    maxRowBytes: 65536,
    recentIds: 200,
  });
  const stub = projectDataStub(`tool-merge-${crypto.randomUUID()}`);
  await stub.ensureProjectId('tool-test');
  const session = await stub.createSession(source.workspaceId, 'Tool test');
  return { stub, session };
}
async function rows(stub: ReturnType<typeof projectDataStub>, session: string) {
  return (await stub.getMessages(session, 1000, null, null, undefined, false, 'asc')).messages;
}
afterEach(() => vi.restoreAllMocks());

describe('canonical tool snapshots through real ProjectData ingest', () => {
  it('preserves canonical comment anchors and reports final activity through sessions_read reader', async () => {
    const { stub, session } = await fixture();
    await stub.persistMessageBatch(
      session,
      [notification(1, { title: 'Inspect', status: 'pending' }, 'initial')],
      source
    );
    const first = (await rows(stub, session))[0]!;
    const { thread } = await stub.createCommentThread({
      sessionId: session,
      messageId: first.id,
      quote: 'initial',
      body: 'Review this call',
      actor: { kind: 'human', id: 'tool-test-user', name: 'Reviewer' },
    });
    await stub.persistMessageBatch(
      session,
      [notification(2, { status: 'completed' }, 'final')],
      source
    );
    const updated = (await rows(stub, session))[0]!;
    expect(updated.id).toBe(first.id);
    expect(await stub.getCommentThread({ sessionId: session, threadId: thread.id })).toMatchObject({
      anchor: { kind: 'message', messageId: first.id, quote: 'initial' },
    });
    const logical = await stub.archiveSourceGetLogicalTranscript(
      {
        projectId: 'tool-test',
        sessionId: session,
        ownerName: 'tool-test',
        generation: 1,
        migrationId: null,
      },
      {
        before: null,
        limit: 10,
        roles: ['user', 'assistant', 'system'],
        maxScanRows: 5000,
        maxMessageChars: 10000,
        maxPageChars: 100000,
        includeLatest: false,
        includeToolTitles: true,
      }
    );
    expect(logical.entries).toEqual([
      expect.objectContaining({
        kind: 'activity',
        firstRowId: first.id,
        rowCount: 1,
        toolCalls: 1,
        toolStatuses: { completed: 1 },
        toolTitles: ['Inspect'],
        updatedAt: updated.toolMetadata!._samToolUpdatedAt,
      }),
    ]);
  });

  it('keeps reused provider IDs distinct through source rotation, retired fallback and retry', async () => {
    const { stub, session } = await fixture();
    const next = { ...source, outboxIncarnation: 'outbox-b' };
    await stub.persistMessageBatch(session, [notification(1, { status: 'pending' })], source);
    await stub.persistMessageBatch(
      session,
      [{ ...notification(1, { status: 'pending' }), messageId: 'next-start' }],
      next
    );
    const late = notification(2, { status: 'completed' }, 'final-a');
    await stub.persistMessageBatch(session, [late], source);
    await stub.persistMessageBatch(
      session,
      [{ ...notification(2, { status: 'completed' }, 'final-b'), messageId: 'next-end' }],
      next
    );
    const stored = await rows(stub, session);
    expect(stored).toHaveLength(4);
    // Starts share a timestamp; their canonical hash IDs define the read order.
    const identityA = await canonicalToolRowId(session, source, 'call-a');
    const identityB = await canonicalToolRowId(session, next, 'call-a');
    expect(stored.find((row) => row.id === 'report-2')?.toolMetadata?._samToolCanonicalId).toBe(
      identityA
    );
    expect(stored.find((row) => row.id === 'next-end')?.toolMetadata?._samToolCanonicalId).toBe(
      identityB
    );
    expect(
      stored.filter((row) => row.toolMetadata?._samToolCanonicalId === identityA)
    ).toHaveLength(2);
    expect(
      stored.filter((row) => row.toolMetadata?._samToolCanonicalId === identityB)
    ).toHaveLength(2);
    expect(await stub.persistMessageBatch(session, [late], source)).toMatchObject({
      persisted: 0,
      duplicates: 1,
    });
    expect(await rows(stub, session)).toEqual(stored);
    const logical = await stub.archiveSourceGetLogicalTranscript(
      {
        projectId: 'tool-test',
        sessionId: session,
        ownerName: 'tool-test',
        generation: 1,
        migrationId: null,
      },
      {
        before: null,
        limit: 10,
        roles: ['user', 'assistant', 'system'],
        maxScanRows: 5000,
        maxMessageChars: 10000,
        maxPageChars: 100000,
        includeLatest: false,
        includeToolTitles: false,
      }
    );
    expect(logical.entries).toEqual([
      expect.objectContaining({
        kind: 'activity',
        rowCount: 4,
        toolCalls: 2,
        toolStatuses: { completed: 2 },
      }),
    ]);
  });

  it.each([
    [
      'Claude',
      [
        notification(1, { title: 'Read file', kind: 'read', status: 'pending' }, '(tool call)'),
        notification(2, { status: 'completed' }),
        notification(
          3,
          { content: [{ type: 'content', content: { type: 'text', text: 'claude final' } }] },
          'claude final'
        ),
      ],
    ],
    [
      'Codex',
      [
        notification(
          1,
          { title: 'Run command', kind: 'execute', status: 'in_progress' },
          '(tool call)'
        ),
        notification(
          2,
          {
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'codex final' } }],
          },
          'codex final'
        ),
      ],
    ],
    [
      'OpenCode',
      [
        notification(
          1,
          { title: 'Run command', kind: 'execute', status: 'pending' },
          '(tool call)'
        ),
        notification(2, { status: 'in_progress' }),
        notification(3, { status: 'in_progress' }, 'progress'),
        notification(
          4,
          {
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'opencode final' } }],
          },
          'opencode final'
        ),
      ],
    ],
  ] as const)(
    '%s stores one final row and reduces actual workerd row writes',
    async (_name, lifecycle) => {
      const counts: number[] = [];
      for (const enabled of [false, true]) {
        const { stub, session } = await fixture(enabled);
        const samples: WriteSample[] = [];
        const collect = await profileObject(stub, 'tool-ingest', samples);
        for (const message of lifecycle) await stub.persistMessageBatch(session, [message], source);
        collect();
        const stored = await rows(stub, session);
        expect(stored).toHaveLength(enabled ? 1 : lifecycle.length);
        expect(stored.at(-1)?.content).toBe(lifecycle.at(-1)?.content);
        if (enabled) expect(stored.at(-1)?.toolMetadata).toMatchObject({ status: 'completed' });
        const writes = samples
          .filter((sample) =>
            /^INSERT INTO chat_messages \(|^UPDATE chat_messages SET/.test(sample.statement)
          )
          .reduce((sum, sample) => sum + sample.rowsWritten, 0);
        expect(writes).toBe(enabled ? lifecycle.length + 2 : lifecycle.length * 3);
        counts.push(writes);
        if (enabled) {
          const before = await rows(stub, session);
          const retried = await stub.persistMessageBatch(session, [...lifecycle], source);
          expect(retried).toMatchObject({ persisted: 0, duplicates: lifecycle.length });
          expect(await rows(stub, session)).toEqual(before);
        }
      }
      expect(counts[1]).toBeLessThan(counts[0]!);
    }
  );

  it('preserves sparse output/title and terminal status across later content and stale status', async () => {
    const { stub, session } = await fixture();
    await stub.persistMessageBatch(
      session,
      [
        notification(
          1,
          {
            title: 'Rich title',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'first' } }],
          },
          'first'
        ),
      ],
      source
    );
    await stub.persistMessageBatch(
      session,
      [notification(2, { title: '', status: 'pending', content: [] })],
      source
    );
    await stub.persistMessageBatch(session, [notification(3, {}, 'late output')], source);
    const stored = await rows(stub, session);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      content: 'late output',
      toolMetadata: { title: 'Rich title', status: 'completed', _samToolRevision: 3 },
    });
  });

  it('recovers identity without a locator map and scopes provider reuse to source incarnation', async () => {
    const { stub, session } = await fixture();
    await stub.persistMessageBatch(
      session,
      [notification(1, { title: 'Start', status: 'pending' })],
      source
    );
    await stub.persistMessageBatch(
      session,
      [notification(2, { status: 'completed' }, 'result')],
      source
    );
    const stored = await rows(stub, session);
    expect(stored[0]?.id).toBe(canonicalToolRowId(session, source, 'call-a'));
    await stub.persistMessageBatch(session, [notification(3, { status: 'pending' })], {
      ...source,
      outboxIncarnation: 'outbox-b',
    });
    expect(await rows(stub, session)).toHaveLength(2);
  });

  it('refreshes grouped search after materialization without splitting parallel tool calls', async () => {
    const { stub, session } = await fixture();
    await stub.persistMessageBatch(
      session,
      [
        notification(1, { status: 'in_progress' }, 'beforetoken '),
        notification(2, { toolCallId: 'call-b', status: 'completed' }, 'othercall '),
      ],
      source
    );
    await stub.materializeSession(session);
    expect((await stub.searchMessagesWithCoverage('beforetoken', session)).results).toHaveLength(1);
    await stub.persistMessageBatch(
      session,
      [notification(3, { status: 'completed' }, 'aftertoken ')],
      source
    );
    expect((await stub.searchMessagesWithCoverage('beforetoken', session)).results).toHaveLength(0);
    expect((await stub.searchMessagesWithCoverage('aftertoken', session)).results).toHaveLength(1);
    expect((await stub.searchMessagesWithCoverage('othercall', session)).results).toHaveLength(1);
    await runInDurableObject(stub, (instance) => {
      const sql = (instance as unknown as { sql: SqlStorage }).sql;
      expect(
        sql
          .exec('SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?', session)
          .toArray()[0]?.count
      ).toBe(1);
    });
  });
});

describe('canonical tool safety boundaries', () => {
  it('journals older mutations and reports a cache reset after bounded receipt-window eviction', async () => {
    const { stub, session } = await fixture();
    await stub.persistMessageBatch(session, [notification(1, { status: 'pending' })], source);
    const initial = await stub.getToolChanges(session);
    await stub.persistMessageBatch(
      session,
      [notification(2, { toolCallId: 'other', status: 'completed' }, 'other')],
      source
    );
    await stub.persistMessageBatch(
      session,
      [notification(3, { status: 'completed' }, 'changed')],
      source
    );
    const changes = await stub.getToolChanges(session, initial.revision);
    expect(changes).toMatchObject({ revision: 3, resetRequired: false });
    expect(
      changes.messages.find((row) => row.id === canonicalToolRowId(session, source, 'call-a'))
        ?.content
    ).toBe('changed');
    vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
      enabled: false,
      toolUpdatesEnabled: true,
      maxRowBytes: 65536,
      recentIds: 2,
    });
    await stub.persistMessageBatch(
      session,
      [notification(4, { toolCallId: 'third', status: 'completed' })],
      source
    );
    await stub.persistMessageBatch(
      session,
      [notification(5, { toolCallId: 'fourth', status: 'completed' })],
      source
    );
    expect(await stub.getToolChanges(session, initial.revision)).toMatchObject({
      revision: 5,
      resetRequired: true,
    });
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec('SELECT stream_ingest_state FROM chat_sessions WHERE id = ?', session)
        .toArray()[0];
      const ingest = JSON.parse(String(row?.stream_ingest_state));
      expect(ingest.toolChanges.length).toBeLessThanOrEqual(2);
      expect(
        new TextEncoder().encode(String(row?.stream_ingest_state)).byteLength
      ).toBeLessThanOrEqual(65536);
    });
  });

  it('permanently seals mutation before a legacy snapshot and preserves the prior canonical row', async () => {
    const { stub, session } = await fixture();
    await stub.persistMessageBatch(session, [notification(1, { status: 'pending' })], source);
    const before = await rows(stub, session);
    await stub.getToolChanges(session, undefined, true);
    await stub.persistMessageBatch(
      session,
      [notification(2, { status: 'completed' }, 'done')],
      source
    );
    await stub.persistMessageBatch(session, [notification(3, {}, 'later')], source);
    const stored = await rows(stub, session);
    expect(stored).toHaveLength(3);
    expect(stored[0]).toEqual(before[0]);
    expect(stored[1]?.id).toBe('report-2');
  });

  it('merges concurrent invocations under the real archive mutex and retries only once', async () => {
    const { stub, session } = await fixture();
    const update = notification(2, { status: 'completed' }, 'final');
    await stub.persistMessageBatch(session, [notification(1, { status: 'pending' })], source);
    const accepted = await Promise.all([
      stub.persistMessageBatch(session, [update], source),
      stub.persistMessageBatch(session, [update], source),
    ]);
    expect(accepted.map((value) => value.persisted).sort()).toEqual([0, 1]);
    expect(await rows(stub, session)).toHaveLength(1);
    expect((await rows(stub, session))[0]?.toolMetadata).toMatchObject({ _samToolRevision: 2 });
  });

  it('keeps assistant runs apart when an intervening tool event only updates an older row', async () => {
    const { stub, session } = await fixture(true, true);
    await stub.persistMessageBatch(session, [notification(1, { status: 'pending' })], source);
    await stub.persistMessageBatch(
      session,
      [{ ...notification(2, {}), role: 'assistant', toolMetadata: null, content: 'first' }],
      source
    );
    await stub.persistMessageBatch(
      session,
      [notification(3, { status: 'completed' }, 'result')],
      source
    );
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec('SELECT stream_ingest_state FROM chat_sessions WHERE id = ?', session)
        .toArray()[0];
      expect(JSON.parse(String(row?.stream_ingest_state)).open).toBeNull();
    });
    await stub.persistMessageBatch(
      session,
      [{ ...notification(4, {}), role: 'assistant', toolMetadata: null, content: 'second' }],
      source
    );
    const stored = await rows(stub, session);
    expect(stored.map((row) => row.content)).toEqual(['result', 'first', 'second']);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            'SELECT message_count,last_message_sequence FROM chat_sessions WHERE id = ?',
            session
          )
          .toArray()[0]
      ).toMatchObject({ message_count: 4, last_message_sequence: 4 });
    });
  });

  it('retains ordinary inserts without authenticated incarnation or with invalid sequence ordering', async () => {
    for (const shape of ['no-incarnation', 'out-of-order'] as const) {
      const { stub, session } = await fixture();
      const batch = [
        notification(1, { status: 'pending' }),
        notification(2, { status: 'completed' }, 'done'),
      ];
      if (shape === 'out-of-order') batch[1]!.sequence = 1;
      await stub.persistMessageBatch(
        session,
        batch,
        shape === 'no-incarnation'
          ? { workspaceId: source.workspaceId, callbackGeneration: source.callbackGeneration }
          : source
      );
      expect(await rows(stub, session)).toHaveLength(2);
    }
  });

  it('refuses archive-owned canonical misses without creating another root row', async () => {
    const { stub, session } = await fixture();
    await stub.persistMessageBatch(
      session,
      [notification(1, { status: 'completed' }, 'before')],
      source
    );
    await stub.stopSession(session);
    await stub.archiveSourcePrepareIntent({
      projectId: 'tool-test',
      sessionId: session,
      migrationId: 'tool-fence',
      sourceOwnerName: 'tool-test',
      targetOwnerName: 'tool-test:archive:g1:s1',
      targetGeneration: 1,
      sourceIntentToken: 'tool-fence-token',
      now: Date.now() + 60000,
      minTerminalAgeMs: 1,
    });
    const captured = await stub.fetch(
      new Request('https://test/__capture-expected-error', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'persistMessageBatch',
          args: [
            session,
            [notification(2, { toolCallId: 'unknown', status: 'completed' })],
            source,
          ],
        }),
      })
    );
    expect(await captured.json()).toMatchObject({
      threw: true,
      message: expect.stringContaining('fenced'),
    });
    expect(await rows(stub, session)).toHaveLength(1);
  });
});

it('hydrates a real verified offload before a sparse update and removes the stale archive proof', async () => {
  const { archiveToolPayloadCandidate } =
    await import('@simple-agent-manager/project-data/internal/do/tool-payload-archive');
  const { stub, session } = await fixture();
  await stub.persistMessageBatch(
    session,
    [
      notification(
        1,
        {
          title: 'Keep title',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'retained '.repeat(1000) } }],
        },
        'searchable output'
      ),
    ],
    source
  );
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    const row = sql
      .exec(
        'SELECT id,created_at,sequence,tool_metadata FROM chat_messages WHERE session_id = ?',
        session
      )
      .toArray()[0]!;
    const env = (
      instance as unknown as {
        env: import('@simple-agent-manager/project-data/internal/do/types').Env;
      }
    ).env;
    const toolMetadata = String(row.tool_metadata);
    const result = await archiveToolPayloadCandidate({
      sql,
      env,
      projectId: 'tool-test',
      archivePrefix: 'tool-test',
      archiveWriteTimeoutMs: 5000,
      archiveChunkBytes: 262144,
      deadlineMs: Date.now() + 10000,
      nowMs: () => Date.now(),
      operationBudget: { used: 0, max: 20 },
      transactionSync: (fn) => state.storage.transactionSync(fn),
      candidate: {
        sessionId: session,
        messageId: String(row.id),
        createdAt: Number(row.created_at),
        sequence: Number(row.sequence),
        toolMetadataBytes: new TextEncoder().encode(toolMetadata).byteLength,
      },
      toolMetadata,
      archivedAt: Date.now(),
    });
    expect(result.rowsUpdated).toBe(1);
  });
  expect((await rows(stub, session))[0]?.toolMetadata).toMatchObject({ toolPayloadArchived: true });
  let r2Reads = 0;
  await runInDurableObject(stub, (instance) => {
    const holder = instance as unknown as {
      env: import('@simple-agent-manager/project-data/internal/do/types').Env;
    };
    const original = holder.env.PROJECT_DATA_ARCHIVE_R2!;
    holder.env = {
      ...holder.env,
      PROJECT_DATA_ARCHIVE_R2: new Proxy(original, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === 'get')
            return async (...args: unknown[]) => {
              r2Reads++;
              await new Promise((resolve) => setTimeout(resolve, 20));
              return value.apply(target, args);
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
  });
  expect(
    await stub.persistMessageBatch(session, [notification(1, { status: 'completed' })], source)
  ).toMatchObject({ persisted: 0, duplicates: 1 });
  expect(r2Reads).toBe(0);

  await Promise.all([
    stub.persistMessageBatch(session, [notification(2, { status: 'pending' })], source),
    stub.persistMessageBatch(session, [notification(3, { title: '' })], source),
  ]);
  expect(r2Reads).toBe(1);
  const stored = await rows(stub, session);
  expect(stored).toHaveLength(1);
  expect(stored[0]?.toolMetadata).toMatchObject({
    title: 'Keep title',
    status: 'completed',
    _samToolRevision: 3,
    content: [{ type: 'content', content: { type: 'text', text: 'retained '.repeat(1000) } }],
  });
  expect(stored[0]?.toolMetadata).not.toHaveProperty('toolPayloadArchived');
  await runInDurableObject(stub, (_instance, state) => {
    expect(
      state.storage.sql
        .exec('SELECT COUNT(*) AS count FROM tool_payload_archives WHERE session_id = ?', session)
        .toArray()[0]?.count
    ).toBe(0);
  });
});

it('keeps legacy admission session scoped and permanent after disconnect', async () => {
  const { stub, session } = await fixture();
  const other = await stub.createSession(source.workspaceId, 'Other session');
  const project = await stub.fetch(
    new Request('https://test/ws', { headers: { Upgrade: 'websocket' } })
  );
  project.webSocket!.accept();
  await stub.persistMessageBatch(session, [notification(1, { status: 'pending' })], source);
  const legacy = await stub.fetch(
    new Request(`https://test/ws?sessionId=${session}&messageAppend=append-v1`, {
      headers: { Upgrade: 'websocket' },
    })
  );
  legacy.webSocket!.accept();
  legacy.webSocket!.close();
  await stub.persistMessageBatch(
    session,
    [notification(2, { status: 'completed' }, 'done')],
    source
  );
  await stub.persistMessageBatch(
    other,
    [
      notification(1, { status: 'pending' }),
      notification(2, { status: 'completed' }, 'other done'),
    ],
    source
  );
  expect(await rows(stub, session)).toHaveLength(2);
  expect(await rows(stub, other)).toHaveLength(1);
  project.webSocket!.close();
});

it('recovers a canonical row after receipt journal eviction and retries beyond the UUID ring', async () => {
  const { stub, session } = await fixture();
  vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
    enabled: false,
    toolUpdatesEnabled: true,
    maxRowBytes: 65536,
    recentIds: 2,
  });
  const first = notification(1, { status: 'pending' });
  await stub.persistMessageBatch(session, [first], source);
  for (let sequence = 2; sequence <= 6; sequence++)
    await stub.persistMessageBatch(
      session,
      [notification(sequence, { toolCallId: `other-${sequence}`, status: 'completed' })],
      source
    );
  await stub.persistMessageBatch(
    session,
    [notification(7, { status: 'completed' }, 'recovered')],
    source
  );
  const replay = await stub.persistMessageBatch(session, [first], source);
  expect(replay).toMatchObject({ persisted: 0, duplicates: 1 });
  const stored = await rows(stub, session);
  expect(stored).toHaveLength(6);
  expect(
    stored.find((row) => row.id === canonicalToolRowId(session, source, 'call-a'))
  ).toMatchObject({
    content: 'recovered',
    toolMetadata: { _samToolRevision: 2, status: 'completed' },
  });
});

it('isolates bad journal snapshots instead of losing healthy cards', async () => {
  const { stub, session } = await fixture();
  await stub.persistMessageBatch(
    session,
    [
      notification(1, { toolCallId: 'good-a' }),
      notification(2, { toolCallId: 'bad' }),
      notification(3, { toolCallId: 'good-b' }),
    ],
    source
  );
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      'UPDATE chat_messages SET created_at = ? WHERE id = ?',
      'invalid-clock',
      canonicalToolRowId(session, source, 'bad')
    );
  });
  const changes = await stub.getToolChanges(session);
  expect(changes.messages).toHaveLength(2);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      'UPDATE chat_messages SET created_at = ? WHERE session_id = ?',
      'invalid-clock',
      session
    );
  });
  expect((await stub.getToolChanges(session)).messages).toEqual([]);
});

it('refreshes a non-first Unicode tool behind a prefix longer than 5000 rows', async () => {
  const { stub, session } = await fixture();
  for (let offset = 0; offset < 5101; offset += 100) {
    const batch = Array.from({ length: Math.min(100, 5101 - offset) }, (_, index) => {
      const sequence = offset + index + 1;
      return notification(
        sequence,
        { toolCallId: `parallel-${sequence}`, status: 'completed' },
        sequence === 5101 ? 'oldneedle' : '🙂日本語 '
      );
    });
    await stub.persistMessageBatch(session, batch, source);
  }
  await stub.materializeSession(session);
  await stub.materializeSession(session);
  const searches: { query: string; rowsRead: number; plan: string[] }[] = [];
  await runInDurableObject(stub, (instance) => {
    const holder = instance as unknown as { sql: SqlStorage };
    const original = holder.sql;
    holder.sql = new Proxy(original, {
      get(target, key) {
        if (key === 'exec')
          return (query: string, ...args: unknown[]) => {
            const cursor = target.exec(query, ...(args as SqlStorageValue[]));
            if (query.startsWith('SELECT g.rowid') || query.startsWith('SELECT COALESCE(SUM')) {
              const rows = cursor.toArray();
              searches.push({
                query,
                rowsRead: cursor.rowsRead,
                plan: target
                  .exec('EXPLAIN QUERY PLAN ' + query, ...(args as SqlStorageValue[]))
                  .toArray()
                  .map((row) => String(row.detail)),
              });
              return { ...cursor, toArray: () => rows };
            }
            return cursor;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  await stub.persistMessageBatch(
    session,
    [notification(5102, { toolCallId: 'parallel-5101' }, 'newneedle')],
    source
  );
  expect(searches).toHaveLength(2);
  for (const search of searches) {
    expect(
      search.plan.some((detail) =>
        /SEARCH .*USING INDEX|SEARCH .*USING COVERING INDEX/.test(detail)
      )
    ).toBe(true);
    expect(search.plan.some((detail) => /SCAN (chat_messages|g|m)\b/.test(detail))).toBe(false);
    expect(search.rowsRead).toBeLessThan(20000);
  }

  expect((await stub.searchMessagesWithCoverage('oldneedle', session)).results).toHaveLength(0);
  expect((await stub.searchMessagesWithCoverage('newneedle', session)).results).toHaveLength(1);
  await runInDurableObject(stub, (_instance, state) => {
    expect(
      state.storage.sql
        .exec('SELECT content FROM chat_messages_grouped WHERE session_id = ?', session)
        .toArray()
        .map((row) => row.content)
        .join('')
    ).toBe('🙂日本語 '.repeat(5100) + 'newneedle');
  });
}, 60000);

it('returns an explicit cache reset instead of an oversized mutation response', async () => {
  const { stub, session } = await fixture();
  await stub.persistMessageBatch(
    session,
    Array.from({ length: 31 }, (_, index) =>
      notification(index + 1, { toolCallId: `large-${index}` })
    ),
    source
  );
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      'UPDATE chat_messages SET content = ? WHERE session_id = ?',
      'x'.repeat(600000),
      session
    );
  });
  expect(await stub.getToolChanges(session, 0)).toMatchObject({
    revision: 31,
    resetRequired: true,
    messages: [],
  });
});

it('retains nested output when later content is an empty typed placeholder', async () => {
  const { stub, session } = await fixture();
  await stub.persistMessageBatch(
    session,
    [
      notification(
        1,
        { status: 'completed', content: [{ type: 'terminal', output: 'keep this' }] },
        'keep this'
      ),
    ],
    source
  );
  await stub.persistMessageBatch(
    session,
    [notification(2, { content: [{ type: 'terminal', output: '' }] })],
    source
  );
  expect((await rows(stub, session))[0]).toMatchObject({
    content: 'keep this',
    toolMetadata: { content: [{ type: 'terminal', output: 'keep this' }], status: 'completed' },
  });
});

it('never resumes mutation behind fallback rows after the kill switch is re-enabled', async () => {
  const { stub, session } = await fixture();
  await stub.persistMessageBatch(session, [notification(1, { status: 'pending' })], source);
  vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
    enabled: false,
    toolUpdatesEnabled: false,
    maxRowBytes: 65536,
    recentIds: 200,
  });
  await stub.persistMessageBatch(
    session,
    [notification(2, { status: 'in_progress' }, 'fallback')],
    source
  );
  vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
    enabled: false,
    toolUpdatesEnabled: true,
    maxRowBytes: 65536,
    recentIds: 200,
  });
  await stub.persistMessageBatch(
    session,
    [notification(3, { status: 'completed' }, 'final')],
    source
  );
  const stored = await rows(stub, session);
  expect(stored).toHaveLength(3);
  expect(stored[0]?.toolMetadata).toMatchObject({ _samToolRevision: 1, status: 'pending' });
});

it('seals a failed session before a legacy snapshot and preserves its cached card on late output', async () => {
  const { stub, session } = await fixture();
  await stub.persistMessageBatch(
    session,
    [notification(1, { status: 'completed' }, 'first')],
    source
  );
  await stub.failSession(session);
  await stub.getToolChanges(session, undefined, true);
  await stub.persistMessageBatch(session, [notification(2, {}, 'late')], source);
  const stored = await rows(stub, session);
  expect(stored).toHaveLength(2);
  expect(stored[0]).toMatchObject({ content: 'first', toolMetadata: { _samToolRevision: 1 } });
});

it('does not alter an archive-owned failed session anchor while admitting a legacy reader', async () => {
  const { stub, session } = await fixture();
  await stub.persistMessageBatch(
    session,
    [notification(1, { status: 'completed' }, 'sealed')],
    source
  );
  await stub.failSession(session);
  await stub.archiveSourcePrepareIntent({
    projectId: 'tool-test',
    sessionId: session,
    migrationId: 'legacy-archive-fence',
    sourceOwnerName: 'tool-test',
    targetOwnerName: 'tool-test:archive:g1:s1',
    targetGeneration: 1,
    sourceIntentToken: 'legacy-fence-token',
    now: Date.now() + 60000,
    minTerminalAgeMs: 1,
  });
  let before: unknown;
  await runInDurableObject(stub, (_instance, state) => {
    before = state.storage.sql
      .exec('SELECT stream_ingest_state FROM chat_sessions WHERE id = ?', session)
      .toArray()[0]?.stream_ingest_state;
  });
  await stub.getToolChanges(session, undefined, true);
  await runInDurableObject(stub, (_instance, state) => {
    expect(
      state.storage.sql
        .exec('SELECT stream_ingest_state FROM chat_sessions WHERE id = ?', session)
        .toArray()[0]?.stream_ingest_state
    ).toBe(before);
  });
});
