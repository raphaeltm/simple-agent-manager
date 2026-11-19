import { describe, expect, it, vi } from 'vitest';
import { readStorageEvidence } from '../deploy/reliability-storage-evidence.mjs';

const workspaceId = '01M54X8H4YHWWGBQGTW2Q4S5V3';
const rateIdentity = '01M54XTQYM87Z6AE4P8SCPA07X';
function fixture(change?: (result: any) => void) {
  const calls: { path: string; body?: any }[] = [];
  const api = async (path: string, body?: any) => {
    calls.push({ path, body });
    if (!body)
      return ['WorkspaceBootLog', 'McpRateCounter'].map((name, i) => ({
        id: String(i).repeat(32),
        script: 'sam-api-staging',
        class: name,
        use_sqlite: true,
      }));
    const result = {
      results:
        body.queries.length === 2
          ? [
              {
                columns: ['count', 'oldest', 'newest'],
                rows: [[18, '2026-10-17T13:01:33Z', '2026-10-17T13:01:47Z']],
                meta: { rows_written: 0 },
              },
              {
                columns: ['expires_at', 'allow_legacy'],
                rows: [[1792243907000, 0]],
                meta: { rows_written: 0 },
              },
            ]
          : [
              {
                columns: ['window_start', 'reset_at', 'count'],
                rows: [[1792242000, 1792242060, 2]],
                meta: { rows_written: 0 },
              },
            ],
    };
    change?.(result);
    return result;
  };
  return {
    calls,
    run: () => readStorageEvidence({ api, worker: 'sam-api-staging', workspaceId, rateIdentity }),
  };
}
describe('deployment-owned fixed storage evidence', () => {
  it('reads only fixed SELECT aggregates for the exact fixture and emits no payloads', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toMatchObject({
      logCount: 18,
      queryRowsWritten: 0,
      logState: [{ allowLegacy: 0 }],
      counters: [{ count: 2 }],
    });
    expect(
      f.calls
        .slice(1)
        .every((c) =>
          c.body.queries.every(
            (q: any) => q.sql.startsWith('SELECT ') && !q.sql.includes('SELECT payload')
          )
        )
    ).toBe(true);
    expect(f.calls.slice(1).map((c) => c.body.durable_object_name)).toEqual([
      workspaceId,
      rateIdentity,
    ]);
    expect(JSON.stringify(result)).not.toContain('payload');
  });
  it.each(['writes', 'columns', 'error', 'sensitiveTimestamp'])(
    'rejects unsafe %s results',
    async (kind) => {
      const f = fixture((r) => {
        if (kind === 'writes') r.results[0].meta.rows_written = 1;
        if (kind === 'columns') r.results[0].columns[0] = 'payload';
        if (kind === 'error') r.error = 'secret-canary-provider-error';
        if (kind === 'sensitiveTimestamp')
          r.results[0].rows[0][1] = '2026-10-17T13:01:33Z (secret-canary)';
      });
      await expect(f.run()).rejects.not.toThrow('secret-canary');
      await expect(f.run()).rejects.toThrow();
    }
  );
  it.each([undefined, 'not-an-id'])(
    'rejects missing or malformed paired IDs before API access',
    async (rateIdentity) => {
      const api = vi.fn();
      await expect(
        readStorageEvidence({ api, worker: 'sam-api-staging', workspaceId, rateIdentity })
      ).rejects.toThrow('Exact release fixture IDs required');
      expect(api).not.toHaveBeenCalled();
    }
  );
  it('rejects ambiguous namespaces without querying an object', async () => {
    const api = vi.fn(async () =>
      Array.from({ length: 2 }, () => ({
        id: '0'.repeat(32),
        script: 'sam-api-staging',
        class: 'WorkspaceBootLog',
        use_sqlite: true,
      }))
    );
    await expect(
      readStorageEvidence({ api, worker: 'sam-api-staging', workspaceId, rateIdentity })
    ).rejects.toThrow('Expected one compatible');
    expect(api).toHaveBeenCalledTimes(1);
  });
  it('fails closed when namespace enumeration exceeds its release bound', async () => {
    const api = vi.fn(async () => Array.from({ length: 1000 }, () => ({})));
    await expect(
      readStorageEvidence({ api, worker: 'sam-api-staging', workspaceId, rateIdentity })
    ).rejects.toThrow('exceeds bounded');
    expect(api).toHaveBeenCalledTimes(10);
  });
});
