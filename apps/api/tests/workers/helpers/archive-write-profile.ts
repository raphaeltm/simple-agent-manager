import { AsyncLocalStorage } from 'node:async_hooks';

import type { RowUsage } from '@simple-agent-manager/project-data/internal/do/row-usage';
import { runInDurableObject } from 'cloudflare:test';

import type { ProjectDataTestDouble } from '../support/expected-error-doubles';

export type WriteSample = { owner: string; phase: string; statement: string; rowsWritten: number };
const phase = new AsyncLocalStorage<string>();
const normalize = (query: string) => query.replace(/\s+/g, ' ').trim();

/** Retain cursors until all consumers finish: RETURNING writes can be lazy. */
export async function profileObject(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  owner: string,
  samples: WriteSample[]
): Promise<() => void> {
  const pending: Array<{ cursor: { rowsWritten: number }; phase: string; statement: string }> = [];
  await runInDurableObject(stub, (instance) => {
    const holder = instance as unknown as {
      sql: SqlStorage;
      rowUsage: RowUsage;
      meteredStorage: DurableObjectStorage;
      env: { DATABASE: D1Database; KV: KVNamespace };
    };
    holder.env = { ...holder.env, DATABASE: profileD1(holder.env.DATABASE, samples) };
    const originalKv = holder.env.KV;
    holder.env.KV = new Proxy(originalKv, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'put' || key === 'delete')
          return async (...args: unknown[]) => {
            const result = await value.apply(target, args);
            samples.push({
              owner,
              phase: phase.getStore() ?? 'other',
              statement: `KV.${String(key)}`,
              rowsWritten: 1,
            });
            return result;
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const originalRun = holder.rowUsage.run.bind(holder.rowUsage);
    holder.rowUsage.run = (label, work, section) =>
      originalRun(label, () => phase.run(phase.getStore() ?? label, work), section);
    holder.meteredStorage = new Proxy(holder.meteredStorage, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (['setAlarm', 'deleteAlarm', 'put', 'delete'].includes(String(key)))
          return async (...args: unknown[]) => {
            const result = await value.apply(target, args);
            let count = 1;
            if (key === 'delete') count = Number(result);
            else if (key === 'put' && typeof args[0] === 'object' && args[0] !== null)
              count = Object.keys(args[0]).length;
            samples.push({
              owner,
              phase: phase.getStore() ?? 'other',
              statement: `storage.${String(key)}`,
              rowsWritten: count,
            });
            return result;
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const original = holder.sql;
    holder.sql = new Proxy(original, {
      get(target, key) {
        if (key === 'exec')
          return (query: string, ...bindings: unknown[]) => {
            const cursor = target.exec(query, ...bindings);
            pending.push({
              cursor,
              phase: phase.getStore() ?? 'other',
              statement: normalize(query),
            });
            return cursor;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  return () => {
    for (const item of pending)
      samples.push({
        owner,
        phase: item.phase,
        statement: item.statement,
        rowsWritten: item.cursor.rowsWritten,
      });
    pending.length = 0;
  };
}

/** D1 reports real billed-style counters in result.meta, including indexes/triggers. */
export function profileD1(db: D1Database, samples: WriteSample[]): D1Database {
  const statements = new WeakMap<object, { raw: D1PreparedStatement; query: string }>();
  const record = (query: string, result: D1Result) => {
    samples.push({
      owner: 'D1',
      phase: 'coordinator',
      statement: normalize(query),
      rowsWritten: result.meta.rows_written,
    });
    return result;
  };
  const wrap = (raw: D1PreparedStatement, query: string): D1PreparedStatement => {
    const proxy = new Proxy(raw, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), query);
        if (key === 'run' || key === 'all') return async () => record(query, await target[key]());
        if (key === 'first')
          return async (column?: string) => {
            const result = record(query, await target.all());
            const row = result.results[0] ?? null;
            return column && row ? row[column] : row;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(proxy, { raw, query });
    return proxy;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (query: string) => wrap(target.prepare(query), query);
      if (key === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          const inputs = batch.map((statement) => {
            const input = statements.get(statement);
            if (!input) throw new Error('Unmetered D1 statement');
            return input;
          });
          const results = await target.batch(inputs.map((item) => item.raw));
          return results.map((result, index) => record(inputs[index].query, result));
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function sumWrites(samples: WriteSample[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const sample of samples) {
    if (!sample.rowsWritten) continue;
    const key = `${sample.owner}:${sample.phase}`;
    totals[key] = (totals[key] ?? 0) + sample.rowsWritten;
  }
  return totals;
}
