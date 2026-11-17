import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import { afterEach, expect, it, vi } from 'vitest';

import { profileObject, type WriteSample } from './helpers/archive-write-profile';
import { deliver, startup } from './helpers/merge-reporter-workspace';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['Claude', ['pending', 'completed', undefined]],
  ['Codex', ['in_progress', 'completed']],
  ['OpenCode', ['pending', 'in_progress', 'in_progress', 'completed']],
] as const)(
  '%s callback lifecycle stores a canonical final snapshot and cuts measured DO writes',
  async (_name, statuses) => {
    const rawWrites: number[] = [];
    const totalWrites: number[] = [];
    for (const enabled of [false, true]) {
      const f = await startup();
      vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
        enabled: false,
        toolUpdatesEnabled: enabled,
        maxRowBytes: 65536,
        recentIds: 200,
      });
      const samples: WriteSample[] = [];
      const collect = await profileObject(f.stub, 'callback-ingest', samples);
      const messages = statuses.map((status, index) => ({
        messageId: `${f.prefix}-tool-${index}`,
        sessionId: f.session,
        role: 'tool',
        sequence: index + 1,
        timestamp: f.now,
        content: index === statuses.length - 1 ? 'final result' : '(tool update)',
        toolMetadata: JSON.stringify({
          toolCallId: 'provider-call-id',
          ...(index === 0 ? { title: 'Run test', kind: 'execute' } : {}),
          ...(status ? { status } : {}),
          ...(index === statuses.length - 1
            ? { content: [{ type: 'terminal', output: 'final result' }] }
            : {}),
        }),
      }));
      for (const message of messages)
        expect(await deliver(f, [message])).toMatchObject({ persisted: 1 });
      collect();
      const stored = (
        await f.stub.getMessages(f.session, 1000, null, null, undefined, false, 'asc')
      ).messages;
      expect(stored).toHaveLength(enabled ? 1 : statuses.length);
      expect(stored.at(-1)?.content).toBe('final result');
      if (enabled)
        expect(stored[0]?.toolMetadata).toMatchObject({
          title: 'Run test',
          status: 'completed',
          _samToolRevision: statuses.length,
        });
      rawWrites.push(
        samples
          .filter((sample) =>
            /^INSERT INTO chat_messages \(|^UPDATE chat_messages SET/.test(sample.statement)
          )
          .reduce((sum, sample) => sum + sample.rowsWritten, 0)
      );
      totalWrites.push(
        samples
          .filter(
            (sample) => sample.owner === 'callback-ingest' && sample.phase === 'persistMessageBatch'
          )
          .reduce((sum, sample) => sum + sample.rowsWritten, 0)
      );
      expect(rawWrites.at(-1)).toBe(enabled ? statuses.length + 2 : 3 * statuses.length);
      samples.length = 0;
      expect(await deliver(f, messages)).toMatchObject({
        persisted: 0,
        duplicates: statuses.length,
      });
      collect();
      expect(
        samples
          .filter(
            (sample) => sample.owner === 'callback-ingest' && sample.phase === 'persistMessageBatch'
          )
          .reduce((sum, sample) => sum + sample.rowsWritten, 0)
      ).toBe(0);
      expect(
        (await f.stub.getMessages(f.session, 1000, null, null, undefined, false, 'asc')).messages
      ).toEqual(stored);
    }
    expect(rawWrites[0]! - rawWrites[1]!).toBe(2 * (statuses.length - 1));
    expect(totalWrites[1]).toBeLessThan(totalWrites[0]!);
    console.info(
      JSON.stringify({
        harness: _name,
        notifications: statuses.length,
        rawWritesOff: rawWrites[0],
        rawWritesOn: rawWrites[1],
        totalDOWritesOff: totalWrites[0],
        totalDOWritesOn: totalWrites[1],
      })
    );
  }
);
