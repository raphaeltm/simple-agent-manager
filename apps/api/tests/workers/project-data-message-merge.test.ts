import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { MessageStreamBatch } from '@simple-agent-manager/project-data/internal/do/message-stream-ingest';
import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import { markPromptAccepted } from '@simple-agent-manager/project-data/internal/do/session-state-prompt';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import reporterMessages from './fixtures/archive-reporter-messages.json';
import { projectDataStub } from './helpers/archive-fixtures';
import { profileObject, type WriteSample } from './helpers/archive-write-profile';

const source = { workspaceId: 'merge-workspace', callbackGeneration: 'generation-a' };
const fixtureEnd = Date.parse(reporterMessages.at(-1)!.timestamp);
const fixtureNow = Date.now();
const batch = reporterMessages.map((row) => ({
  ...row,
  timestamp: new Date(fixtureNow - fixtureEnd + Date.parse(row.timestamp)).toISOString(),
  toolMetadata: row.toolMetadata ?? null,
}));
function stubFor() {
  return projectDataStub(`message-merge-${crypto.randomUUID()}`);
}
afterEach(() => vi.restoreAllMocks());

async function fixture(enabled: boolean) {
  vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
    enabled,
    maxRowBytes: 65536,
    recentIds: 200,
  });
  const stub = stubFor();
  await stub.ensureProjectId('merge-test');
  const session = await stub.createSession(source.workspaceId, 'Merge test');
  return { stub, session };
}
async function rows(stub: DurableObjectStub<ProjectData>, session: string) {
  return (await stub.getMessages(session, 10000, null, null, undefined, false, 'asc')).messages;
}

describe('canonical streamed chunks through real ProjectData persistence', () => {
  it('pins canonical raw-search granularity before indexing and identical results after indexing', async () => {
    const rawCounts: number[] = [];
    const indexed: unknown[] = [];
    const now = Date.now();
    const stream = [
      {
        ...batch[1]!,
        messageId: 'raw-search-first',
        sequence: 1,
        content: 'needle start; ',
        timestamp: new Date(now).toISOString(),
      },
      {
        ...batch[2]!,
        messageId: 'raw-search-second',
        sequence: 2,
        content: 'needle end.',
        timestamp: new Date(now + 1).toISOString(),
      },
    ];
    for (const enabled of [false, true]) {
      const { stub, session } = await fixture(enabled);
      await stub.persistMessageBatch(session, stream, source);
      const beforeIndex = await stub.searchMessagesWithCoverage('needle', session);
      rawCounts.push(beforeIndex.results.length);
      expect(beforeIndex.coverage.keywordFallbackRan).toBe(true);
      await stub.materializeSession(session);
      const afterIndex = await stub.searchMessagesWithCoverage('needle', session);
      indexed.push(afterIndex.results.map(({ id, role, snippet }) => ({ id, role, snippet })));
    }
    // Canonical raw-row storage uses one result/snippet per canonical run;
    // once materialized, the existing grouped FTS contract remains identical.
    expect(rawCounts).toEqual([2, 1]);
    expect(indexed[1]).toEqual(indexed[0]);
  });

  it('discriminates a missing frontier: real persistence duplicates an old absorbed chunk', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessageBatch(session, batch.slice(0, 600), source);
    // Evict this old ID from the recent ring using a later acknowledged batch.
    await stub.persistMessageBatch(session, batch.slice(600, 900), source);
    const before = await rows(stub, session);
    const original = MessageStreamBatch.prototype.isDuplicate;
    vi.spyOn(MessageStreamBatch.prototype, 'isDuplicate').mockImplementation(function (
      this: MessageStreamBatch,
      id
    ) {
      return original.call(this, id, undefined);
    });
    // Negative control: disabling only the historical frontier makes the same
    // zero-persisted/content-identical assertions in the real replay test fail.
    expect((await stub.persistMessageBatch(session, [batch[2]!], source)).persisted).toBe(1);
    expect(await rows(stub, session)).not.toEqual(before);
  });

  it('discriminates missing duplicate receipt refresh across a credential rotation', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessageBatch(session, batch.slice(1, 18), source);
    const original = MessageStreamBatch.prototype.consume;
    vi.spyOn(MessageStreamBatch.prototype, 'consume').mockImplementation(function (
      this: MessageStreamBatch,
      id,
      sequence
    ) {
      if (sequence !== undefined && sequence <= this.state.through) return;
      original.call(this, id, sequence);
    });
    for (let i = 20; i < 600; i += 20)
      await stub.persistMessageBatch(session, [batch[2]!, ...batch.slice(i, i + 20)], source);
    const before = await rows(stub, session);
    expect(
      (
        await stub.persistMessageBatch(session, [batch[2]!], {
          ...source,
          callbackGeneration: 'generation-b',
        })
      ).persisted
    ).toBe(1);
    expect(await rows(stub, session)).not.toEqual(before);
  });

  it('fences a source from a different workspace before it changes the transcript', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessageBatch(session, batch.slice(1, 5), source);
    const before = await rows(stub, session);
    const rejected = await stub.fetch(
      new Request('https://test/__capture-expected-error', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'persistMessageBatch',
          args: [session, batch.slice(5, 8), { ...source, workspaceId: 'different-workspace' }],
        }),
      })
    );
    expect(await rejected.json()).toMatchObject({
      threw: true,
      message: expect.stringContaining('expected workspace_id'),
    });
    expect(await rows(stub, session)).toEqual(before);
  });

  it('pages a merged session beyond every standard transcript/materializer page size', async () => {
    const { stub, session } = await fixture(true);
    const start = Date.now();
    const large = Array.from({ length: 3 }, (_, copy) =>
      batch.map((row, index) => ({
        ...row,
        content: row.role === 'user' ? `${copy}: ${row.content}` : row.content,
        messageId: `long-${copy}-${row.messageId}`,
        sequence: copy * batch.length + index + 1,
        timestamp: new Date(start + copy * batch.length + index).toISOString(),
      }))
    ).flat();
    for (let offset = 0; offset < large.length; offset += 50)
      await stub.persistMessageBatch(session, large.slice(offset, offset + 50), source);
    const all: Record<string, unknown>[] = [];
    let cursor: { id: string; createdAt: number; sequence: number } | null = null;
    let pages = 0;
    while (true) {
      const page = await stub.getMessages(session, 500, null, cursor, undefined, false, 'asc');
      all.push(...page.messages);
      pages++;
      if (!page.hasMore) break;
      const last = page.messages.at(-1)!;
      const next = {
        id: String(last.id),
        createdAt: Number(last.createdAt),
        sequence: Number(last.sequence),
      };
      expect(next).not.toEqual(cursor);
      cursor = next;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(3);
    expect(all).toHaveLength(1260);
    expect(new Set(all.map((row) => row.id)).size).toBe(all.length);
    expect(all.map((row) => row.content).join('')).toBe(large.map((row) => row.content).join(''));
    await stub.materializeSession(session);
    const grouped = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec('SELECT count(*) AS n FROM chat_messages_grouped WHERE session_id = ?', session)
          .toArray()[0]?.n
    );
    expect(grouped).toBe(945);
  }, 120_000);

  it('mixes old individual chunks and an already merged sender payload in one session', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessageBatch(session, batch.slice(1, 5), source);
    const combined = {
      ...batch[5]!,
      content: batch
        .slice(5, 10)
        .map((row) => row.content)
        .join(''),
    };
    await stub.persistMessageBatch(session, [combined, batch[10]!], source);
    expect((await rows(stub, session)).map((row) => row.content).join('')).toBe(
      batch
        .slice(1, 11)
        .map((row) => row.content)
        .join('')
    );
    const before = await rows(stub, session);
    expect((await stub.persistMessageBatch(session, [combined], source)).persisted).toBe(0);
    expect(await rows(stub, session)).toEqual(before);
  });

  it('keeps absorbed-ID retries safe through ON to OFF to ON and seals OFF-era rows', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessageBatch(session, batch.slice(1, 8), source);
    vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
      enabled: false,
      maxRowBytes: 65536,
      recentIds: 200,
    });
    for (let index = 1; index < 8; index += 2)
      expect(
        (
          await stub.persistMessageBatch(
            session,
            batch.slice(index, Math.min(index + 2, 8)),
            source
          )
        ).persisted
      ).toBe(0);
    await stub.persistMessageBatch(session, batch.slice(8, 11), source);
    const off = await rows(stub, session);
    expect(off).toHaveLength(4);
    vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
      enabled: true,
      maxRowBytes: 65536,
      recentIds: 200,
    });
    await stub.persistMessageBatch(session, batch.slice(11, 15), source);
    expect((await rows(stub, session)).slice(0, 4)).toEqual(off);
    expect(await rows(stub, session)).toHaveLength(5);
  });

  it('ends runs at accepted prompt epochs, origin changes and sequence gaps', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessageBatch(session, batch.slice(1, 5), source);
    await runInDurableObject(stub, (_instance, state) => {
      expect(markPromptAccepted(state.storage.sql, session, 1)).toBe(true);
    });
    await stub.persistMessageBatch(session, batch.slice(5, 8), source);
    await stub.persistMessageBatch(
      session,
      batch.slice(8, 10).map((row) => ({ ...row, origin: 'system' })),
      source
    );
    await stub.persistMessageBatch(
      session,
      batch.slice(12, 14).map((row) => ({ ...row, origin: 'system' })),
      source
    );
    expect(await rows(stub, session)).toHaveLength(4);
  });

  it('retains individual rows when a complete retry receipt would exceed the configured cap', async () => {
    const { stub, session } = await fixture(true);
    vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
      enabled: true,
      maxRowBytes: 1024,
      recentIds: 200,
    });
    const largeIds = batch
      .slice(1, 4)
      .map((row, index) => ({ ...row, messageId: `${'r'.repeat(400)}${index}`, content: 'a' }));
    await stub.persistMessageBatch(session, largeIds, source);
    expect(await rows(stub, session)).toHaveLength(3);
    expect((await stub.persistMessageBatch(session, largeIds, source)).persisted).toBe(0);
  });

  it('enforces the logical session cap even when accepted chunks share a physical row', async () => {
    const { stub, session } = await fixture(true);
    await runInDurableObject(stub, (instance) => {
      const holder = instance as unknown as { env: { MAX_MESSAGES_PER_SESSION: string } };
      holder.env = { ...holder.env, MAX_MESSAGES_PER_SESSION: '3' };
    });
    expect(await stub.persistMessageBatch(session, batch.slice(1, 5), source)).toMatchObject({
      persisted: 3,
      limitReached: true,
      remainingCapacity: 0,
    });
    expect(await rows(stub, session)).toHaveLength(1);
    expect((await stub.getSession(session))?.messageCount).toBe(3);
    const rejected = await stub.fetch(
      new Request('https://test/__capture-expected-error', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'persistMessageBatch',
          args: [session, [batch[5]!], source],
        }),
      })
    );
    expect(await rejected.json()).toMatchObject({
      threw: true,
      message: expect.stringContaining('Session message limit'),
    });
    expect((await rows(stub, session))[0]?.content).toBe(
      batch
        .slice(1, 4)
        .map((row) => row.content)
        .join('')
    );
  });

  it('keeps existing later-chunk comment IDs and a new canonical anchor valid while appending', async () => {
    const { stub, session } = await fixture(false);
    const actor = { kind: 'human' as const, id: 'comment-owner', name: 'Comment owner' };
    await stub.persistMessageBatch(session, batch.slice(1, 5), source);
    const historical = await stub.createCommentThread({
      sessionId: session,
      messageId: batch[3]!.messageId,
      body: 'Historical anchor',
      actor,
    });
    vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
      enabled: true,
      maxRowBytes: 65536,
      recentIds: 200,
    });
    await stub.persistMessageBatch(session, [batch[5]!], source);
    const canonical = await stub.createCommentThread({
      sessionId: session,
      messageId: batch[5]!.messageId,
      quote: batch[5]!.content,
      body: 'Canonical prefix anchor',
      actor,
    });
    await stub.persistMessageBatch(session, batch.slice(6, 10), source);
    expect(
      await stub.getCommentThread({ sessionId: session, threadId: historical.thread.id })
    ).toEqual(historical.thread);
    expect(
      await stub.getCommentThread({ sessionId: session, threadId: canonical.thread.id })
    ).toEqual(canonical.thread);
    expect((await rows(stub, session)).find((row) => row.id === batch[5]!.messageId)?.content).toBe(
      batch
        .slice(5, 10)
        .map((row) => row.content)
        .join('')
    );
  });

  it('keeps a fenced block intact across the approved late-row boundary shift for a later row inside an already merged time span', async () => {
    const outputs: unknown[] = [];
    const instant = Date.now();
    const stream = [
      {
        ...batch[1]!,
        messageId: 'ordering-first',
        content: '```typescript\nconst value = ',
        sequence: 1,
        timestamp: new Date(instant).toISOString(),
      },
      {
        ...batch[2]!,
        messageId: 'ordering-second',
        content: '42;\n```',
        sequence: 2,
        timestamp: new Date(instant + 200).toISOString(),
      },
      {
        ...batch[18]!,
        messageId: 'ordering-tool',
        content: 'tool boundary',
        sequence: 3,
        timestamp: new Date(instant + 100).toISOString(),
      },
    ];
    for (const enabled of [false, true]) {
      const { stub, session } = await fixture(enabled);
      await stub.persistMessageBatch(session, stream.slice(0, 2), source);
      await stub.persistMessageBatch(session, stream.slice(2), source);
      await stub.materializeSession(session);
      outputs.push(
        await runInDurableObject(stub, (_instance, state) =>
          state.storage.sql
            .exec(
              'SELECT role, content FROM chat_messages_grouped WHERE session_id = ? ORDER BY created_at, id',
              session
            )
            .toArray()
        )
      );
    }
    expect(outputs[0]).toEqual([
      { role: 'assistant', content: '```typescript\nconst value = ' },
      { role: 'tool', content: 'tool boundary' },
      { role: 'assistant', content: '42;\n```' },
    ]);
    expect(outputs[1]).toEqual([
      { role: 'assistant', content: '```typescript\nconst value = 42;\n```' },
      { role: 'tool', content: 'tool boundary' },
    ]);
  });

  it('seals on an intervening browser write even when that row sorts before the open row', async () => {
    const { stub, session } = await fixture(true);
    const now = Date.now();
    await stub.persistMessageBatch(
      session,
      [{ ...batch[1]!, sequence: 1, timestamp: new Date(now + 1000).toISOString() }],
      source
    );
    await stub.persistMessage(session, 'user', 'intervening browser input', null);
    await stub.persistMessageBatch(
      session,
      [{ ...batch[2]!, sequence: 2, timestamp: new Date(now + 2000).toISOString() }],
      source
    );
    expect((await rows(stub, session)).filter((row) => row.role === 'assistant')).toHaveLength(2);
  });

  it('does not start an open row behind an already stored interleaving browser message', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessage(session, 'user', 'existing browser input', null);
    const user = (await rows(stub, session))[0]!;
    await stub.persistMessageBatch(
      session,
      [
        {
          ...batch[1]!,
          sequence: 1,
          timestamp: new Date(Number(user.createdAt) - 100).toISOString(),
        },
        {
          ...batch[2]!,
          sequence: 2,
          timestamp: new Date(Number(user.createdAt) + 100).toISOString(),
        },
      ],
      source
    );
    expect((await rows(stub, session)).map((row) => row.role)).toEqual([
      'assistant',
      'user',
      'assistant',
    ]);
  });
  it('seals for a legacy browser even when it disconnects before the next batch', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessageBatch(session, batch.slice(1, 5), source);
    const response = await stub.fetch(
      new Request(`https://test/ws?sessionId=${session}`, {
        headers: { Upgrade: 'websocket' },
      })
    );
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    await stub.persistMessageBatch(session, batch.slice(5, 8), source);
    expect(await rows(stub, session)).toHaveLength(4);
    response.webSocket!.close();
    await stub.persistMessageBatch(session, batch.slice(8, 12), source);
    const stored = await rows(stub, session);
    // Never append to any of the IDs the old client saw as individual rows.
    expect(stored.slice(0, 4).map((row) => row.content)).toEqual([
      batch
        .slice(1, 5)
        .map((row) => row.content)
        .join(''),
      ...batch.slice(5, 8).map((row) => row.content),
    ]);
  });

  it('preserves the historical retry frontier across unsequenced legacy writes', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessageBatch(session, batch.slice(0, 600), source);
    await stub.persistMessageBatch(session, [
      { ...batch[601]!, messageId: 'legacy', sequence: undefined },
    ]);
    const before = JSON.stringify(await rows(stub, session));
    expect((await stub.persistMessageBatch(session, [batch[2]!], source)).persisted).toBe(0);
    expect(JSON.stringify(await rows(stub, session))).toBe(before);
  });

  it('never extends an indexed row, and materializes its continuation without loss', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessageBatch(session, batch.slice(1, 5), source);
    const first = await rows(stub, session);
    await stub.materializeSession(session);
    await stub.persistMessageBatch(session, batch.slice(5, 10), source);
    expect(await rows(stub, session)).toHaveLength(2);
    expect((await rows(stub, session))[0]).toEqual(first[0]);
    await stub.materializeSession(session);
    const grouped = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec('SELECT content FROM chat_messages_grouped WHERE session_id = ?', session)
        .toArray()
    );
    expect(grouped.map((row) => row.content).join('')).toBe(
      batch
        .slice(1, 10)
        .map((row) => row.content)
        .join('')
    );
  });

  it('honors the exact serialized cap and ends runs at tool metadata and sequence gaps', async () => {
    const { stub, session } = await fixture(true);
    const initial = { ...batch[1]!, content: 'x'.repeat(1024) };
    await stub.persistMessageBatch(session, [initial], source);
    const bytes = await runInDurableObject(
      stub,
      (_instance, state) =>
        JSON.parse(
          String(
            state.storage.sql
              .exec('SELECT stream_ingest_state FROM chat_sessions WHERE id = ?', session)
              .toArray()[0]!.stream_ingest_state
          )
        ).open.bytes as number
    );
    vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
      enabled: true,
      recentIds: 200,
      maxRowBytes: bytes + 4,
    });
    await stub.persistMessageBatch(session, [{ ...batch[2]!, content: '🙂' }], source);
    expect(await rows(stub, session)).toHaveLength(1);
    await stub.persistMessageBatch(session, [{ ...batch[3]!, content: 'x' }], source);
    expect(await rows(stub, session)).toHaveLength(2);
    await stub.persistMessageBatch(
      session,
      [{ ...batch[4]!, toolMetadata: '{"type":"tool_call"}' }, batch[6]!],
      source
    );
    expect(await rows(stub, session)).toHaveLength(4);
  });

  it('measures billed writes through real workerd and guards the reporter-fixture savings', async () => {
    const totals: number[] = [];
    for (const enabled of [false, true]) {
      const { stub, session } = await fixture(enabled);
      const samples: WriteSample[] = [];
      const collect = await profileObject(stub, 'ingest', samples);
      for (let offset = 0; offset < batch.length; offset += 50)
        await stub.persistMessageBatch(session, batch.slice(offset, offset + 50), source);
      collect();
      totals.push(
        samples
          .filter((sample) => sample.owner === 'ingest' && sample.phase === 'persistMessageBatch')
          .reduce((sum, sample) => sum + sample.rowsWritten, 0)
      );
    }
    console.info('message-merge fixture billed writes', {
      before: totals[0],
      after: totals[1],
      chunks: batch.length,
    });
    expect(totals[1]).toBeLessThan(totals[0]! * 0.6);
    expect(totals).toMatchSnapshot();
  });

  it('preserves grouped output and indexed search across the complete reporter stream', async () => {
    const outputs: unknown[] = [];
    for (const enabled of [false, true]) {
      const { stub, session } = await fixture(enabled);
      for (let offset = 0; offset < batch.length; offset += 50)
        await stub.persistMessageBatch(session, batch.slice(offset, offset + 50), source);
      await stub.materializeSession(session);
      const grouped = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT id, role, content, created_at FROM chat_messages_grouped
          WHERE session_id = ? ORDER BY created_at, id`,
            session
          )
          .toArray()
      );
      expect(grouped).toHaveLength(315);
      const search = await stub.searchMessagesWithCoverage('chunk', session);
      expect(search.results.length).toBeGreaterThan(0);
      outputs.push({
        grouped,
        search: search.results.map((result) => ({
          id: result.id,
          role: result.role,
          snippet: result.snippet,
        })),
      });
    }
    expect(outputs[1]).toEqual(outputs[0]);
  });
  it('coalesces the real reporter fixture across batches without changing the transcript or logical cap count', async () => {
    const { stub, session } = await fixture(true);
    for (let offset = 0; offset < batch.length; offset += 50)
      await stub.persistMessageBatch(session, batch.slice(offset, offset + 50), source);
    const stored = await rows(stub, session);
    expect(stored).toHaveLength(420);
    expect(stored.map((row) => row.content).join('')).toBe(
      batch.map((row) => row.content).join('')
    );
    expect((await stub.getSession(session))?.messageCount).toBe(2100);
    expect(stored.filter((row) => row.role === 'tool')).toHaveLength(210);
    const before = JSON.stringify(stored);
    // All historical chunks, not merely the last recent-ID window, with new boundaries.
    for (let offset = 0; offset < batch.length; offset += 37) {
      const replay = await stub.persistMessageBatch(
        session,
        batch.slice(offset, offset + 37),
        source
      );
      expect(replay.persisted).toBe(0);
    }
    expect(JSON.stringify(await rows(stub, session))).toBe(before);
  });

  it('keeps switch-off behavior, then never absorbs already exposed legacy rows', async () => {
    const { stub, session } = await fixture(false);
    await stub.persistMessageBatch(session, batch.slice(1, 5), source);
    expect(await rows(stub, session)).toHaveLength(4);
    vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
      enabled: true,
      maxRowBytes: 65536,
      recentIds: 200,
    });
    await stub.persistMessageBatch(session, batch.slice(5, 10), source);
    expect(await rows(stub, session)).toHaveLength(5);
  });

  it('bridges a lost response across callback credential rotation without depending on chunk boundaries', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessageBatch(session, batch.slice(1, 18), source);
    const before = JSON.stringify(await rows(stub, session));
    const rotated = { ...source, callbackGeneration: 'generation-b' };
    for (let i = 1; i < 18; i += 3)
      expect(
        (await stub.persistMessageBatch(session, batch.slice(i, Math.min(18, i + 3)), rotated))
          .persisted
      ).toBe(0);
    expect(JSON.stringify(await rows(stub, session))).toBe(before);
  });

  it('refreshes receipts for an old outbox row whose local DELETE repeatedly fails', async () => {
    const { stub, session } = await fixture(true);
    await stub.persistMessageBatch(session, batch.slice(1, 18), source);
    for (let i = 20; i < 600; i += 20)
      await stub.persistMessageBatch(session, [batch[2]!, ...batch.slice(i, i + 20)], source);
    const before = JSON.stringify(await rows(stub, session));
    expect(
      (
        await stub.persistMessageBatch(session, [batch[2]!], {
          ...source,
          callbackGeneration: 'generation-b',
        })
      ).persisted
    ).toBe(0);
    expect(JSON.stringify(await rows(stub, session))).toBe(before);
  });

  it('preserves old raw rows and archive write-generation invariants on additive migration', async () => {
    const { stub, session } = await fixture(false);
    await stub.persistMessageBatch(session, batch.slice(0, 20), source);
    const before = await rows(stub, session);
    expect(before).toHaveLength(20);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec('PRAGMA table_info(chat_sessions)')
          .toArray()
          .some((column) => column.name === 'stream_ingest_state')
      ).toBe(true);
    });
    expect(await rows(stub, session)).toEqual(before);
  });
});
