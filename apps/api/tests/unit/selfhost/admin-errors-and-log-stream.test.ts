/**
 * Admin → Errors, Logs and Stream on a self-hosted box (no Cloudflare account, no tail worker).
 *
 * Errors: an unexpected 500 goes through the real global error handler, which persists it to the
 * real observability migration chain; the real admin errors route then lists it. Nothing in
 * that path needs Cloudflare, which the inventory had only inferred (#19).
 * Stream: the box declares LOG_TAIL_AVAILABLE=false; the route refuses with FEATURE_UNAVAILABLE
 * instead of opening a socket nothing feeds, and the public capabilities tell the web app.
 */
import { readdirSync, readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { adminObservabilityRoutes } from '../../../src/routes/admin/observability';
import {
  publicPlatformCapabilities,
  resolvePlatformCapabilities,
} from '../../../src/services/platform-capabilities';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => 'admin-1',
}));

const MIGRATIONS = new URL('../../../src/db/migrations/observability/', import.meta.url);

let mainDb: Database.Database;
let obsDb: Database.Database;
let env: Env;
let pending: Promise<unknown>[];

beforeEach(() => {
  mainDb = new Database(':memory:');
  createAllSchemaTables(mainDb, schema);
  mainDb.exec(
    'CREATE TABLE IF NOT EXISTS diagnostic_incidents (id TEXT PRIMARY KEY, platform_error_id TEXT, node_id TEXT, workspace_id TEXT, status TEXT, occurrence_count INTEGER, last_seen_at INTEGER, artifact_count INTEGER, total_bytes INTEGER, manifest_json TEXT, preview_json TEXT, failure_reason TEXT, expires_at INTEGER, created_at INTEGER, updated_at INTEGER)'
  );
  obsDb = new Database(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    obsDb.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  env = {
    DATABASE: createSqliteD1(mainDb),
    OBSERVABILITY_DATABASE: createSqliteD1(obsDb),
    KV: createMemoryKv(),
    // The box: celld-config.ts sets this; there is no CF account.
    LOG_TAIL_AVAILABLE: 'false',
  } as unknown as Env;
  pending = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  mainDb.close();
  obsDb.close();
});

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.onError(handleAppError);
  a.get('/api/boom', () => {
    throw new Error('box exploded while listing projects');
  });
  a.route('/api/admin/observability', adminObservabilityRoutes);
  return a;
}

async function call(path: string, init: RequestInit = {}) {
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  const res = await app().request(path, init, env, ctx);
  await Promise.all(pending.splice(0));
  return res;
}

describe('Admin → Errors on a self-hosted box', () => {
  it('lists an API error the box recorded itself, with no Cloudflare service involved', async () => {
    const boom = await call('/api/boom');
    expect(boom.status).toBe(500);

    const res = await call('/api/admin/observability/errors?source=api');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      errors: Array<{ source: string; message: string; incident: unknown }>;
    };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({ source: 'api', incident: null });
    expect(body.errors[0]!.message).toContain('box exploded');

    const health = await call('/api/admin/observability/health');
    expect(health.status).toBe(200);
  });
});

describe('Admin → Stream and Logs on a self-hosted box', () => {
  it('refuses the stream upgrade with FEATURE_UNAVAILABLE liveLogStream', async () => {
    const res = await call('/api/admin/observability/logs/stream', {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: 'FEATURE_UNAVAILABLE',
      details: { feature: 'liveLogStream' },
    });
  });

  it('tells the web app that log search and the live stream are off', () => {
    expect(publicPlatformCapabilities(env)).toMatchObject({
      logSearch: false,
      liveLogStream: false,
    });
  });

  it('keeps both on for a Cloudflare deployment (switch unset, account present)', () => {
    const cloudflare = {
      ...env,
      LOG_TAIL_AVAILABLE: undefined,
      CF_ACCOUNT_ID: 'acct',
      CF_API_TOKEN: 'tok',
    } as unknown as Env;
    expect(resolvePlatformCapabilities(cloudflare).liveLogStream).toBe(true);
    expect(publicPlatformCapabilities(cloudflare)).toMatchObject({
      logSearch: true,
      liveLogStream: true,
    });
  });
});
