import { measureArchiveSql } from '@simple-agent-manager/project-data/internal/archive/sql-metrics';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';

it('reports consumed RETURNING writes at statement boundaries and on failure', async () => {
  const stub = projectDataStub(`sql-metrics-${crypto.randomUUID()}`);
  await stub.ensureProjectId('sql-metrics');
  const records: Array<{ event: string; phase: string; rowsWritten: number }> = [];
  const output = vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
    if (typeof value === 'string') records.push(JSON.parse(value));
  });
  try {
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      await measureArchiveSql(sql, 'metric-session', 'lazy-success', async (measured) => {
        for (const key of ['metric-first', 'metric-last'])
          measured
            .exec('INSERT INTO do_meta(key,value) VALUES (?,?) RETURNING key', key, '1')
            .toArray();
      });
      await expect(
        measureArchiveSql(sql, 'metric-session', 'lazy-failure', async (measured) => {
          measured
            .exec("INSERT INTO do_meta(key,value) VALUES('metric-failed','1') RETURNING key")
            .toArray();
          throw new Error('injected failure after consumed write');
        })
      ).rejects.toThrow('injected failure after consumed write');
    });
  } finally {
    output.mockRestore();
  }
  const metrics = records.filter(
    (record) => record.event === 'project_data.archive_sql.project_data_archive_sql_usage'
  );
  expect(metrics.map(({ phase, rowsWritten }) => ({ phase, rowsWritten }))).toEqual([
    { phase: 'lazy-success', rowsWritten: 4 },
    { phase: 'lazy-failure', rowsWritten: 2 },
  ]);
});
