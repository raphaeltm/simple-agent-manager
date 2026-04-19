/**
 * Unit tests for TrialCounter DO.
 *
 * Covers:
 *   - Incrementing from 0 up to the cap
 *   - Reaching the cap returns { ok: false, count: <cap> } and does NOT mutate
 *   - cap = 0 disables the limit (any number of increments allowed)
 *   - decrement clamps at 0
 *   - get() returns current state without mutating
 *   - Separate month keys maintain independent counters
 *   - Atomicity: transactionSync passes through sql.exec writes
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Provide a minimal DurableObject base class so the implementation module can
// import from 'cloudflare:workers' in a node test runner.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { TrialCounter } = await import(
  '../../../src/durable-objects/trial-counter'
);

// ---------------------------------------------------------------------------
// In-memory SQL stub
// ---------------------------------------------------------------------------

/**
 * A very small fake of SqlStorage that handles the exact three queries the DO
 * uses: CREATE TABLE IF NOT EXISTS, SELECT ... WHERE month_key = ?, and
 * INSERT ... ON CONFLICT DO UPDATE. The counter state lives in a Map.
 */
function createFakeSql() {
  const rows = new Map<string, number>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = vi.fn((query: string, ...args: any[]) => {
    const q = query.trim().toLowerCase();

    if (q.startsWith('create table')) {
      return { toArray: () => [] };
    }

    if (q.startsWith('select')) {
      const key = args[0] as string;
      const count = rows.get(key);
      return {
        toArray: () => (count !== undefined ? [{ count }] : []),
      };
    }

    if (q.startsWith('insert')) {
      const [key, count] = args as [string, number];
      rows.set(key, count);
      return { toArray: () => [] };
    }

    return { toArray: () => [] };
  });

  return { exec, _rows: rows };
}

function createFakeCtx() {
  const sql = createFakeSql();
  // transactionSync runs the callback synchronously and returns its result.
  const transactionSync = vi.fn(<T>(fn: () => T): T => fn());
  // blockConcurrencyWhile runs the callback immediately (ignoring the promise
  // ordering guarantee since this is a pure in-memory fake).
  const blockConcurrencyWhile = vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
    return fn();
  });
  return {
    storage: {
      sql,
      transactionSync,
    },
    blockConcurrencyWhile,
    _sql: sql,
  };
}

function createDO() {
  const ctx = createFakeCtx();
  const env = {} as unknown as Env;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = new TrialCounter(ctx as any, env);
  return { instance, ctx };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrialCounter DO', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the trial_counter table on construction', async () => {
    const { ctx } = createDO();
    // Allow the blockConcurrencyWhile callback to run.
    await Promise.resolve();
    const execCalls = ctx._sql.exec.mock.calls.map((c: unknown[]) => (c[0] as string));
    expect(
      execCalls.some((q) => /create table if not exists trial_counter/i.test(q))
    ).toBe(true);
  });

  it('increments from 0 up to the cap', async () => {
    const { instance } = createDO();
    const r1 = await instance.increment('2026-04', 3);
    const r2 = await instance.increment('2026-04', 3);
    const r3 = await instance.increment('2026-04', 3);
    expect(r1).toEqual({ ok: true, count: 1 });
    expect(r2).toEqual({ ok: true, count: 2 });
    expect(r3).toEqual({ ok: true, count: 3 });
  });

  it('refuses to exceed the cap and does not mutate the counter', async () => {
    const { instance } = createDO();
    await instance.increment('2026-04', 2);
    await instance.increment('2026-04', 2);

    const blocked = await instance.increment('2026-04', 2);
    expect(blocked).toEqual({ ok: false, count: 2 });

    // Follow-on read must still show 2, not 3.
    const state = await instance.get('2026-04');
    expect(state).toEqual({ monthKey: '2026-04', count: 2 });
  });

  it('disables the cap when cap <= 0', async () => {
    const { instance } = createDO();
    for (let i = 0; i < 10; i++) {
      const r = await instance.increment('2026-04', 0);
      expect(r.ok).toBe(true);
      expect(r.count).toBe(i + 1);
    }
  });

  it('treats negative caps the same as cap=0 (unlimited)', async () => {
    const { instance } = createDO();
    const r = await instance.increment('2026-04', -1);
    expect(r).toEqual({ ok: true, count: 1 });
  });

  it('decrements and clamps at 0', async () => {
    const { instance } = createDO();
    await instance.increment('2026-04', 10);
    await instance.increment('2026-04', 10);

    expect(await instance.decrement('2026-04')).toBe(1);
    expect(await instance.decrement('2026-04')).toBe(0);
    // Clamped at zero — does NOT go negative.
    expect(await instance.decrement('2026-04')).toBe(0);
    expect(await instance.decrement('2026-04')).toBe(0);
  });

  it('decrement on an unknown month key yields 0 (no underflow)', async () => {
    const { instance } = createDO();
    expect(await instance.decrement('2099-12')).toBe(0);
  });

  it('maintains independent counters per month key', async () => {
    const { instance } = createDO();
    await instance.increment('2026-04', 5);
    await instance.increment('2026-04', 5);
    await instance.increment('2026-05', 5);

    expect(await instance.get('2026-04')).toEqual({ monthKey: '2026-04', count: 2 });
    expect(await instance.get('2026-05')).toEqual({ monthKey: '2026-05', count: 1 });
    // Cap on month A does not block month B.
    const bump = await instance.increment('2026-05', 5);
    expect(bump).toEqual({ ok: true, count: 2 });
  });

  it('get() returns 0 for an unseen month without mutating storage', async () => {
    const { instance, ctx } = createDO();
    const state = await instance.get('2099-01');
    expect(state).toEqual({ monthKey: '2099-01', count: 0 });
    // No insert happened for this key.
    expect(ctx._sql._rows.has('2099-01')).toBe(false);
  });

  it('each mutating call runs inside transactionSync', async () => {
    const { instance, ctx } = createDO();
    await instance.increment('2026-04', 10);
    await instance.increment('2026-04', 10);
    await instance.decrement('2026-04');
    // 2 increments + 1 decrement = 3 transactionSync invocations.
    expect(ctx.storage.transactionSync).toHaveBeenCalledTimes(3);
  });

  describe('tryIncrement', () => {
    it('returns { allowed, count } on success', async () => {
      const { instance } = createDO();
      const r = await instance.tryIncrement('2026-04', 3);
      expect(r).toEqual({ allowed: true, count: 1 });
    });

    it('returns { allowed: false, count } when at cap', async () => {
      const { instance } = createDO();
      await instance.tryIncrement('2026-04', 1);
      const blocked = await instance.tryIncrement('2026-04', 1);
      expect(blocked).toEqual({ allowed: false, count: 1 });
    });

    it('shares storage with increment (same underlying counter)', async () => {
      const { instance } = createDO();
      await instance.increment('2026-04', 10);
      const r = await instance.tryIncrement('2026-04', 10);
      expect(r).toEqual({ allowed: true, count: 2 });
    });
  });

  describe('prune', () => {
    it('deletes rows older than keepMonthKey and returns count', async () => {
      // Extend the fake SQL with range predicate support for prune().
      const { instance, ctx } = createDO();
      // Seed several months.
      await instance.increment('2026-01', 10);
      await instance.increment('2026-02', 10);
      await instance.increment('2026-03', 10);
      await instance.increment('2026-04', 10);

      // Patch the fake exec to handle DELETE/COUNT with month_key < ?
      const rows = ctx._sql._rows;
      ctx._sql.exec.mockImplementation((query: string, ...args: unknown[]) => {
        const q = query.trim().toLowerCase();
        if (q.startsWith('select count(*)')) {
          const keep = args[0] as string;
          const c = [...rows.keys()].filter((k) => k < keep).length;
          return { toArray: () => [{ c }] };
        }
        if (q.startsWith('delete from trial_counter where month_key <')) {
          const keep = args[0] as string;
          for (const k of [...rows.keys()]) if (k < keep) rows.delete(k);
          return { toArray: () => [] };
        }
        if (q.startsWith('select count')) {
          // unused — handled above
          return { toArray: () => [] };
        }
        return { toArray: () => [] };
      });

      const deleted = await instance.prune('2026-03');
      expect(deleted).toBe(2);
      expect(rows.has('2026-01')).toBe(false);
      expect(rows.has('2026-02')).toBe(false);
      expect(rows.has('2026-03')).toBe(true);
      expect(rows.has('2026-04')).toBe(true);
    });
  });

  describe('fetch HTTP surface', () => {
    it('GET /state returns current counter', async () => {
      const { instance } = createDO();
      await instance.increment('2026-04', 10);
      const res = await instance.fetch(
        new Request('https://do/state?monthKey=2026-04')
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ monthKey: '2026-04', count: 1 });
    });

    it('GET /state without monthKey returns 400', async () => {
      const { instance } = createDO();
      const res = await instance.fetch(new Request('https://do/state'));
      expect(res.status).toBe(400);
    });

    it('POST /tryIncrement returns { allowed, count }', async () => {
      const { instance } = createDO();
      const res = await instance.fetch(
        new Request('https://do/tryIncrement', {
          method: 'POST',
          body: JSON.stringify({ monthKey: '2026-04', cap: 2 }),
        })
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ allowed: true, count: 1 });
    });

    it('POST /tryIncrement without body returns 400', async () => {
      const { instance } = createDO();
      const res = await instance.fetch(
        new Request('https://do/tryIncrement', {
          method: 'POST',
          body: JSON.stringify({}),
        })
      );
      expect(res.status).toBe(400);
    });

    it('POST /decrement returns { count }', async () => {
      const { instance } = createDO();
      await instance.increment('2026-04', 10);
      await instance.increment('2026-04', 10);
      const res = await instance.fetch(
        new Request('https://do/decrement', {
          method: 'POST',
          body: JSON.stringify({ monthKey: '2026-04' }),
        })
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ count: 1 });
    });

    it('unknown path returns 404', async () => {
      const { instance } = createDO();
      const res = await instance.fetch(new Request('https://do/nope'));
      expect(res.status).toBe(404);
    });
  });
});
