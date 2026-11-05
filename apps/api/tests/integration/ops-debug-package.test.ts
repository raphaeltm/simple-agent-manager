/**
 * Debug package capture → Operations library → retention purge, through the real MCP route,
 * the real Operations gate, the real library upload/encryption, and the real purge query
 * (`.claude/rules/35`). The node agent and R2 are faked at their network/storage boundary.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { exportPKCS8 } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/services/fetch-timeout', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/fetch-timeout')>(
    '../../src/services/fetch-timeout'
  )),
  fetchWithTimeout: boundary.fetch,
}));

import { drizzle } from 'drizzle-orm/d1';

import { platformErrors } from '../../src/db/observability-schema';
import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { downloadFile } from '../../src/services/file-library';
import { purgeExpiredDebugPackages } from '../../src/services/fleet-ops/debug-packages';
import { FLEET_OPS_DEFAULTS } from '../../src/services/fleet-ops/settings-definitions';
import { callMcpTool, createJsonKv, createMcpApp, storeMcpToken } from '../helpers/mcp-route';
import { createAllSchemaTables, createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const OPS_PROJECT = 'proj-ops';
const NODE = 'NODE01DEBUGPKG';
const DAY = 24 * 60 * 60 * 1000;
const ENCRYPTION_KEY = btoa('01234567890123456789012345678901');

let main: Database.Database;
let env: Env;
let r2Objects: Map<string, { data: ArrayBuffer; customMetadata?: Record<string, string> }>;
let app: Awaited<ReturnType<typeof createMcpApp>>;
let packageBytes: Uint8Array;

beforeAll(async () => {
  app = await createMcpApp();
}, 60_000);

function memoryR2(): R2Bucket {
  return {
    put: async (
      key: string,
      value: ArrayBuffer,
      options?: { customMetadata?: Record<string, string> }
    ) => {
      r2Objects.set(key, { data: value, customMetadata: options?.customMetadata });
      return {};
    },
    get: async (key: string) => {
      const object = r2Objects.get(key);
      if (!object) return null;
      return { customMetadata: object.customMetadata, arrayBuffer: async () => object.data };
    },
    // R2's binding accepts one key or an array of keys.
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) r2Objects.delete(key);
    },
  } as unknown as R2Bucket;
}

/** Streams the package in chunks, the way the agent's tar.gz response arrives. */
function packageResponse(bytes: Uint8Array, declareLength: boolean) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 1024) controller.enqueue(bytes.slice(i, i + 1024));
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/gzip',
      ...(declareLength ? { 'Content-Length': String(bytes.length) } : {}),
    },
  });
}

function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  main
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

beforeEach(async () => {
  main = new Database(':memory:');
  createAllSchemaTables(main, schema);
  main.exec(
    readFileSync(
      new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
      'utf8'
    )
  );
  insert('platform_settings', {
    key: 'operations.debuggerTools',
    value: 'read',
    updated_at: '2026-11-03T00:00:00Z',
  });
  insert('users', {
    id: 'admin',
    email: 'a@example.test',
    name: 'a',
    role: 'superadmin',
    status: 'active',
  });
  insert('tasks', {
    id: 'task-admin',
    project_id: OPS_PROJECT,
    user_id: 'admin',
    title: 't',
    status: 'in_progress',
  });
  insert('nodes', { id: NODE, user_id: 'owner', name: 'n', status: 'running', runtime: 'vm' });

  r2Objects = new Map();
  packageBytes = new Uint8Array(5_000).map((_, i) => i % 251);
  boundary.fetch.mockImplementation(async (url: string) =>
    new URL(url).pathname === '/debug-package'
      ? packageResponse(packageBytes, false)
      : new Response('not found', { status: 404 })
  );
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const obs = new Database(':memory:');
  createSchemaTables(obs, [platformErrors]);
  env = {
    DATABASE: createSqliteD1(main),
    OBSERVABILITY_DATABASE: createSqliteD1(obs),
    KV: createJsonKv(),
    R2: memoryR2(),
    ENCRYPTION_KEY,
    BASE_DOMAIN: 'example.test',
    JWT_PRIVATE_KEY: await exportPKCS8(keys.privateKey),
    PLATFORM_FEEDBACK_PROJECT_ID: OPS_PROJECT,
  } as unknown as Env;
  await storeMcpToken(env.KV, 'tok-admin', {
    taskId: 'task-admin',
    projectId: OPS_PROJECT,
    userId: 'admin',
    workspaceId: 'ws-a',
  });
});

afterEach(() => {
  main.close();
  vi.clearAllMocks();
});

async function capture() {
  const response = await callMcpTool(app, env, 'tok-admin', 'ops_capture_debug_package', {
    nodeId: NODE,
  });
  expect(response.error).toBeUndefined();
  return JSON.parse(response.result?.content[0]?.text ?? '{}');
}

describe('ops_capture_debug_package', () => {
  it('stores the package in the Operations library, readable byte-for-byte, then the purge deletes it after retention', async () => {
    const body = await capture();

    expect(body.status).toBe('ok');
    expect(body.directory).toBe(`/debug-packages/${NODE}/`);
    expect(body.filename).toMatch(/\.tar\.gz$/);
    expect(body.sizeBytes).toBe(packageBytes.length);

    const db = drizzle(env.DATABASE, { schema });
    const stored = await downloadFile(db, env.R2, ENCRYPTION_KEY, OPS_PROJECT, body.fileId);
    expect(new Uint8Array(stored.data)).toEqual(packageBytes);
    expect(stored.file.directory).toBe(`/debug-packages/${NODE}/`);
    // Stored encrypted: the R2 object is not the plaintext.
    const [object] = [...r2Objects.values()];
    expect(new Uint8Array(object!.data)).not.toEqual(packageBytes);

    // A library file outside /debug-packages/ is never purged; one inside a young window stays.
    insert('project_files', {
      id: 'keep-me',
      project_id: OPS_PROJECT,
      filename: 'notes.md',
      mime_type: 'text/markdown',
      size_bytes: 1,
      uploaded_by: 'admin',
      upload_source: 'user',
      status: 'ready',
      r2_key: 'k',
      directory: '/engineering',
      created_at: new Date(Date.now() - 30 * DAY).toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Attack control: an expired debug-package-shaped file in another project is never touched.
    insert('project_files', {
      id: 'other-project-package',
      project_id: 'proj-other',
      filename: 'old.tar.gz',
      mime_type: 'application/gzip',
      size_bytes: 1,
      uploaded_by: 'admin',
      upload_source: 'agent',
      status: 'ready',
      r2_key: 'other-project-key',
      directory: `/debug-packages/${NODE}/`,
      created_at: new Date(Date.now() - 30 * DAY).toISOString(),
      updated_at: new Date().toISOString(),
    });
    r2Objects.set('other-project-key', { data: new ArrayBuffer(1) });

    const early = await purgeExpiredDebugPackages(env, FLEET_OPS_DEFAULTS, Date.now() + DAY);
    expect(early.deleted).toBe(0);

    const later = await purgeExpiredDebugPackages(
      env,
      FLEET_OPS_DEFAULTS,
      Date.now() + (FLEET_OPS_DEFAULTS.debugPackageRetentionDays + 1) * DAY
    );
    expect(later.deleted).toBe(1);
    expect([...r2Objects.keys()]).toEqual(['other-project-key']);
    const remaining = main.prepare('SELECT id FROM project_files ORDER BY id').all();
    expect(remaining).toEqual([{ id: 'keep-me' }, { id: 'other-project-package' }]);

    const audit = main
      .prepare(
        `SELECT outcome, detail FROM operations_audit_log WHERE tool = 'ops_capture_debug_package'`
      )
      .all() as Array<{ outcome: string; detail: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.outcome).toBe('succeeded');
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({
      fileId: body.fileId,
      sizeBytes: packageBytes.length,
    });
  });

  it('stops reading and stores nothing when the stream crosses the byte cap', async () => {
    insert('platform_settings', {
      key: 'operations.debugPackageMaxBytes',
      value: String(1024 * 1024),
      updated_at: '2026-11-03T00:00:00Z',
    });
    packageBytes = new Uint8Array(1024 * 1024 + 1);

    const body = await capture();

    expect(body.status).toBe('too_large');
    expect(body.capBytes).toBe(1024 * 1024);
    expect(r2Objects.size).toBe(0);
    expect(main.prepare('SELECT COUNT(*) AS n FROM project_files').get()).toEqual({ n: 0 });
  });

  it('refuses up front when the agent declares a size over the cap', async () => {
    insert('platform_settings', {
      key: 'operations.debugPackageMaxBytes',
      value: String(1024 * 1024),
      updated_at: '2026-11-03T00:00:00Z',
    });
    boundary.fetch.mockImplementation(async () =>
      packageResponse(new Uint8Array(2 * 1024 * 1024), true)
    );

    const body = await capture();

    expect(body).toMatchObject({ status: 'too_large', declaredBytes: 2 * 1024 * 1024 });
    expect(r2Objects.size).toBe(0);
  });

  it('reports a node that is not running without calling it', async () => {
    main.prepare(`UPDATE nodes SET status = 'stopped' WHERE id = ?`).run(NODE);

    const body = await capture();

    expect(body).toMatchObject({ status: 'not_running', nodeStatus: 'stopped' });
    expect(boundary.fetch).not.toHaveBeenCalled();
  });

  it('rate-limits captures per superadmin, refusing before the node is called', async () => {
    insert('platform_settings', {
      key: 'operations.debugPackageCapturesPerHour',
      value: '1',
      updated_at: '2026-11-03T00:00:00Z',
    });

    expect((await capture()).status).toBe('ok');
    boundary.fetch.mockClear();
    const second = await callMcpTool(app, env, 'tok-admin', 'ops_capture_debug_package', {
      nodeId: NODE,
    });

    expect(second.error?.message).toContain('operations.debugPackageCapturesPerHour');
    expect(boundary.fetch).not.toHaveBeenCalled();
    expect(main.prepare('SELECT COUNT(*) AS n FROM project_files').get()).toEqual({ n: 1 });
  });
});

describe('debug package reads and retention', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const old = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
  const libraryFile = (id: string, extra: Record<string, unknown>) =>
    insert('project_files', {
      id,
      project_id: OPS_PROJECT,
      filename: `${id}.tar.gz`,
      mime_type: 'application/gzip',
      size_bytes: 1,
      uploaded_by: 'admin',
      upload_source: 'agent',
      status: 'ready',
      r2_key: `key-${id}`,
      directory: `/debug-packages/${NODE}/`,
      created_at: old(30),
      updated_at: old(30),
      ...extra,
    });
  const remainingIds = () =>
    (main.prepare('SELECT id FROM project_files ORDER BY id').all() as Array<{ id: string }>).map(
      (r) => r.id
    );

  it('lists and displays a package only to a token that passes the Operations read gate', async () => {
    insert('users', {
      id: 'member',
      email: 'm@example.test',
      name: 'm',
      role: 'user',
      status: 'active',
    });
    insert('tasks', {
      id: 'task-member',
      project_id: OPS_PROJECT,
      user_id: 'member',
      title: 't',
      status: 'in_progress',
    });
    await storeMcpToken(env.KV, 'tok-member', {
      taskId: 'task-member',
      projectId: OPS_PROJECT,
      userId: 'member',
      workspaceId: 'ws-m',
    });
    const body = await capture();
    libraryFile('notes', { directory: '/engineering/', upload_source: 'user' });

    const listed = async (token: string) => {
      const res = await callMcpTool(app, env, token, 'list_library_files', { recursive: true });
      expect(res.error, JSON.stringify(res.error)).toBeUndefined();
      return (JSON.parse(res.result?.content[0]?.text ?? '{}').files as Array<{ id: string }>).map(
        (f) => f.id
      );
    };
    const displayed = async (token: string) =>
      JSON.parse(
        (await callMcpTool(app, env, token, 'display_from_library', { fileId: body.fileId })).result
          ?.content[0]?.text ?? '{}'
      );

    // A superadmin's Operations task sees the package; a plain project member does not.
    expect(await listed('tok-admin')).toEqual(expect.arrayContaining([body.fileId, 'notes']));
    expect(await listed('tok-member')).toEqual(['notes']);
    expect((await displayed('tok-admin')).fileId).toBe(body.fileId);
    expect((await displayed('tok-member')).error).toBe('FILE_NOT_FOUND');
  });

  it('purges only captured packages, including those left in a former Operations project', async () => {
    // A package captured while another project was the Operations project (audit row records it).
    libraryFile('former-pkg', { project_id: 'proj-former', r2_key: 'key-former' });
    insert('operations_audit_log', {
      id: 'audit-former',
      actor_user_id: 'admin',
      task_id: 'task-old',
      tool: 'ops_capture_debug_package',
      target_type: 'node',
      target_id: NODE,
      outcome: 'succeeded',
      detail: JSON.stringify({ fileId: 'former-pkg' }),
      created_at: old(30),
    });
    // Fallback: an agent-uploaded package in the current Operations project with no audit row.
    libraryFile('unaudited-pkg', {});
    // Never purged: a person's own upload into the same directory.
    libraryFile('user-upload', { upload_source: 'user' });
    for (const key of ['key-former', 'key-unaudited-pkg', 'key-user-upload']) {
      r2Objects.set(key, { data: new ArrayBuffer(1) });
    }

    const result = await purgeExpiredDebugPackages(env, FLEET_OPS_DEFAULTS);

    expect(result.deleted).toBe(2);
    expect(remainingIds()).toEqual(['user-upload']);
    expect([...r2Objects.keys()]).toEqual(['key-user-upload']);
  });

  it('clears more expired packages than one batch in a single run (rule 81)', async () => {
    const count = FLEET_OPS_DEFAULTS.debugPackagePurgeBatchSize * 2 + 30;
    for (let i = 0; i < count; i++) {
      libraryFile(`bulk-${String(i).padStart(4, '0')}`, {});
    }

    const result = await purgeExpiredDebugPackages(env, FLEET_OPS_DEFAULTS);

    expect(result).toMatchObject({ deleted: count, failed: 0, batches: 3, complete: true });
    expect(remainingIds()).toEqual([]);
  });

  it('stops at its deadline and says the backlog is not finished', async () => {
    for (let i = 0; i < FLEET_OPS_DEFAULTS.debugPackagePurgeBatchSize + 5; i++) {
      libraryFile(`late-${String(i).padStart(4, '0')}`, {});
    }
    // A clock that passes the deadline once the first batch has run.
    let tick = 0;
    const clock = () => (tick++ < 2 ? 0 : FLEET_OPS_DEFAULTS.debugPackagePurgeDeadlineMs + 1);

    const result = await purgeExpiredDebugPackages(env, FLEET_OPS_DEFAULTS, Date.now(), clock);

    expect(result).toMatchObject({
      deleted: FLEET_OPS_DEFAULTS.debugPackagePurgeBatchSize,
      batches: 1,
      complete: false,
    });
    expect(remainingIds()).toHaveLength(5);
  });

  it('keeps the rows when the R2 delete fails, so the next run retries', async () => {
    libraryFile('unaudited-pkg', {});
    env = {
      ...env,
      R2: {
        ...memoryR2(),
        delete: async () => {
          throw new Error('R2 unavailable');
        },
      } as unknown as R2Bucket,
    } as Env;

    const result = await purgeExpiredDebugPackages(env, FLEET_OPS_DEFAULTS);

    expect(result).toMatchObject({ deleted: 0, failed: 1 });
    expect(remainingIds()).toEqual(['unaudited-pkg']);
  });
});
