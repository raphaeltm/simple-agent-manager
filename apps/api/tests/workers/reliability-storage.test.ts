import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, inject, it } from 'vitest';

import type { McpRateCounter } from '../../src/durable-objects/mcp-rate-counter';
import type { WorkspaceBootLog } from '../../src/durable-objects/workspace-boot-log';
import type { Env } from '../../src/env';
import { mcpRoutes } from '../../src/routes/mcp';
import { checkMcpRateLimit } from '../../src/routes/mcp/_helpers';
import { appendBootLog, getBootLogs, writeBootLogs } from '../../src/services/boot-log';
import { generateMcpToken, storeMcpToken } from '../../src/services/mcp-token';
import { RELIABILITY_STORAGE_ACTIVATION_KEY } from '../../src/services/reliability-storage';
const api = env as unknown as Env;
async function publish(rateCutoverAt = 60, bootLogCutoverAt = 60) {
  await api.DATABASE.prepare('INSERT INTO platform_settings(key, value) VALUES (?, ?)')
    .bind(
      RELIABILITY_STORAGE_ACTIVATION_KEY,
      JSON.stringify({ publishedAt: 0, rateCutoverAt, bootLogCutoverAt, windowSeconds: 60 })
    )
    .run();
}
beforeEach(async (context) => {
  // This Worker test environment persists D1 across cases. Reset only the test
  // fixture, then restore the exact production guards before every assertion.
  const migration = JSON.parse(inject<string>('D1_MIGRATIONS_JSON')) as {
    name: string;
    queries: string[];
  }[];
  const activationMigration = migration.find((item) =>
    item.name.includes('0196_reliability_storage_activation')
  )!;
  await api.DATABASE.batch([
    ...['no_update', 'no_delete', 'no_replace'].map((suffix) =>
      api.DATABASE.prepare(`DROP TRIGGER IF EXISTS reliability_activation_${suffix}`)
    ),
    api.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?').bind(
      RELIABILITY_STORAGE_ACTIVATION_KEY
    ),
    ...activationMigration.queries.map((sql) => api.DATABASE.prepare(sql)),
  ]);
  const name = context.task.name;
  if (
    [
      'held-body',
      'held legacy',
      'preactivation clear',
      'cutover-straddling',
      'immutable activation',
    ].some((part) => name.includes(part))
  )
    return;
  return publish();
});
const entry = {
  step: 'clone',
  status: 'started' as const,
  message: 'Cloning',
  timestamp: '2026-10-15T00:00:00Z',
};
function activated(): Env {
  return { ...api };
}

describe('Reliability C real SQLite storage', () => {
  it.each(['task', 'agentSession', 'workspace'] as const)(
    'preserves activated HTTP auth, %s identity and 429 headers',
    async (identityKind) => {
      const identity = crypto.randomUUID();
      const token = generateMcpToken();
      const config = { ...activated(), MCP_RATE_LIMIT: '1' };
      await storeMcpToken(api.KV, token, {
        taskId: identityKind === 'task' ? identity : '',
        agentSessionId: identityKind === 'agentSession' ? identity : undefined,
        workspaceId: identityKind === 'workspace' ? identity : crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      });
      const app = new Hono<{ Bindings: Env }>();
      app.route('/mcp', mcpRoutes);
      const request = (bearer: string) =>
        app.request(
          '/mcp',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
          },
          config
        );
      expect((await request('invalid')).status).toBe(401);
      const allowed = await request(token);
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('X-RateLimit-Limit')).toBe('1');
      expect(allowed.headers.get('X-RateLimit-Remaining')).toBe('0');
      const denied = await request(token);
      expect(denied.status).toBe(429);
      expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(denied.headers.get('X-RateLimit-Reset')).toBe(
        allowed.headers.get('X-RateLimit-Reset')
      );
      const ns = api.MCP_RATE_COUNTER!;
      await runInDurableObject(
        ns.get(ns.idFromName(identity)) as DurableObjectStub<McpRateCounter>,
        async (_instance, state) => {
          expect(state.storage.sql.exec('SELECT count FROM counters').toArray()).toEqual([
            { count: 1 },
          ]);
        }
      );
    }
  );

  it('admits exactly the limit under concurrent requests, persists across reconstructed instances', async () => {
    const identity = crypto.randomUUID();
    const config = { ...activated(), MCP_RATE_LIMIT: '7' };
    const results = await Promise.all(
      Array.from({ length: 30 }, () => checkMcpRateLimit(api.KV, identity, config))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(7);
    const stub = api.MCP_RATE_COUNTER!.get(
      api.MCP_RATE_COUNTER!.idFromName(identity)
    ) as DurableObjectStub<McpRateCounter>;
    await runInDurableObject(stub, async (instance, state) => {
      expect(state.storage.sql.exec('SELECT count FROM counters').toArray()).toEqual([
        { count: 7 },
      ]);
      // Reconstruct the production class over the same durable SQLite storage.
      const fresh = new (instance.constructor as typeof McpRateCounter)(state, config);
      const now = Math.floor(Date.now() / 1000);
      const start = Math.floor(now / 60) * 60;
      expect((await fresh.consume(start, start + 60, 7)).allowed).toBe(false);
    });
    expect(
      await api.KV.get(`ratelimit:mcp:${identity}:${Math.floor(Date.now() / 60000) * 60}`)
    ).toBeNull();
  });

  it('uses the same owner for all requests in a cutover-straddling window', async () => {
    const identity = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const start = Math.floor(now / 60) * 60;
    await publish(start + 60);
    const config = { ...api, MCP_RATE_LIMIT: '1', MCP_RATE_COUNTER_CUTOVER_AT: String(start + 1) };
    expect((await checkMcpRateLimit(api.KV, identity, config)).allowed).toBe(true);
    expect((await checkMcpRateLimit(api.KV, identity, config)).allowed).toBe(false);
    expect(await api.KV.get(`ratelimit:mcp:${identity}:${start}`, 'json')).toMatchObject({
      count: 2,
    });
  });

  it('mixed activated bridge versions and rollback preserve consumed quota', async () => {
    const identity = crypto.randomUUID();
    const rollout = { ...activated(), MCP_RATE_LIMIT: '1' };
    const rollback = { ...rollout };
    expect((await checkMcpRateLimit(api.KV, identity, rollout)).allowed).toBe(true);
    expect((await checkMcpRateLimit(api.KV, identity, rollback)).allowed).toBe(false);
  });

  it('prunes expired counter windows while keeping live quota', async () => {
    const ns = api.MCP_RATE_COUNTER!;
    const stub = ns.get(ns.idFromName(crypto.randomUUID())) as DurableObjectStub<McpRateCounter>;
    const now = Math.floor(Date.now() / 1000);
    await stub.consume(now, now + 60, 2);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec('INSERT INTO counters VALUES (?, ?, ?)', now - 60, now - 1, 99);
      await instance.alarm();
      expect(state.storage.sql.exec('SELECT count FROM counters').toArray()).toEqual([
        { count: 1 },
      ]);
    });
  });

  it('merges existing KV, serializes append bursts, deduplicates retries and caps retained entries', async () => {
    const workspace = crypto.randomUUID();
    await api.KV.put(`bootlog:${workspace}`, JSON.stringify([entry]));
    const config = { ...activated(), BOOT_LOG_MAX_ENTRIES: '4' };
    expect(await getBootLogs(api.KV, workspace, config)).toEqual([entry]);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        appendBootLog(api.KV, workspace, { ...entry, message: `entry-${i}` }, config)
      )
    );
    const logs = await getBootLogs(api.KV, workspace, config);
    expect(logs).toHaveLength(4);
    await Promise.all([
      appendBootLog(api.KV, workspace, logs[3]!, config),
      appendBootLog(api.KV, workspace, logs[3]!, config),
    ]);
    expect(await getBootLogs(api.KV, workspace, config)).toEqual(logs);
    expect(await api.KV.get(`bootlog:${workspace}`, 'json')).toEqual([entry]);
  });

  it('observes late legacy propagation after the first durable append without replacing new entries', async () => {
    const workspace = crypto.randomUUID();
    const config = activated();
    await appendBootLog(api.KV, workspace, { ...entry, message: 'new durable entry' }, config);
    // Models a pre-cutover write becoming visible only after first DO append.
    await api.KV.put(`bootlog:${workspace}`, JSON.stringify([entry]));
    expect(await getBootLogs(api.KV, workspace, config)).toEqual([
      entry,
      { ...entry, message: 'new durable entry' },
    ]);
    await writeBootLogs(api.KV, workspace, [], config);
    expect(await getBootLogs(api.KV, workspace, config)).toEqual([]);
  });

  it('keeps native append order when a legacy entry is retried after cutover', async () => {
    const workspace = crypto.randomUUID();
    const config = { ...activated(), BOOT_LOG_MAX_ENTRIES: '2' };
    const a = { ...entry, message: 'A' };
    const b = { ...entry, message: 'B' };
    const c = { ...entry, message: 'C' };
    await api.KV.put(`bootlog:${workspace}`, JSON.stringify([a, b]));
    await appendBootLog(api.KV, workspace, c, config);
    await appendBootLog(api.KV, workspace, a, config);
    expect(await getBootLogs(api.KV, workspace, config)).toEqual([c, a]);
  });

  it('clear before import and restart never resurrect stale KV logs', async () => {
    const workspace = crypto.randomUUID();
    await api.KV.put(`bootlog:${workspace}`, JSON.stringify([entry]));
    const config = activated();
    await writeBootLogs(api.KV, workspace, [], config);
    const ns = api.WORKSPACE_BOOT_LOG!;
    const stub = ns.get(ns.idFromName(workspace)) as DurableObjectStub<WorkspaceBootLog>;
    await runInDurableObject(stub, async (instance, state) => {
      const fresh = new (instance.constructor as typeof WorkspaceBootLog)(state, config);
      expect(await fresh.read(workspace, 50)).toEqual([]);
    });
    expect(await getBootLogs(api.KV, workspace, config)).toEqual([]);
  });

  it('expires logs using server receipt time, keeps bounded legacy tombstone', async () => {
    const workspace = crypto.randomUUID();
    const config = activated();
    await appendBootLog(api.KV, workspace, entry, config);
    const ns = api.WORKSPACE_BOOT_LOG!;
    const stub = ns.get(ns.idFromName(workspace)) as DurableObjectStub<WorkspaceBootLog>;
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec('UPDATE log_state SET expires_at = 0');
      await instance.alarm();
      expect(state.storage.sql.exec('SELECT * FROM entries').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT * FROM log_state').toArray()).toHaveLength(1);
    });
    expect(await getBootLogs(api.KV, workspace, config)).toEqual([]);
  });
  it('a held-body env-unset bridge request resumes into the shared DO owner', async () => {
    await api.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?')
      .bind(RELIABILITY_STORAGE_ACTIVATION_KEY)
      .run();
    const identity = crypto.randomUUID();
    const token = generateMcpToken();
    await storeMcpToken(api.KV, token, {
      taskId: identity,
      workspaceId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    const app = new Hono<{ Bindings: Env }>();
    app.route('/mcp', mcpRoutes);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let bodyRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      bodyRead = resolve;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        pull() {
          bodyRead();
        },
      },
      { highWaterMark: 0 }
    );
    const config = { ...api, MCP_RATE_LIMIT: '1' }; // Original bridge env has no activation timestamps.
    const held = app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body,
      },
      config
    );
    // Request body cannot complete until this test releases it. A new version
    // publishes activation and consumes the quota while the old request waits.
    await reading; // Auth completed and the real route is waiting in req.json().
    await publish();
    expect(
      (await checkMcpRateLimit(api.KV, identity, { ...activated(), MCP_RATE_LIMIT: '1' })).allowed
    ).toBe(true);
    controller.enqueue(
      new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    );
    controller.close();
    expect((await held).status).toBe(429);
    expect(
      await api.KV.get(`ratelimit:mcp:${identity}:${Math.floor(Date.now() / 60000) * 60}`)
    ).toBeNull();
  });

  it('serializes a held legacy KV append before activated clear and fences late visibility', async () => {
    await api.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?')
      .bind(RELIABILITY_STORAGE_ACTIVATION_KEY)
      .run();
    const workspace = crypto.randomUUID();
    const ns = api.WORKSPACE_BOOT_LOG!;
    const stub = ns.get(ns.idFromName(workspace)) as DurableObjectStub<WorkspaceBootLog>;
    await runInDurableObject(stub, async (instance, state) => {
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fresh = new (instance.constructor as typeof WorkspaceBootLog)(state, {
        ...api,
        KV: {
          ...api.KV,
          get: api.KV.get.bind(api.KV),
          put: async (...args: Parameters<KVNamespace['put']>) => {
            entered();
            await held;
            return api.KV.put(...args);
          },
        } as KVNamespace,
      });
      const append = fresh.appendBridge(workspace, entry, 1800, 50);
      await started;
      await publish();
      const clear = fresh.replaceBridge(workspace, [], 1800, 50);
      release();
      await Promise.all([append, clear]);
      await api.KV.put(`bootlog:${workspace}`, JSON.stringify([entry]));
      expect(await fresh.readBridge(workspace, 50)).toEqual([]);
    });
  });
  it('keeps a preactivation clear and later append across stale KV visibility, activation and restart', async () => {
    await api.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?')
      .bind(RELIABILITY_STORAGE_ACTIVATION_KEY)
      .run();
    const workspace = crypto.randomUUID();
    await api.KV.put(`bootlog:${workspace}`, JSON.stringify([entry]));
    await writeBootLogs(api.KV, workspace, [], api);
    // An edge still observes the preclear tail while another bridge append arrives.
    await api.KV.put(`bootlog:${workspace}`, JSON.stringify([entry]));
    const later = { ...entry, message: 'valid after clear' };
    await appendBootLog(api.KV, workspace, later, api);
    await publish();
    await api.KV.put(`bootlog:${workspace}`, JSON.stringify([entry]));
    const ns = api.WORKSPACE_BOOT_LOG!;
    await runInDurableObject(
      ns.get(ns.idFromName(workspace)) as DurableObjectStub<WorkspaceBootLog>,
      async (instance, state) => {
        const fresh = new (instance.constructor as typeof WorkspaceBootLog)(state, api);
        expect(await fresh.readBridge(workspace, 50)).toEqual([later]);
      }
    );
    expect(await getBootLogs(api.KV, workspace, api)).toEqual([later]);
  });

  it('enforces immutable activation against updates, deletes, conflicting inserts and replacements', async () => {
    await publish();
    for (const sql of [
      'UPDATE platform_settings SET value = ? WHERE key = ?',
      'INSERT OR REPLACE INTO platform_settings(value, key) VALUES (?, ?)',
      'INSERT OR IGNORE INTO platform_settings(value, key) VALUES (?, ?)',
      'INSERT INTO platform_settings(value, key) VALUES (?, ?)',
    ]) {
      await expect(
        api.DATABASE.prepare(sql).bind('{}', RELIABILITY_STORAGE_ACTIVATION_KEY).run()
      ).rejects.toThrow('immutable');
    }
    await expect(
      api.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?')
        .bind(RELIABILITY_STORAGE_ACTIVATION_KEY)
        .run()
    ).rejects.toThrow('immutable');
    await expect(
      api.DATABASE.prepare('UPDATE platform_settings SET key = ? WHERE key = ?')
        .bind('renamed.activation', RELIABILITY_STORAGE_ACTIVATION_KEY)
        .run()
    ).rejects.toThrow('immutable');
    const original = await api.DATABASE.prepare('SELECT value FROM platform_settings WHERE key = ?')
      .bind(RELIABILITY_STORAGE_ACTIVATION_KEY)
      .first<{ value: string }>();
    await expect(
      api.DATABASE.prepare('INSERT INTO platform_settings(key, value) VALUES (?, ?)')
        .bind(RELIABILITY_STORAGE_ACTIVATION_KEY, original!.value)
        .run()
    ).rejects.toThrow('immutable');
    // Supported publication replay selects no row and verifies the stored value,
    // instead of attempting to overwrite even an identical immutable record.
    const replay = await api.DATABASE.prepare(
      'INSERT INTO platform_settings(key, value) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = ?1)'
    )
      .bind(RELIABILITY_STORAGE_ACTIVATION_KEY, original!.value)
      .run();
    expect(replay.meta.changes).toBe(0);
    expect(
      await api.DATABASE.prepare('SELECT value FROM platform_settings WHERE key = ?')
        .bind(RELIABILITY_STORAGE_ACTIVATION_KEY)
        .first()
    ).toEqual(original);
    const ordinaryKey = crypto.randomUUID();
    await api.DATABASE.prepare('INSERT INTO platform_settings(key, value) VALUES (?, ?)')
      .bind(ordinaryKey, '{}')
      .run();
    await expect(
      api.DATABASE.prepare('UPDATE platform_settings SET key = ? WHERE key = ?')
        .bind(RELIABILITY_STORAGE_ACTIVATION_KEY, ordinaryKey)
        .run()
    ).rejects.toThrow('immutable');
    expect(
      (
        await api.DATABASE.prepare('SELECT value FROM platform_settings WHERE key = ?')
          .bind(RELIABILITY_STORAGE_ACTIVATION_KEY)
          .first<{ value: string }>()
      )?.value
    ).toContain('rateCutoverAt');
  });
});
