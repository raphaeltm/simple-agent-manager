import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import type { MessageIngestMetrics } from '@simple-agent-manager/project-data/internal/do/message-ingest-metrics';
import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import type { RowUsage } from '@simple-agent-manager/project-data/internal/do/row-usage';
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = {
  workspaceId: 'metrics-workspace',
  callbackGeneration: null,
  outboxIncarnation: 'cbce9fe8-c5e5-464c-9900-4bec2bd30cb1',
};
const config = { enabled: true, maxRowBytes: 65536, recentIds: 200 };
function chunk(sequence: number, role = 'assistant') {
  return {
    messageId: `chunk-${sequence}`,
    sequence,
    role,
    toolMetadata: null,
    content: `part${sequence} `,
    timestamp: new Date(1700000000000 + sequence).toISOString(),
  };
}
function reports(spy: ReturnType<typeof vi.spyOn>): Array<{ messageIngest: MessageIngestMetrics }> {
  return spy.mock.calls.flatMap(([line]) => {
    try {
      const value = JSON.parse(String(line));
      return value.event === 'project_data.row_usage' ? [value] : [];
    } catch {
      return [];
    }
  });
}
async function setup(enabled = true) {
  vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
    ...config,
    enabled,
  });
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.newUniqueId()
  ) as DurableObjectStub<ProjectData>;
  await stub.ensureProjectId('metrics-project');
  const session = await stub.createSession(source.workspaceId, 'Metrics topic');
  return { stub, session };
}
async function flush(stub: DurableObjectStub<ProjectData>) {
  await runInDurableObject(stub, (instance) => {
    const usage = (instance as unknown as { rowUsage: RowUsage }).rowUsage;
    const start = (usage as unknown as { windowStart: number }).windowStart;
    usage.flush(start + usage.intervalMs);
  });
}
async function captureBatchError(stub: DurableObjectStub<ProjectData>, session: string) {
  const response = await stub.fetch(
    new Request('https://test/__capture-expected-error', {
      method: 'POST',
      body: JSON.stringify({
        operation: 'persistMessageBatch',
        args: [session, [chunk(1), chunk(2)], source],
      }),
    })
  );
  return response.json();
}
afterEach(() => vi.restoreAllMocks());

describe('content-free message ingestion counters through real workerd', () => {
  it('counts accepted roles, same-batch coalesces, cross-batch SQL appends and replay separately', async () => {
    const { stub, session } = await setup();
    const log = vi.spyOn(console, 'log');
    await stub.persistMessageBatch(session, [chunk(1), chunk(2)], source);
    await stub.persistMessageBatch(session, [chunk(3), chunk(4)], source);
    await stub.persistMessageBatch(session, [chunk(1), chunk(2), chunk(3)], source);
    await stub.persistMessageBatch(
      session,
      [chunk(5, 'thinking'), chunk(6, 'thinking'), chunk(7, 'tool')],
      source
    );
    await flush(stub);
    const metrics = reports(log).at(-1)!.messageIngest;
    expect(metrics).toMatchObject({
      batches: 4,
      received: { assistant: 7, thinking: 2, tool: 1 },
      accepted: { assistant: 4, thinking: 2, tool: 1 },
      inserted: { assistant: 1, thinking: 2, tool: 1 },
      eligible: 4,
      coalesced: 3,
      appendStatements: 1,
      duplicates: 3,
      mergeReadyBatches: 4,
      refused: {},
      breaks: { no_open: 1, role: 1 },
    });
    const rows = (await stub.getMessages(session, 50, null, null, undefined, false, 'asc'))
      .messages;
    expect(rows.map((row) => row.role)).toEqual(['assistant', 'thinking', 'thinking', 'tool']);
    expect(rows[0]!.content).toBe('part1 part2 part3 part4 ');
    log.mockClear();
    await stub.persistMessageBatch(session, [chunk(8, 'plan')], source);
    await flush(stub);
    expect(reports(log).at(-1)!.messageIngest).toMatchObject({
      batches: 1,
      received: { assistant: 0, plan: 1 },
      coalesced: 0,
      appendStatements: 0,
      duplicates: 0,
    });
  });

  it.each([false, true])(
    'observes actual scoped and unscoped legacy socket admission; only scoped refuses (sessionScoped=%s)',
    async (sessionScoped) => {
      const { stub, session } = await setup();
      const response = await stub.fetch(
        new Request(`https://test/ws${sessionScoped ? `?sessionId=${session}` : ''}`, {
          headers: { Upgrade: 'websocket', 'x-sam-browser-socket-actor': 'test-user' },
        })
      );
      expect(response.status).toBe(101);
      response.webSocket!.accept();
      const log = vi.spyOn(console, 'log');
      await stub.persistMessageBatch(session, [chunk(1), chunk(2)], source);
      await stub.persistMessageBatch(session, [chunk(3)], source);
      await flush(stub);
      // A legacy session socket refuses merging for its session. A legacy project socket gets no
      // transcript frames, so it is counted for diagnostics but never refuses.
      expect(reports(log).at(-1)!.messageIngest).toMatchObject(
        sessionScoped
          ? {
              batches: 2,
              eligible: 3,
              coalesced: 0,
              inserted: { assistant: 3 },
              refused: { legacy_client: 2 },
              legacySessionSocketsMax: 1,
              legacyProjectSocketsMax: 0,
            }
          : {
              batches: 2,
              eligible: 3,
              coalesced: 2,
              appendStatements: 1,
              inserted: { assistant: 1 },
              refused: {},
              legacySessionSocketsMax: 0,
              legacyProjectSocketsMax: 1,
            }
      );
      if (!sessionScoped)
        expect(reports(log).at(-1)!.messageIngest.refused.legacy_client).toBeUndefined();
      expect((await stub.getMessages(session, 50)).messages).toHaveLength(sessionScoped ? 3 : 1);
      response.webSocket!.close();
    }
  );

  it.each(['capable reader', 'unrelated legacy reader'])(
    'merges with a %s connected',
    async (reader) => {
      const { stub, session } = await setup();
      const watched =
        reader === 'capable reader'
          ? session
          : await stub.createSession(source.workspaceId, 'Unrelated');
      const capability = reader === 'capable reader' ? '&messageAppend=message-append-v1' : '';
      const response = await stub.fetch(
        new Request(`https://test/ws?sessionId=${watched}${capability}`, {
          headers: { Upgrade: 'websocket', 'x-sam-browser-socket-actor': 'test-user' },
        })
      );
      expect(response.status).toBe(101);
      response.webSocket!.accept();
      const log = vi.spyOn(console, 'log');
      await stub.persistMessageBatch(session, [chunk(1), chunk(2)], source);
      await flush(stub);
      expect(reports(log).at(-1)!.messageIngest).toMatchObject({
        coalesced: 1,
        refused: {},
        legacySessionSocketsMax: 0,
        legacyProjectSocketsMax: 0,
      });
      response.webSocket!.close();
    }
  );

  it.each(['setting_disabled', 'missing_incarnation', 'invalid_sequence', 'receipt_cap'] as const)(
    'explains primary refusal %s',
    async (reason) => {
      const { stub, session } = await setup(reason !== 'setting_disabled');
      if (reason === 'receipt_cap')
        vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
          ...config,
          maxRowBytes: 1024,
        });
      const log = vi.spyOn(console, 'log');
      const input =
        reason === 'receipt_cap'
          ? Array.from({ length: 50 }, (_, index) => ({
              ...chunk(index + 1),
              messageId: crypto.randomUUID(),
            }))
          : [chunk(2), chunk(reason === 'invalid_sequence' ? 1 : 3)];
      await stub.persistMessageBatch(
        session,
        input,
        reason === 'missing_incarnation' ? { ...source, outboxIncarnation: undefined } : source
      );
      await flush(stub);
      expect(reports(log).at(-1)!.messageIngest).toMatchObject({
        batches: 1,
        inserted: { assistant: input.length },
        accepted: { assistant: input.length },
        coalesced: 0,
        refused: { [reason]: 1 },
      });
    }
  );

  it('does not publish outcomes when the actual persistence transaction rolls back', async () => {
    const { stub, session } = await setup();
    const log = vi.spyOn(console, 'log');
    await runInDurableObject(stub, (instance) => {
      const holder = instance as unknown as { sql: SqlStorage };
      const original = holder.sql;
      holder.sql = new Proxy(original, {
        get(target, key) {
          if (key === 'exec')
            return (query: string, ...bindings: unknown[]) => {
              if (query.startsWith('INSERT INTO chat_messages '))
                throw new Error('controlled insert failure');
              return target.exec(query, ...bindings);
            };
          return Reflect.get(target, key, target);
        },
      });
    });
    expect(await captureBatchError(stub, session)).toMatchObject({
      threw: true,
      message: 'controlled insert failure',
    });
    await flush(stub);
    expect(reports(log).at(-1)!.messageIngest).toMatchObject({
      batches: 0,
      accepted: { assistant: 0 },
      coalesced: 0,
    });
    expect((await stub.getMessages(session, 50)).messages).toHaveLength(0);
  });
  it('retains committed counters and rows when later broadcasting fails', async () => {
    const { stub, session } = await setup();
    const log = vi.spyOn(console, 'log');
    await runInDurableObject(stub, (instance) => {
      const holder = instance as unknown as {
        broadcastEvent: (
          type: string,
          payload: Record<string, unknown>,
          sessionId?: string
        ) => void;
      };
      const original = holder.broadcastEvent.bind(holder);
      holder.broadcastEvent = (type, payload, sessionId) => {
        if (type === 'messages.batch') throw new Error('controlled post-commit broadcast failure');
        original(type, payload, sessionId);
      };
    });
    expect(await captureBatchError(stub, session)).toMatchObject({
      threw: true,
      message: 'controlled post-commit broadcast failure',
    });
    await flush(stub);
    expect(reports(log).at(-1)!.messageIngest).toMatchObject({
      batches: 1,
      accepted: { assistant: 2 },
      inserted: { assistant: 1 },
      coalesced: 1,
    });
    const rows = (await stub.getMessages(session, 50)).messages;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('part1 part2 ');
  });

  it('explains source replacement and a delayed retired-source continuation', async () => {
    const { stub, session } = await setup();
    const log = vi.spyOn(console, 'log');
    await stub.persistMessageBatch(session, [chunk(1), chunk(2)], source);
    await stub.persistMessageBatch(
      session,
      [{ ...chunk(3), messageId: 'new-source', sequence: 1 }],
      { ...source, outboxIncarnation: 'b5c61e7f-ae8d-4e2e-b77b-3c849ed6036b' }
    );
    await stub.persistMessageBatch(session, [chunk(4)], source);
    await flush(stub);
    expect(reports(log).at(-1)!.messageIngest).toMatchObject({
      batches: 3,
      refused: { retired_source: 1 },
      breaks: { source: 2 },
    });
    expect((await stub.getMessages(session, 50)).messages).toHaveLength(3);
  });

  it('identifies oversized and older-position initial rows without changing their inserts', async () => {
    const { stub, session } = await setup();
    const log = vi.spyOn(console, 'log');
    await stub.persistMessageBatch(
      session,
      [{ ...chunk(1), content: 'x'.repeat(config.maxRowBytes) }],
      source
    );
    await stub.persistMessageBatch(
      session,
      [{ ...chunk(2), timestamp: new Date(1600000000000).toISOString() }],
      source
    );
    await flush(stub);
    expect(reports(log).at(-1)!.messageIngest).toMatchObject({
      accepted: { assistant: 2 },
      inserted: { assistant: 2 },
      coalesced: 0,
      breaks: { size_cap: 1, out_of_order: 1 },
    });
  });
});
