import { describe, expect, it, vi } from 'vitest';

import {
  completeUtcDay,
  parseRowUsage,
  reportProjectDataRows,
  rowUsageQuery,
} from './check-project-data-rows';

const response = (rank: number, label: string, writes: number) => ({
  success: true,
  result: {
    calculations: ['calls', 'rowsRead', 'rowsWritten', 'alarmWrites'].map((metric) => ({
      alias: metric,
      aggregates: [
        {
          value: metric === 'rowsWritten' ? writes : 0,
          groups: [{ key: `labels.rank${rank}.label`, value: label }],
        },
      ],
    })),
  },
});
describe('ProjectData optional row writer report', () => {
  it('uses the last complete UTC day even at month boundaries and groups logged sums by label', () => {
    const timeframe = completeUtcDay(new Date('2026-11-01T12:34:56Z'));
    expect(new Date(timeframe.from).toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(new Date(timeframe.to).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(rowUsageQuery(2, timeframe, 'api-worker', 'project')).toMatchObject({
      timeframe,
      view: 'calculations',
      parameters: {
        calculations: expect.arrayContaining([
          {
            operator: 'sum',
            key: 'labels.rank2.rowsWritten',
            alias: 'rowsWritten',
            keyType: 'number',
          },
        ]),
        groupBys: [{ type: 'string', value: 'labels.rank2.label' }],
        filters: expect.arrayContaining([
          { key: 'projectId', operation: 'eq', type: 'string', value: 'project' },
        ]),
      },
    });
    expect(parseRowUsage(response(2, 'persistMessageBatch', 19), 2)).toEqual([
      { label: 'persistMessageBatch', calls: 0, rowsRead: 0, rowsWritten: 19, alarmWrites: 0 },
    ]);
  });
  it('merges the same label across ranks and ranks the final total by writes', async () => {
    const fetcher = vi.fn(async (_url, options) => {
      const rank = Number(JSON.parse(String(options?.body)).queryId.split('-').at(-1));
      return new Response(
        JSON.stringify(rank < 2 ? response(rank, 'batch', 19) : response(rank, 'heartbeat', 1))
      );
    }) as unknown as typeof fetch;
    const report = await reportProjectDataRows({
      token: 'test',
      accountId: 'account',
      service: 'worker',
      fetcher,
    });
    expect(report).toContain('batch | 38');
    expect(report).toContain('heartbeat | 31');
    expect(report.indexOf('batch |')).toBeLessThan(report.indexOf('heartbeat |'));
    expect(report).not.toContain('not available');
  });
  it('rejects partial calculations, missing per-label metrics, and later failed ranks', async () => {
    const partial = response(0, 'batch', 19);
    partial.result.calculations.pop();
    expect(() => parseRowUsage(partial, 0)).toThrow('Incomplete');
    const missing = response(0, 'batch', 19);
    missing.result.calculations[0]!.aggregates = [];
    expect(() => parseRowUsage(missing, 0)).toThrow('Incomplete');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response(0, 'batch', 19))))
      .mockResolvedValueOnce(new Response('', { status: 500 })) as unknown as typeof fetch;
    const report = await reportProjectDataRows({
      token: 'test',
      accountId: 'account',
      service: 'worker',
      fetcher,
    });
    expect(report).toContain('not available');
    expect(report).not.toContain('batch |');
  });
  it.each(['http', 'malformed', 'empty', 'throw'])(
    'reports unavailable instead of zero for %s telemetry',
    async (mode) => {
      const fetcher = vi.fn(async () => {
        if (mode === 'throw') throw new Error('network');
        if (mode === 'http') return new Response('', { status: 403 });
        return new Response(
          JSON.stringify(
            mode === 'empty' ? { success: true, result: { calculations: [] } } : { success: false }
          )
        );
      }) as unknown as typeof fetch;
      const report = await reportProjectDataRows({
        token: 'test',
        accountId: 'account',
        service: 'worker',
        fetcher,
      });
      expect(report).toContain('not available');
      expect(report).not.toContain('| 0');
    }
  );
});
