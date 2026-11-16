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
const emptyRankResponse = () => ({
  success: true,
  result: {
    calculations: ['calls', 'rowsRead', 'rowsWritten', 'alarmWrites'].map((alias) => ({
      alias,
      aggregates: [],
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
  it('requires every calculation once even when a rank has no aggregates', () => {
    const emptyRank = emptyRankResponse();
    expect(parseRowUsage(emptyRank, 1)).toEqual([]);
    const missing = structuredClone(emptyRank);
    missing.result.calculations = [];
    const duplicate = structuredClone(emptyRank);
    duplicate.result.calculations[1]!.alias = 'calls';
    const extra = structuredClone(emptyRank);
    extra.result.calculations.push(extra.result.calculations[0]!);
    expect(() => parseRowUsage(missing, 1)).toThrow();
    expect(() => parseRowUsage(duplicate, 1)).toThrow();
    expect(() => parseRowUsage(extra, 1)).toThrow();
  });
  it('reports unavailable when a missing calculation rank accompanies a valid rank', async () => {
    const emptyRank = emptyRankResponse();
    const missing = { success: true, result: { calculations: [] } };
    const fetcher = vi.fn(async (_url, options) => {
      const rank = Number(JSON.parse(String(options?.body)).queryId.split('-').at(-1));
      let payload: unknown = emptyRank;
      if (rank === 0) payload = response(0, 'batch', 19);
      else if (rank === 1) payload = missing;
      return new Response(JSON.stringify(payload));
    }) as unknown as typeof fetch;
    const report = await reportProjectDataRows({
      token: 'test',
      accountId: 'account',
      service: 'worker',
      fetcher,
    });
    expect(report).toContain('not available');
    expect(report).not.toContain('batch |');
  });
  it.each(['duplicate-alias', 'unknown-alias', 'duplicate-label', 'negative', 'infinite', 'limit'])(
    'rejects %s aggregates',
    (kind) => {
      const payload = response(0, 'batch', 19);
      const calculations = payload.result.calculations;
      if (kind === 'duplicate-alias') calculations[0]!.alias = 'rowsWritten';
      if (kind === 'unknown-alias') calculations[0]!.alias = 'unknown';
      if (kind === 'duplicate-label')
        calculations[0]!.aggregates.push(calculations[0]!.aggregates[0]!);
      if (kind === 'negative') calculations[0]!.aggregates[0]!.value = -1;
      if (kind === 'infinite') calculations[0]!.aggregates[0]!.value = Infinity;
      if (kind === 'limit')
        for (const calculation of calculations)
          calculation.aggregates = Array.from({ length: 1000 }, (_, n) => ({
            value: 1,
            groups: [{ key: 'labels.rank0.label', value: `unique-${n}` }],
          }));
      expect(() => parseRowUsage(payload, 0)).toThrow();
    }
  );
  it('fails before network access when required reporting configuration is missing', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const report = await reportProjectDataRows({
      token: '',
      accountId: 'account',
      service: 'worker',
      fetcher,
    });
    expect(report).toContain('not available');
    expect(fetcher).not.toHaveBeenCalled();
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
      if (mode === 'http') expect(report).toContain('HTTP 403');
    }
  );
});
